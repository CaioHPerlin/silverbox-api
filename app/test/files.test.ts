import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import pg from 'pg'

const baseURL = 'http://127.0.0.1:18001'
const headers = { Origin: baseURL, 'Content-Type': 'application/json' }

async function startServer(storageRoot: string): Promise<ChildProcess> {
	const server = spawn(process.execPath, ['dist/server.js'], {
		cwd: process.cwd(),
		env: { ...process.env, BETTER_AUTH_URL: baseURL, PORT: '18001', STORAGE_ROOT: storageRoot },
		stdio: 'pipe',
	})
	for (let attempt = 0; attempt < 80; attempt++) {
		if (server.exitCode !== null) throw new Error(`API exited with ${server.exitCode}`)
		try {
			const response = await fetch(`${baseURL}/api/auth/ok`)
			if (response.ok) return server
		} catch {
			/* still starting */
		}
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	server.kill('SIGTERM')
	throw new Error('API did not start')
}

async function stopServer(server: ChildProcess): Promise<void> {
	server.kill('SIGTERM')
	if (server.exitCode === null) await once(server, 'exit')
}

async function register(name: string) {
	const email = `${name}-${randomUUID()}@example.com`
	const response = await fetch(`${baseURL}/auth/register`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ name, email, password: 'correct-horse-battery-staple' }),
	})
	assert.equal(response.status, 200)
	const cookie = response.headers.get('set-cookie')?.split(';')[0]
	assert.ok(cookie)
	return { cookie, user: (await response.json()).user as { id: string; email: string } }
}

async function jsonRequest(path: string, method: string, cookie?: string, body?: unknown) {
	return fetch(`${baseURL}${path}`, {
		method,
		headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
}

async function upload(
	path: string,
	cookie: string,
	bytes: Buffer,
	name = 'documento.txt',
	extra: Record<string, string> = {},
) {
	return fetch(`${baseURL}${path}`, {
		method: 'POST',
		headers: {
			Origin: baseURL,
			Cookie: cookie,
			'Content-Type': 'application/octet-stream',
			'X-File-Name': encodeURIComponent(name),
			'X-File-Size': String(bytes.length),
			'X-File-Mime': 'text/plain',
			...extra,
		},
		body: bytes,
	})
}

test('folders, versions, sharing, trash, quota and binary round-trip work together', async () => {
	const root = await mkdtemp(join(tmpdir(), 'silverbox-files-'))
	const server = await startServer(root)
	try {
		const spec = (await (await fetch(`${baseURL}/docs.json`)).json()) as {
			servers: unknown[]
			paths: Record<string, unknown>
		}
		assert.equal(spec.servers.length, 1)
		assert.ok(spec.paths['/files/{id}/versions/{versionId}/restore'])
		const alice = await register('Alice')
		const bob = await register('Bob')
		const folderResponse = await jsonRequest('/folders', 'POST', alice.cookie, {
			name: 'Pessoal',
		})
		assert.equal(folderResponse.status, 201)
		const folder = (await folderResponse.json()).folder as { id: number }
		const childResponse = await jsonRequest('/folders', 'POST', alice.cookie, {
			name: 'Filho',
			parentFolderId: folder.id,
		})
		assert.equal(childResponse.status, 201)
		const child = (await childResponse.json()).folder as { id: number }
		const folders = (await (
			await fetch(`${baseURL}/folders?parentFolderId=${folder.id}`, {
				headers: { Cookie: alice.cookie },
			})
		).json()) as { folders: Array<{ id: number }> }
		assert.deepEqual(
			folders.folders.map((item) => item.id),
			[child.id],
		)
		assert.equal(
			(
				await jsonRequest(`/folders/${folder.id}`, 'PATCH', alice.cookie, {
					parentFolderId: child.id,
				})
			).status,
			409,
		)
		assert.equal(
			(
				await jsonRequest('/folders', 'POST', bob.cookie, {
					name: 'Intruso',
					parentFolderId: folder.id,
				})
			).status,
			404,
		)

		const first = Buffer.from([0, 1, 2, 3, 255])
		const created = await upload('/files', alice.cookie, first, 'binário.bin', {
			'X-Folder-Id': String(folder.id),
		})
		assert.equal(created.status, 201)
		const file = (await created.json()).file as { id: number; checksum: string }
		assert.equal(file.checksum, createHash('sha256').update(first).digest('hex'))
		const metadata = (await (
			await fetch(`${baseURL}/files/${file.id}`, { headers: { Cookie: alice.cookie } })
		).json()) as { file: { originalName: string } }
		assert.equal(metadata.file.originalName, 'binário.bin')
		const downloaded = await fetch(`${baseURL}/files/${file.id}/download`, {
			headers: { Cookie: alice.cookie },
		})
		assert.equal(downloaded.status, 200)
		assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), first)
		assert.equal(
			(await fetch(`${baseURL}/files/${file.id}`, { headers: { Cookie: bob.cookie } })).status,
			404,
		)
		assert.equal((await jsonRequest(`/folders/${folder.id}`, 'DELETE', alice.cookie)).status, 409)

		const second = Buffer.from('second version')
		const versionResponse = await upload(`/files/${file.id}/versions`, alice.cookie, second)
		assert.equal(versionResponse.status, 201)
		const versionsResponse = await fetch(`${baseURL}/files/${file.id}/versions`, {
			headers: { Cookie: alice.cookie },
		})
		const versions = (await versionsResponse.json()).versions as Array<{
			id: number
			versionNumber: number
		}>
		assert.deepEqual(
			versions.map((v) => v.versionNumber),
			[2, 1],
		)
		const prior = await fetch(
			`${baseURL}/files/${file.id}/versions/${versions[1]!.id}/download`,
			{ headers: { Cookie: alice.cookie } },
		)
		assert.deepEqual(Buffer.from(await prior.arrayBuffer()), first)
		const restoredVersion = await jsonRequest(
			`/files/${file.id}/versions/${versions[1]!.id}/restore`,
			'POST',
			alice.cookie,
		)
		assert.equal(restoredVersion.status, 201)
		assert.equal((await restoredVersion.json()).version.versionNumber, 3)
		const used = first.length * 2 + second.length
		const usageResponse = await fetch(`${baseURL}/storage/usage`, {
			headers: { Cookie: alice.cookie },
		})
		assert.equal((await usageResponse.json()).usedBytes, String(used))

		assert.equal(
			(
				await jsonRequest(`/files/${file.id}`, 'PATCH', alice.cookie, {
					originalName: 'renomeado.bin',
					folderId: null,
				})
			).status,
			200,
		)
		const shareResponse = await jsonRequest(`/files/${file.id}/shares`, 'POST', alice.cookie, {
			expiresInSeconds: 60,
		})
		assert.equal(shareResponse.status, 201)
		const share = (await shareResponse.json()) as { id: number; url: string }
		const shares = (await (
			await fetch(`${baseURL}/files/${file.id}/shares`, { headers: { Cookie: alice.cookie } })
		).json()) as { shares: Array<{ id: number; token?: string }> }
		assert.equal(shares.shares[0]?.id, share.id)
		assert.equal(shares.shares[0]?.token, undefined)
		assert.deepEqual(Buffer.from(await (await fetch(share.url)).arrayBuffer()), first)
		assert.equal(
			(await jsonRequest(`/files/${file.id}/shares/${share.id}`, 'DELETE', alice.cookie)).status,
			204,
		)
		assert.equal((await fetch(share.url)).status, 410)
		const expiredShare = (await (
			await jsonRequest(`/files/${file.id}/shares`, 'POST', alice.cookie, {})
		).json()) as { id: number; url: string }
		const connection = new pg.Client({ connectionString: process.env.DATABASE_URL })
		await connection.connect()
		try {
			await connection.query(
				"UPDATE silverbox_api.shared_links SET expiresat = now() - interval '1 second' WHERE id = $1",
				[expiredShare.id],
			)
		} finally {
			await connection.end()
		}
		assert.equal((await fetch(expiredShare.url)).status, 410)
		const otherShare = (await (
			await jsonRequest(`/files/${file.id}/shares`, 'POST', alice.cookie, {})
		).json()) as { url: string }
		assert.equal((await jsonRequest(`/files/${file.id}`, 'DELETE', alice.cookie)).status, 204)
		assert.equal((await fetch(otherShare.url)).status, 410)
		assert.equal(
			(await fetch(`${baseURL}/files/trash`, { headers: { Cookie: alice.cookie } })).status,
			200,
		)
		assert.equal(
			(
				await (
					await fetch(`${baseURL}/storage/usage`, { headers: { Cookie: alice.cookie } })
				).json()
			).usedBytes,
			String(used),
		)
		assert.equal(
			(await jsonRequest(`/files/${file.id}/restore`, 'POST', alice.cookie)).status,
			200,
		)
		assert.equal((await jsonRequest(`/files/${file.id}`, 'DELETE', alice.cookie)).status, 204)
		assert.equal(
			(await jsonRequest(`/files/${file.id}/permanent`, 'DELETE', alice.cookie)).status,
			204,
		)
		const auditDatabase = new pg.Client({ connectionString: process.env.DATABASE_URL })
		await auditDatabase.connect()
		try {
			const actions = await auditDatabase.query(
				'SELECT DISTINCT action FROM silverbox_api.audit_logs WHERE userid = $1',
				[Number(alice.user.id)],
			)
			const observed = new Set(actions.rows.map((row: { action: string }) => row.action))
			for (const action of [
				'upload',
				'download',
				'version_upload',
				'version_restore',
				'share_create',
				'share_download',
				'share_revoke',
				'trash',
				'trash_restore',
				'permanent_delete',
			])
				assert.ok(observed.has(action), `Missing audit action ${action}`)
		} finally {
			await auditDatabase.end()
		}
		assert.equal(
			(
				await (
					await fetch(`${baseURL}/storage/usage`, { headers: { Cookie: alice.cookie } })
				).json()
			).usedBytes,
			'0',
		)
		assert.equal((await jsonRequest(`/folders/${child.id}`, 'DELETE', alice.cookie)).status, 204)
		assert.equal((await jsonRequest(`/folders/${folder.id}`, 'DELETE', alice.cookie)).status, 204)
	} finally {
		await stopServer(server)
		await rm(root, { recursive: true, force: true })
	}
})

test('concurrent uploads cannot exceed quota; failed upload leaves no reservation; startup reconciles abandoned bytes', async () => {
	const root = await mkdtemp(join(tmpdir(), 'silverbox-quota-'))
	let server = await startServer(root)
	const database = new pg.Client({ connectionString: process.env.DATABASE_URL })
	await database.connect()
	try {
		const alice = await register('Quota')
		await database.query('UPDATE silverbox_api.users SET quotalimitbytes = 5 WHERE id = $1', [
			Number(alice.user.id),
		])
		const results = await Promise.all([
			upload('/files', alice.cookie, Buffer.from('four')),
			upload('/files', alice.cookie, Buffer.from('five')),
		])
		assert.deepEqual(results.map((r) => r.status).sort(), [201, 413])
		const bad = await fetch(`${baseURL}/files`, {
			method: 'POST',
			headers: {
				Origin: baseURL,
				Cookie: alice.cookie,
				'Content-Type': 'application/octet-stream',
				'X-File-Name': 'bad.txt',
				'X-File-Size': '1',
			},
			body: Buffer.from('XX'),
		})
		assert.equal(bad.status, 400)
		assert.deepEqual(await readdir(join(root, 'staging')), [])
		assert.equal(
			(
				await (
					await fetch(`${baseURL}/storage/usage`, { headers: { Cookie: alice.cookie } })
				).json()
			).reservedBytes,
			'0',
		)
		const listed = (await (
			await fetch(`${baseURL}/files`, { headers: { Cookie: alice.cookie } })
		).json()) as { files: Array<{ id: number }> }
		assert.equal(listed.files.length, 1)
		await database.query(
			"UPDATE silverbox_api.files SET isdeleted = true, deletedat = now(), status = 'deleting' WHERE id = $1",
			[listed.files[0]!.id],
		)

		const reservationId = randomUUID()
		const objectId = randomUUID()
		const key = `objects/${alice.user.id}/${objectId}`
		await database.query(
			"INSERT INTO silverbox_api.upload_reservations (id, userid, storagekey, sizebytes, expiresat) VALUES ($1, $2, $3, 1, now() + interval '1 hour')",
			[reservationId, Number(alice.user.id), key],
		)
		await writeFile(join(root, 'staging', reservationId), 'x')
		await stopServer(server)
		server = await startServer(root)
		const count = await database.query(
			'SELECT count(*)::int AS count FROM silverbox_api.upload_reservations WHERE id = $1',
			[reservationId],
		)
		assert.equal(count.rows[0]?.count, 0)
		assert.ok(!(await readdir(join(root, 'staging'))).includes(reservationId))
		assert.equal(
			(
				await (
					await fetch(`${baseURL}/storage/usage`, { headers: { Cookie: alice.cookie } })
				).json()
			).usedBytes,
			'0',
		)
	} finally {
		await database.end()
		await stopServer(server)
		await rm(root, { recursive: true, force: true })
	}
})

test('invalid local storage configuration fails before the API starts', () => {
	const result = spawnSync(process.execPath, ['dist/server.js'], {
		cwd: process.cwd(),
		env: {
			...process.env,
			STORAGE_ROOT: 'relative/files',
			MAX_UPLOAD_BYTES: '0',
		},
		encoding: 'utf8',
	})
	assert.equal(result.status, 1)
	assert.match(result.stderr, /STORAGE_ROOT/)
	assert.match(result.stderr, /MAX_UPLOAD_BYTES/)
})
