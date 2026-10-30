import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import pg from 'pg'
import { validateHttpContracts } from './contracts.js'

const baseURL = 'http://127.0.0.1:18002'
const authHeaders = { Origin: baseURL, 'Content-Type': 'application/json' }
async function until(check: () => Promise<boolean>, message: string) {
	for (let i = 0; i < 80; i++) {
		if (await check()) return
		await new Promise((r) => setTimeout(r, 50))
	}
	throw new Error(message)
}
async function stop(server: ChildProcess) {
	if (server.exitCode !== null) return
	server.kill('SIGTERM')
	await once(server, 'exit')
}
async function fixture() {
	const name = `silverbox_${randomUUID().replaceAll('-', '')}`
	const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
	await admin.connect()
	await admin.query(`CREATE DATABASE "${name}"`)
	const url = new URL(process.env.DATABASE_URL!)
	url.pathname = `/${name}`
	const root = await mkdtemp(join(tmpdir(), 'silverbox-hardening-'))
	const environment = {
		...process.env,
		DATABASE_URL: url.toString(),
		STORAGE_ROOT: root,
		BETTER_AUTH_URL: baseURL,
		PORT: '18002',
		BETTER_AUTH_SECRET: 'test-secret-with-at-least-32-characters',
		GOOGLE_CLIENT_ID: '',
		GOOGLE_CLIENT_SECRET: '',
	}
	const migration = spawnSync(
		process.execPath,
		['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
		{ env: environment, encoding: 'utf8' },
	)
	assert.equal(migration.status, 0, migration.stderr)
	let server: ChildProcess | undefined
	return {
		environment,
		root,
		name,
		async start(config: Record<string, string> = {}) {
			if (server) await stop(server)
			server = spawn(process.execPath, ['dist/server.js'], {
				env: { ...environment, ...config },
				stdio: ['ignore', 'pipe', 'pipe'],
			})
			let logs = ''
			server.stdout?.on('data', (data) => {
				logs += data.toString()
			})
			server.stderr?.on('data', (data) => {
				logs += data.toString()
			})
			await until(async () => {
				if (server!.exitCode !== null) throw new Error(logs)
				try {
					return (await fetch(`${baseURL}/health/ready`)).ok
				} catch {
					return false
				}
			}, 'API startup timed out')
			await validateHttpContracts(baseURL)
			return server
		},
		async close() {
			if (server) await stop(server)
			await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)
			await admin.end()
			await rm(root, { recursive: true, force: true })
		},
	}
}
async function signup() {
	const response = await fetch(`${baseURL}/auth/register`, {
		method: 'POST',
		headers: authHeaders,
		body: JSON.stringify({
			name: 'Storage test',
			email: `${randomUUID()}@example.com`,
			password: 'correct-horse-battery-staple',
		}),
	})
	assert.equal(response.status, 200)
	return response.headers.get('set-cookie')!.split(';')[0]!
}
async function upload(cookie: string, bytes = '1234') {
	return fetch(`${baseURL}/files`, {
		method: 'POST',
		headers: {
			Origin: baseURL,
			Cookie: cookie,
			'Content-Type': 'application/octet-stream',
			'X-File-Name': 'test.bin',
			'X-File-Size': String(bytes.length),
		},
		body: bytes,
	})
}
async function usage(cookie: string) {
	return (await (
		await fetch(`${baseURL}/storage/usage`, { headers: { Cookie: cookie } })
	).json()) as { reservedBytes: string }
}
function hold(cookie: string) {
	const request = http.request(`${baseURL}/files`, {
		method: 'POST',
		headers: {
			Origin: baseURL,
			Cookie: cookie,
			'Content-Type': 'application/octet-stream',
			'X-File-Name': 'slow.bin',
			'X-File-Size': '4',
			'Content-Length': '4',
		},
	})
	request.on('error', () => {})
	request.write('1')
	return request
}

test('global quota is shared across users and releases only after permanent deletion', async () => {
	const context = await fixture()
	try {
		await context.start({ STORAGE_MAX_BYTES: '6' })
		assert.equal((await fetch(`${baseURL}/auth/google`, { redirect: 'manual' })).status, 400)
		const cookies = await Promise.all([signup(), signup()])
		const responses = await Promise.all(cookies.map((cookie) => upload(cookie)))
		assert.deepEqual(responses.map((r) => r.status).sort(), [201, 507])
		const winner = responses.findIndex((r) => r.status === 201)
		const file = (await responses[winner]!.json()).file
		assert.equal((await upload(cookies[winner]!)).status, 507)
		await fetch(`${baseURL}/files/${file.id}`, {
			method: 'DELETE',
			headers: { Cookie: cookies[winner]! },
		})
		assert.equal((await upload(cookies[1 - winner]!)).status, 507)
		assert.equal(
			(
				await fetch(`${baseURL}/files/${file.id}/permanent`, {
					method: 'DELETE',
					headers: { Cookie: cookies[winner]! },
				})
			).status,
			204,
		)
		assert.equal((await upload(cookies[1 - winner]!)).status, 201)
	} finally {
		await context.close()
	}
})

test('physical free byte, percentage and inode margins reject writes without blocking downloads or deletion', async () => {
	const context = await fixture()
	try {
		await context.start()
		const cookie = await signup()
		const created = await upload(cookie)
		assert.equal(created.status, 201)
		const file = (await created.json()).file
		for (const config of [
			{ STORAGE_MIN_FREE_PERCENT: '100' },
			{ STORAGE_MIN_FREE_BYTES: '999999999999999999999' },
			{ STORAGE_MIN_FREE_INODES: '999999999999999999999' },
		]) {
			await context.start(config)
			assert.equal((await upload(cookie)).status, 507)
			assert.equal((await usage(cookie)).reservedBytes, '0')
			assert.equal(
				await (
					await fetch(`${baseURL}/files/${file.id}/download`, { headers: { Cookie: cookie } })
				).text(),
				'1234',
			)
		}
		assert.equal(
			(
				await fetch(`${baseURL}/files/${file.id}`, {
					method: 'DELETE',
					headers: { Cookie: cookie },
				})
			).status,
			204,
		)
		assert.equal(
			(
				await fetch(`${baseURL}/files/${file.id}/permanent`, {
					method: 'DELETE',
					headers: { Cookie: cookie },
				})
			).status,
			204,
		)
	} finally {
		await context.close()
	}
})

test('transfer limits, cancellation and exclusive startup preserve active reservations', async () => {
	const context = await fixture()
	const requests: http.ClientRequest[] = []
	try {
		await context.start({ STORAGE_MAX_TRANSFERS: '2', STORAGE_MAX_USER_TRANSFERS: '1' })
		const alice = await signup(),
			bob = await signup()
		requests.push(hold(alice))
		await until(
			async () => (await usage(alice)).reservedBytes === '4',
			'First reservation missing',
		)
		assert.equal((await upload(alice)).status, 429)
		requests.push(hold(bob))
		await until(
			async () => (await usage(bob)).reservedBytes === '4',
			'Second reservation missing',
		)
		const rejected = await upload(await signup())
		assert.equal(rejected.status, 429)
		assert.equal(rejected.headers.get('retry-after'), '1')
		const second = spawn(process.execPath, ['dist/server.js'], {
			env: { ...context.environment, PORT: '18003' },
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		let logs = ''
		second.stderr.on('data', (data) => {
			logs += data.toString()
		})
		const [code] = await once(second, 'exit')
		assert.equal(code, 1)
		assert.match(logs, /already owned/)
		assert.equal((await usage(alice)).reservedBytes, '4')
		for (const request of requests) request.destroy()
		await until(
			async () =>
				(await usage(alice)).reservedBytes === '0' && (await usage(bob)).reservedBytes === '0',
			'Cancelled reservations leaked',
		)
		assert.equal((await upload(alice)).status, 201)
	} finally {
		for (const request of requests) request.destroy()
		await context.close()
	}
})

test('losing the exclusive PostgreSQL session terminates the API', async () => {
	const context = await fixture()
	try {
		const server = await context.start()
		const connection = new pg.Client({ connectionString: context.environment.DATABASE_URL })
		await connection.connect()
		try {
			const exited = once(server, 'exit')
			await connection.query(
				"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'silverbox-storage-lock' AND datname = current_database()",
			)
			const [code] = await exited
			assert.equal(code, 1)
		} finally {
			await connection.end()
		}
	} finally {
		await context.close()
	}
})

test('failed physical deletion stays charged and startup retries it after permissions are repaired', async () => {
	const context = await fixture()
	try {
		await context.start()
		const cookie = await signup()
		const file = (await (await upload(cookie)).json()).file
		const directories = await readdir(join(context.root, 'objects'))
		const directory = join(context.root, 'objects', directories[0]!)
		await fetch(`${baseURL}/files/${file.id}`, { method: 'DELETE', headers: { Cookie: cookie } })
		await chmod(directory, 0o500)
		assert.equal(
			(
				await fetch(`${baseURL}/files/${file.id}/permanent`, {
					method: 'DELETE',
					headers: { Cookie: cookie },
				})
			).status,
			202,
		)
		assert.equal(
			(await (await fetch(`${baseURL}/storage/usage`, { headers: { Cookie: cookie } })).json())
				.usedBytes,
			'4',
		)
		await chmod(directory, 0o700)
		await context.start()
		assert.equal(
			(await (await fetch(`${baseURL}/storage/usage`, { headers: { Cookie: cookie } })).json())
				.usedBytes,
			'0',
		)
	} finally {
		await context.close()
	}
})

test('production requires explicit storage root and global budget', () => {
	const environment = { ...process.env, NODE_ENV: 'production' }
	delete environment.STORAGE_ROOT
	delete environment.STORAGE_MAX_BYTES
	const result = spawnSync(process.execPath, ['dist/server.js'], {
		env: environment,
		encoding: 'utf8',
	})
	assert.equal(result.status, 1)
	assert.match(result.stderr, /STORAGE_ROOT is required in production/)
	assert.match(result.stderr, /STORAGE_MAX_BYTES is required in production/)
})
