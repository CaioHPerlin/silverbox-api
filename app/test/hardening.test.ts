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

test('admin contracts join accounts, storage operations, audit and metrics without changing ownership', async () => {
	const f = await fixture()
	const db = new pg.Client({ connectionString: f.environment.DATABASE_URL })
	const password = 'correct-horse-battery-staple'
	const request = (path: string, cookie?: string, method = 'GET', body?: unknown) =>
		fetch(baseURL + path, {
			method,
			headers: { ...authHeaders, ...(cookie ? { Cookie: cookie } : {}) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		})

	try {
		await f.start()
		await db.connect()
		const operator = await signup()
		const operatorAccount = (await (await request('/users/me', operator)).json()).user
		await db.query("UPDATE silverbox_api.users SET user_role = 'admin' WHERE id = $1", [
			operatorAccount.id,
		])
		const email = `admin-target-${randomUUID()}@example.com`
		const create = await request('/admin/users', operator, 'POST', {
			name: '=Pessoa de teste',
			email,
			password,
		})
		assert.equal(create.status, 201, await create.clone().text())
		const target = (await create.json()).user
		const signedIn = await request('/auth/login', undefined, 'POST', { email, password })
		assert.equal(signedIn.status, 200)
		const owner = signedIn.headers.get('set-cookie')!.split(';')[0]!

		assert.equal((await request('/admin/users')).status, 401)
		assert.equal((await request('/admin/users', owner)).status, 403)
		assert.equal(
			(await request(`/admin/users/${operatorAccount.id}`, operator, 'PATCH', { role: 'user' }))
				.status,
			409,
		)
		assert.equal(
			(await request(`/admin/users/${operatorAccount.id}`, operator, 'DELETE')).status,
			409,
		)
		const filter = `/admin/users?q=${encodeURIComponent(email)}&page=1&limit=1`
		const page = await (await request(filter, operator)).json()
		assert.equal(page.total, 1)
		assert.equal(page.users[0].id, String(target.id))
		assert.equal(typeof page.users[0].quotaLimitBytes, 'string')
		assert.equal(page.users[0].usedBytes, '0')

		const sent = await upload(owner)
		assert.equal(sent.status, 201, await sent.clone().text())
		const file = (await sent.json()).file
		const readUsed = async () =>
			(await (await request(filter, operator)).json()).users[0].usedBytes
		assert.equal(await readUsed(), '4')
		const ownerFileRoute = `/files/${file.id}`
		const adminFileRoute = `/admin/files/${file.id}`
		assert.equal((await request(ownerFileRoute, operator)).status, 404)
		assert.equal((await request(`${adminFileRoute}/download`, owner)).status, 403)
		const adminDownload = await request(`${adminFileRoute}/download`, operator)
		assert.equal(adminDownload.status, 200)
		assert.equal(await adminDownload.text(), '1234')
		const filePage = await (
			await request(`/admin/files?q=${encodeURIComponent(email)}`, operator)
		).json()
		assert.equal(filePage.files[0].ownerEmail, email)
		assert.equal(filePage.files[0].id, file.id)

		const change = `/admin/users/${target.id}`
		assert.equal((await request(change, operator, 'PATCH', { quotaLimitBytes: '3' })).status, 409)
		assert.equal(
			(await request(change, operator, 'PATCH', { quotaLimitBytes: '1048576' })).status,
			200,
		)
		const shareRoute = `${ownerFileRoute}/shares`
		for (let i = 0; i < 2; i++) {
			assert.equal(
				(await request(shareRoute, owner, 'POST', { expiresInSeconds: 600 })).status,
				201,
			)
		}
		const first = await (await request('/shares?page=1&limit=1', owner)).json()
		const second = await (await request('/shares?page=2&limit=1', owner)).json()
		assert.equal(first.total, 2)
		assert.equal(first.shares.length, 1)
		assert.ok(first.shares[0].id > second.shares[0].id)
		assert.equal('token' in first.shares[0], false)
		assert.deepEqual((await (await request('/shares?limit=1', operator)).json()).shares, [])
		assert.equal((await request('/shares?limit=101', owner)).status, 400)

		assert.equal((await request(`${adminFileRoute}/permanent`, operator, 'DELETE')).status, 409)
		assert.equal((await request(adminFileRoute, operator, 'DELETE')).status, 204)
		assert.equal(await readUsed(), '4')
		const trash = await (await request('/admin/files?trash=true', operator)).json()
		assert.equal(trash.files[0].id, file.id)
		const stats = await (await request('/admin/stats?days=7', operator)).json()
		assert.equal(stats.files.trash, 1)
		assert.equal(stats.storage.trashBytes, '4')
		assert.equal(stats.traffic.length, 7)
		assert.equal(stats.traffic.at(-1).uploadBytes, '4')
		assert.equal(stats.traffic[0].uploadBytes, '0')
		assert.equal((await request('/admin/stats', owner)).status, 403)
		assert.equal((await request(`${adminFileRoute}/permanent`, operator, 'DELETE')).status, 204)
		assert.equal(await readUsed(), '0')
		assert.equal((await request('/shares', owner).then((r) => r.json())).shares.length, 0)

		assert.equal((await upload(owner)).status, 201)
		assert.equal((await request(change, operator, 'PATCH', { banned: true })).status, 200)
		assert.equal((await request('/users/me', owner)).status, 401)
		assert.equal(
			(await request('/auth/login', undefined, 'POST', { email, password })).status,
			403,
		)
		assert.equal((await request(change, operator, 'PATCH', { banned: false })).status, 200)
		assert.equal(
			(await request('/auth/login', undefined, 'POST', { email, password })).status,
			200,
		)
		assert.equal((await request(change, operator, 'DELETE')).status, 204)
		assert.equal((await request(change, operator, 'PATCH', { banned: false })).status, 404)
		assert.deepEqual(await readdir(join(f.root, 'objects', String(target.id))), [])

		const filterAudit = `userId=${target.id}&action=upload`
		const logs = await (await request(`/admin/audit?${filterAudit}&limit=1`, operator)).json()
		assert.equal(logs.total, 2)
		assert.equal(logs.logs.length, 1)
		assert.equal(logs.logs[0].actorEmail, email)
		assert.match(logs.logs[0].requestId, /^[a-f0-9-]{36}$/)
		const exported = await request(`/admin/audit/export?${filterAudit}`, operator)
		assert.equal(exported.status, 200)
		assert.match(exported.headers.get('content-type') ?? '', /^text\/csv/)
		assert.match(await exported.text(), /"'=Pessoa de teste"/)
		assert.equal((await request('/admin/audit/export')).status, 401)
	} finally {
		await db.end()
		await f.close()
	}
})

test('avatar is private, decoded, billed once on replacement and released on removal', async () => {
	const f = await fixture()
	try {
		await f.start()
		const cookie = await signup()
		const avatar = baseURL + '/users/me/avatar'
		const { default: sharp } = await import('sharp')
		const image = await sharp({
			create: { width: 5, height: 5, channels: 3, background: '#336699' },
		})
			.png()
			.toBuffer()
		const save = (bytes: Buffer, mime = 'image/png') =>
			fetch(avatar, {
				method: 'POST',
				headers: { Origin: baseURL, Cookie: cookie, 'Content-Type': mime },
				body: bytes,
			})
		const used = async () => {
			const response = await fetch(baseURL + '/storage/usage', { headers: { Cookie: cookie } })
			return (await response.json()).usedBytes
		}
		assert.equal(await used(), '0')
		assert.equal((await save(Buffer.from('not a PNG'))).status, 415)
		assert.equal((await save(image, 'image/jpeg')).status, 415)
		assert.equal((await save(Buffer.alloc(2 * 1024 * 1024 + 1))).status, 413)
		const result = await save(image)
		assert.equal(result.status, 200, await result.clone().text())
		const data = await result.json()
		assert.match(data.image, /^\/users\/me\/avatar\?v=[0-9a-f]{16}$/)
		assert.equal(await used(), data.sizeBytes)
		assert.equal((await fetch(avatar)).status, 401)
		const other = await signup()
		assert.equal((await fetch(avatar, { headers: { Cookie: other } })).status, 404)
		const loaded = await fetch(baseURL + data.image, { headers: { Cookie: cookie } })
		assert.equal(loaded.status, 200)
		assert.equal(loaded.headers.get('content-type'), 'image/webp')
		assert.equal((await loaded.arrayBuffer()).byteLength, Number(data.sizeBytes))
		const session = await fetch(baseURL + '/users/me', { headers: { Cookie: cookie } })
		assert.equal((await session.json()).user.image, data.image)
		const updateUser = await fetch(baseURL + '/api/auth/update-user', {
			method: 'POST',
			headers: { ...authHeaders, Cookie: cookie },
			body: JSON.stringify({ image: 'https://example.com/avatar.png' }),
		})
		assert.equal(updateUser.status, 400)
		const renamed = await fetch(baseURL + '/api/auth/update-user', {
			method: 'POST',
			headers: { ...authHeaders, Cookie: cookie },
			body: JSON.stringify({ name: 'Novo nome' }),
		})
		assert.equal(renamed.status, 200)
		assert.equal((await save(image)).status, 200)
		assert.equal(await used(), data.sizeBytes)
		assert.equal(
			(await fetch(avatar, { method: 'DELETE', headers: { Origin: baseURL, Cookie: cookie } }))
				.status,
			204,
		)
		assert.equal(await used(), '0')
		assert.equal((await fetch(avatar, { headers: { Cookie: cookie } })).status, 404)
	} finally {
		await f.close()
	}
})

test('folder mutations recheck their preconditions after taking the account lock', async () => {
	const f = await fixture()
	const db = new pg.Client({ connectionString: f.environment.DATABASE_URL })
	try {
		await f.start()
		await db.connect()
		const cookie = await signup()
		const account = await fetch(baseURL + '/users/me', { headers: { Cookie: cookie } })
		const { user } = await account.json()
		const headers = { ...authHeaders, Cookie: cookie }
		const create = await fetch(baseURL + '/folders', {
			method: 'POST',
			headers,
			body: JSON.stringify({ name: 'Documentos' }),
		})
		assert.equal(create.status, 201)
		const { folder } = await create.json()

		async function duringAccountLock(
			operation: (signal: AbortSignal) => Promise<Response>,
			edit: () => Promise<unknown>,
		) {
			await db.query('BEGIN')
			await db.query('SELECT id FROM silverbox_api.users WHERE id = $1 FOR UPDATE', [user.id])
			const pending = operation(AbortSignal.timeout(7000))
			try {
				await until(async () => {
					await db.query('SELECT pg_stat_clear_snapshot()')
					const result = await db.query(
						"SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
					)
					return Boolean(result.rowCount)
				}, 'Folder mutation did not wait for the account lock')
				await edit()
				await db.query('COMMIT')
			} catch (error) {
				await db.query('ROLLBACK')
				await pending.catch(() => {})
				throw error
			}
			return pending
		}

		const deleted = await duringAccountLock(
			(signal) =>
				fetch(baseURL + '/folders/' + folder.id, { method: 'DELETE', headers, signal }),
			() =>
				db.query(
					'INSERT INTO silverbox_api.folders (userid, parentfolderid, name, updatedat) VALUES ($1, $2, $3, now())',
					[user.id, folder.id, 'Propostas'],
				),
		)
		assert.equal(deleted.status, 409)
		const children = await fetch(baseURL + '/folders?parentFolderId=' + folder.id, { headers })
		assert.equal(children.status, 200)
		assert.deepEqual(
			(await children.json()).folders.map(({ name }: { name: string }) => name),
			['Propostas'],
		)

		const destination = await fetch(baseURL + '/folders', {
			method: 'POST',
			headers,
			body: JSON.stringify({ name: 'Arquivo' }),
		})
		assert.equal(destination.status, 201)
		const { folder: parent } = await destination.json()
		const moved = await duringAccountLock(
			(signal) =>
				fetch(baseURL + '/folders/' + folder.id, {
					method: 'PATCH',
					headers,
					signal,
					body: JSON.stringify({ parentFolderId: parent.id }),
				}),
			() => db.query('DELETE FROM silverbox_api.folders WHERE id = $1', [parent.id]),
		)
		assert.equal(moved.status, 404)
		const roots = await fetch(baseURL + '/folders', { headers })
		assert.deepEqual(
			(await roots.json()).folders.map(({ name }: { name: string }) => name),
			['Documentos'],
		)
	} finally {
		await db.end()
		await f.close()
	}
})
