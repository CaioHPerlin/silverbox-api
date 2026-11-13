import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import express from 'express'
import { corsMiddleware } from '../dist/middleware/cors.js'
import { env } from '../dist/config/env.js'

test('public CORS accepts HTTP(S) origins without changing authentication', async () => {
	const app = express()
	app.use(corsMiddleware)
	app.all('/files', (_req, res) => {
		res.status(401).json({ error: 'Unauthorized' })
	})
	const server = app.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
	try {
		env.CORS_ALLOW_ALL_ORIGINS = true
		for (const origin of ['http://localhost:4321', 'https://preview.example']) {
			const response = await fetch(base + '/files', {
				method: 'OPTIONS',
				headers: {
					Origin: origin,
					'Access-Control-Request-Method': 'POST',
					'Access-Control-Request-Headers':
						'content-type,x-file-name,x-file-size,x-file-mime,x-folder-id',
				},
			})
			assert.equal(response.status, 204)
			assert.equal(response.headers.get('access-control-allow-origin'), origin)
			assert.equal(response.headers.get('access-control-allow-credentials'), 'true')
			assert.match(response.headers.get('vary')!, /Origin/)
			assert.match(response.headers.get('access-control-allow-headers')!, /X-Folder-Id/)
			assert.equal((await fetch(base + '/files', { headers: { Origin: origin } })).status, 401)
		}
		for (const origin of [
			'null',
			'file://',
			'https://preview.example/path',
			'https://preview.example/',
		]) {
			assert.equal(
				(await fetch(base + '/files', { method: 'OPTIONS', headers: { Origin: origin } }))
					.status,
				403,
			)
		}
		env.CORS_ALLOW_ALL_ORIGINS = false
		assert.equal(
			(await fetch(base + '/files', { headers: { Origin: 'https://preview.example' } })).status,
			403,
		)
	} finally {
		server.close()
		await once(server, 'close')
	}
})
