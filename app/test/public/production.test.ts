import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import dns from 'node:dns'
import { validateHttpContracts } from '../contracts.js'

const base = 'https://api.silverbox.perlin.com.br'
const web = 'https://silverbox.perlin.com.br'
const run = randomUUID()
const emails = [`public-${run}@example.com`, `other-${run}@example.com`]
const password = randomUUID() + randomUUID()
const evidence: unknown[] = []
// Equivalent to curl --resolve: preserve hostname, SNI and certificate validation.
// Only used while an explicitly confirmed DNS record is negatively cached locally.
if (process.env.PUBLIC_SMOKE_IPV4) {
	assert.equal(process.env.PUBLIC_SMOKE_IPV4, '152.67.57.175')
	const originalLookup = dns.lookup
	dns.lookup = ((hostname: string, options: any, callback: any) => {
		if (![new URL(base).hostname, new URL(web).hostname].includes(hostname))
			return originalLookup(hostname, options, callback)
		const cb = typeof options === 'function' ? options : callback
		const all = typeof options === 'object' && options.all
		queueMicrotask(() =>
			all
				? cb(null, [{ address: process.env.PUBLIC_SMOKE_IPV4, family: 4 }])
				: cb(null, process.env.PUBLIC_SMOKE_IPV4, 4),
		)
	}) as typeof dns.lookup
	evidence.push({
		dnsOverride: process.env.PUBLIC_SMOKE_IPV4,
		reason: 'Authoritative DNS confirmed; local negative cache',
		tlsValidation: 'enabled',
	})
}
function redact(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redact)
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				/token|password|secret/i.test(key) ? '<redacted>' : redact(item),
			]),
		)
	return value
}
async function request(
	path: string,
	method = 'GET',
	cookie?: string,
	body?: unknown,
	extra: Record<string, string> = {},
) {
	const binary = body instanceof Uint8Array
	const response = await fetch(base + path, {
		method,
		headers: {
			Origin: web,
			...(cookie ? { Cookie: cookie } : {}),
			...(body
				? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }
				: {}),
			...extra,
		},
		...(body === undefined ? {} : { body: binary ? (body as Buffer) : JSON.stringify(body) }),
	})
	const copy = response.clone()
	const content = copy.headers.get('content-type') ?? ''
	const value =
		response.status === 204
			? null
			: content.includes('application/json')
				? await copy.json()
				: await copy.text()
	evidence.push({
		endpoint: `${method} ${path}`,
		body: binary ? { hex: Buffer.from(body).toString('hex') } : redact(body ?? null),
		status: response.status,
		response: redact(value),
	})
	return response
}

test(
	'public HTTPS serves web, sessions, CORS and private file round-trip',
	{ timeout: 120_000 },
	async () => {
		assert.equal(process.env.PUBLIC_SMOKE_RUN, 'true', 'Explicit PUBLIC_SMOKE_RUN=true required')
		let cookie: string | undefined
		let fileId: number | undefined
		try {
			const site = await fetch(web)
			assert.equal(site.status, 200)
			assert.match(await site.text(), /<title>Silverbox/)
			const runtime = await fetch(web + '/runtime-config.js')
			assert.match(await runtime.text(), /https:\/\/api\.silverbox\.perlin\.com\.br/)
			assert.match(runtime.headers.get('cache-control') ?? '', /no-store/)
			await validateHttpContracts(base)
			assert.equal((await request('/health/ready')).status, 200)
			assert.equal((await request('/users/me')).status, 401)
			assert.equal(
				(
					await request('/users/me', 'GET', undefined, undefined, {
						Origin: 'https://untrusted.example',
					})
				).status,
				403,
			)
			const preflight = await request('/files', 'OPTIONS', undefined, undefined, {
				'Access-Control-Request-Method': 'POST',
				'Access-Control-Request-Headers': 'content-type,x-file-name,x-file-size',
			})
			assert.equal(preflight.status, 204)
			assert.equal(preflight.headers.get('access-control-allow-origin'), web)
			assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true')
			const signup = await request('/auth/register', 'POST', undefined, {
				name: 'Public smoke',
				email: emails[0],
				password,
			})
			assert.equal(signup.status, 200)
			const header = signup.headers
				.getSetCookie()
				.find((value) => value.includes('session_token'))
			assert.ok(header)
			for (const attribute of [/Secure/i, /HttpOnly/i, /SameSite=Lax/i, /Path=\//i])
				assert.match(header, attribute)
			cookie = header.split(';')[0]
			evidence.push({ cookieAttributes: header.slice(header.indexOf(';') + 1) })
			const other = await request('/auth/register', 'POST', undefined, {
				name: 'Public smoke isolation',
				email: emails[1],
				password,
			})
			assert.equal(other.status, 200)
			const otherCookie = other.headers
				.getSetCookie()
				.find((value) => value.includes('session_token'))!
				.split(';')[0]
			assert.equal((await request('/users/me', 'GET', cookie)).status, 200)
			assert.equal((await request('/api/auth/get-session', 'GET', cookie)).status, 200)
			const bytes = Buffer.from([0, 1, 2, 255, 13, 10, 42])
			const upload = await request('/files', 'POST', cookie, bytes, {
				'X-File-Name': 'public-smoke.bin',
				'X-File-Size': String(bytes.length),
				'X-File-Mime': 'application/octet-stream',
			})
			assert.equal(upload.status, 201)
			fileId = (await upload.json()).file.id
			assert.equal((await request(`/files/${fileId}`, 'GET', otherCookie)).status, 404)
			const download = await fetch(`${base}/files/${fileId}/download`, {
				headers: { Cookie: cookie, Origin: web },
			})
			assert.equal(download.status, 200)
			const downloaded = Buffer.from(await download.arrayBuffer())
			assert.deepEqual(downloaded, bytes)
			evidence.push({
				endpoint: `GET /files/${fileId}/download`,
				body: null,
				status: download.status,
				response: {
					hex: downloaded.toString('hex'),
					sha256: createHash('sha256').update(downloaded).digest('hex'),
					contentLength: download.headers.get('content-length'),
				},
			})
			assert.equal((await request('/storage/usage', 'GET', cookie)).status, 200)
			assert.equal((await request(`/files/${fileId}`, 'DELETE', cookie)).status, 204)
			assert.equal((await request(`/files/${fileId}/permanent`, 'DELETE', cookie)).status, 204)
			fileId = undefined
			assert.equal((await request('/auth/logout', 'POST', cookie, {})).status, 200)
			assert.equal((await request('/users/me', 'GET', cookie)).status, 401)
			const login = await request('/api/auth/sign-in/email', 'POST', undefined, {
				email: emails[0],
				password,
			})
			assert.equal(login.status, 200)
			const loginCookie = login.headers
				.getSetCookie()
				.find((value) => value.includes('session_token'))!
				.split(';')[0]
			assert.equal((await request('/api/auth/get-session', 'GET', loginCookie)).status, 200)
			assert.equal((await request('/auth/logout', 'POST', loginCookie, {})).status, 200)
			assert.equal((await request('/auth/google')).status, 400)
		} finally {
			if (fileId && cookie) {
				await request(`/files/${fileId}`, 'DELETE', cookie)
				await request(`/files/${fileId}/permanent`, 'DELETE', cookie)
			}
			await writeFile(
				process.env.PUBLIC_SMOKE_EVIDENCE ?? '/tmp/silverbox-public-evidence.json',
				JSON.stringify({ at: new Date().toISOString(), base, web, emails, evidence }, null, 2) +
					'\n',
				{ mode: 0o600 },
			)
		}
	},
)
