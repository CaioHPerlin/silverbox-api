import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import pg from 'pg'
import { SMTPServer } from 'smtp-server'
import { generate } from 'selfsigned'
import { assertOperationsCovered, validateHttpContracts } from './contracts.js'

const baseURL = process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:18000'

async function waitForServer(server: ChildProcess, url = baseURL): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (server.exitCode !== null) throw new Error(`API exited with code ${server.exitCode}`)
		try {
			const response = await fetch(`${url}/api/auth/ok`)
			if (response.ok) return
		} catch {
			// Wait for the listener to become available.
		}
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	throw new Error('API did not start within five seconds')
}

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (predicate()) return
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	throw new Error(message)
}

test('auth signup, signin, session, and signout work with PostgreSQL', async (t) => {
	const databaseName = `silverbox_auth_${randomUUID().replaceAll('-', '')}`
	const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
	await admin.connect()
	await admin.query(`CREATE DATABASE "${databaseName}"`)
	t.after(async () => {
		try {
			await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`)
		} finally {
			await admin.end()
		}
	})
	const databaseUrl = new URL(process.env.DATABASE_URL!)
	databaseUrl.pathname = `/${databaseName}`
	const databaseEnv = { ...process.env, DATABASE_URL: databaseUrl.toString() }
	const migration = spawnSync(
		process.execPath,
		['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
		{ env: databaseEnv, encoding: 'utf8' },
	)
	assert.equal(migration.status, 0, migration.stderr)
	const temp = mkdtempSync(join(tmpdir(), 'silverbox-auth-email-'))
	const certificate = await generate([{ name: 'commonName', value: '127.0.0.1' }], {
		algorithm: 'sha256',
		extensions: [
			{ name: 'basicConstraints', cA: true },
			{ name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
			{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
			{ name: 'extKeyUsage', serverAuth: true },
		],
	})
	const caPath = join(temp, 'smtp-test-ca.pem')
	writeFileSync(caPath, certificate.cert)
	const messages: string[] = []
	let rejectAuth = false
	const smtp = new SMTPServer({
		key: certificate.private,
		cert: certificate.cert,
		disableReverseLookup: true,
		onAuth(auth, session, callback) {
			if (
				rejectAuth ||
				!session.secure ||
				auth.username !== 'smtp-user' ||
				auth.password !== 'smtp-password'
			) {
				callback(new Error('SMTP authentication rejected'))
				return
			}
			callback(null, { user: auth.username })
		},
		onData(stream, _session, callback) {
			const chunks: Buffer[] = []
			stream.on('data', (chunk: Buffer) => chunks.push(chunk))
			stream.on('end', () => {
				messages.push(Buffer.concat(chunks).toString('utf8'))
				callback(null, 'Message accepted')
			})
		},
	})
	const smtpListening = once(smtp.server, 'listening')
	smtp.listen(0, '127.0.0.1')
	await smtpListening
	const smtpAddress = smtp.server.address()
	assert.ok(smtpAddress && typeof smtpAddress !== 'string')
	const storageRoot = join(temp, 'files')
	const serverEnv: NodeJS.ProcessEnv = {
		...databaseEnv,
		PORT: new URL(baseURL).port || '80',
		BETTER_AUTH_URL: baseURL,
		BETTER_AUTH_SECRET:
			process.env.BETTER_AUTH_SECRET ?? 'local-test-secret-with-at-least-thirty-two-characters',
		NODE_ENV: 'test',
		STORAGE_ROOT: storageRoot,
		SMTP_HOST: '127.0.0.1',
		SMTP_PORT: String(smtpAddress.port),
		SMTP_USER: 'smtp-user',
		SMTP_PASSWORD: 'smtp-password',
		SMTP_SECURE: 'false',
		MAIL_FROM: 'Silverbox <no-reply@example.net>',
		NODE_EXTRA_CA_CERTS: caPath,
	}
	const server = spawn(process.execPath, ['dist/server.js'], {
		cwd: process.cwd(),
		env: serverEnv,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let logs = ''
	server.stdout.on('data', (data) => (logs += data.toString()))
	server.stderr.on('data', (data) => (logs += data.toString()))

	try {
		await waitForServer(server)
		await validateHttpContracts(baseURL)
		assert.equal((await fetch(`${baseURL}/`)).status, 200)
		assert.equal((await fetch(`${baseURL}/health/live`)).status, 200)
		assert.equal((await fetch(`${baseURL}/health/ready`)).status, 200)
		assert.equal((await fetch(`${baseURL}/docs`)).status, 200)
		const email = `auth-${randomUUID()}@example.com`
		const signup = await fetch(`${baseURL}/auth/register`, {
			method: 'POST',
			headers: { Origin: baseURL, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Test User',
				email,
				password: 'correct-horse-battery-staple',
			}),
		})
		assert.equal(signup.status, 200)
		const signupBody = await signup.json()
		assert.equal(signupBody.user.email, email)
		assert.match(signupBody.user.id, /^\d+$/)
		const cookie = signup.headers.get('set-cookie')?.split(';')[0]
		assert.ok(cookie)
		const database = new pg.Client({ connectionString: databaseEnv.DATABASE_URL })
		await database.connect()
		try {
			const { rows } = await database.query(
				'SELECT user_role, quotalimitbytes FROM silverbox_api.users WHERE email = $1',
				[email],
			)
			assert.equal(rows[0]?.user_role, 'user')
			assert.equal(rows[0]?.quotalimitbytes, '1073741824')
		} finally {
			await database.end()
		}

		const session = await fetch(`${baseURL}/users/me`, {
			headers: { Cookie: cookie },
		})
		assert.equal(session.status, 200)
		assert.equal((await session.json()).user.email, email)

		const unauthorized = await fetch(`${baseURL}/users/me`)
		assert.equal(unauthorized.status, 401)
		const google = await fetch(`${baseURL}/auth/google`, {
			headers: { Origin: baseURL },
			redirect: 'manual',
		})
		assert.equal(google.status, 302)
		const googleLocation = google.headers.get('location')
		assert.ok(googleLocation)
		const googleURL = new URL(googleLocation)
		assert.equal(googleURL.origin, 'https://accounts.google.com')
		assert.equal(
			googleURL.searchParams.get('redirect_uri'),
			`${baseURL}/api/auth/callback/google`,
		)

		const signin = await fetch(`${baseURL}/auth/login`, {
			method: 'POST',
			headers: { Origin: baseURL, 'Content-Type': 'application/json' },
			body: JSON.stringify({ email, password: 'correct-horse-battery-staple' }),
		})
		assert.equal(signin.status, 200)
		const nativeEmail = `native-${randomUUID()}@example.com`
		const frontHeaders = { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }
		const nativeSignup = await fetch(`${baseURL}/api/auth/sign-up/email`, {
			method: 'POST',
			headers: frontHeaders,
			body: JSON.stringify({
				name: 'Front User',
				email: nativeEmail,
				password: 'correct-horse-battery-staple',
			}),
		})
		assert.equal(nativeSignup.status, 200)
		const nativeSignin = await fetch(`${baseURL}/api/auth/sign-in/email`, {
			method: 'POST',
			headers: frontHeaders,
			body: JSON.stringify({ email: nativeEmail, password: 'correct-horse-battery-staple' }),
		})
		assert.equal(nativeSignin.status, 200)
		assert.equal(nativeSignin.headers.get('access-control-allow-origin'), 'http://localhost:5173')
		const nativeCookie = nativeSignin.headers.get('set-cookie')!.split(';')[0]!
		const nativeSession = await fetch(`${baseURL}/api/auth/get-session`, {
			headers: { Cookie: nativeCookie, Origin: 'http://localhost:5173' },
		})
		assert.equal(nativeSession.status, 200)
		assert.equal((await nativeSession.json()).user.email, nativeEmail)

		const redirectTo = 'http://localhost:5173/reset-password'
		const resetHeaders = { ...frontHeaders, 'X-Real-IP': '192.0.2.10' }
		const resetRequest = () =>
			fetch(`${baseURL}/api/auth/request-password-reset`, {
				method: 'POST',
				headers: resetHeaders,
				body: JSON.stringify({ email: nativeEmail, redirectTo }),
			})
		const requested = await resetRequest()
		assert.equal(requested.status, 200)
		const requestedBody = await requested.json()
		assert.equal(requestedBody.status, true)
		await waitForCondition(() => messages.length === 1, 'Reset email was not captured')
		// Nodemailer wraps long text lines and encodes '=' as '=3D' in quoted-printable MIME.
		const messageText = messages[0]!
			.replace(/=\r?\n/g, '')
			.replace(/=([0-9a-f]{2})/gi, (_match, hex: string) =>
				String.fromCharCode(Number.parseInt(hex, 16)),
			)
		assert.match(messageText, /Subject: Reset your Silverbox password/)
		assert.ok(messageText.includes(`To: ${nativeEmail}`))
		const resetLink = messageText.match(/https?:\/\/[^\s<>]+/)?.[0]
		assert.ok(resetLink, 'Reset URL was not present in the captured email')
		const resetUrl = new URL(resetLink)
		assert.equal(resetUrl.searchParams.get('callbackURL'), redirectTo)
		const token = resetUrl.pathname.split('/').at(-1)
		assert.ok(token)
		const verificationDb = new pg.Client({ connectionString: databaseEnv.DATABASE_URL })
		await verificationDb.connect()
		try {
			const { rows } = await verificationDb.query(
				"SELECT EXTRACT(EPOCH FROM expiresat AT TIME ZONE 'UTC') * 1000 AS expiry_ms FROM silverbox_api.verification WHERE identifier = $1",
				[`reset-password:${token}`],
			)
			assert.equal(rows.length, 1)
			const expiry = Number(rows[0]!.expiry_ms)
			assert.ok(expiry - Date.now() > 3500_000 && expiry - Date.now() <= 3600_000)
		} finally {
			await verificationDb.end()
		}
		const callback = await fetch(resetUrl, { redirect: 'manual' })
		assert.equal(callback.status, 302)
		const callbackTarget = new URL(callback.headers.get('location')!)
		assert.equal(callbackTarget.origin, 'http://localhost:5173')
		assert.equal(callbackTarget.pathname, '/reset-password')
		assert.equal(callbackTarget.searchParams.get('token'), token)
		await waitForCondition(
			() => logs.includes('/api/auth/reset-password/[redacted]'),
			'Reset callback path was not redacted in request logs',
		)
		assert.equal(logs.includes(token), false)
		const expiryDb = new pg.Client({ connectionString: databaseEnv.DATABASE_URL })
		await expiryDb.connect()
		try {
			await expiryDb.query(
				"UPDATE silverbox_api.verification SET expiresat = (NOW() AT TIME ZONE 'UTC') - INTERVAL '1 second' WHERE identifier = $1",
				[`reset-password:${token}`],
			)
		} finally {
			await expiryDb.end()
		}
		const expiredCallback = await fetch(resetUrl, { redirect: 'manual' })
		assert.equal(expiredCallback.status, 302)
		assert.equal(
			new URL(expiredCallback.headers.get('location')!).searchParams.get('error'),
			'INVALID_TOKEN',
		)

		const unknown = await fetch(`${baseURL}/api/auth/request-password-reset`, {
			method: 'POST',
			headers: resetHeaders,
			body: JSON.stringify({ email: `unknown-${randomUUID()}@example.com`, redirectTo }),
		})
		assert.equal(unknown.status, 200)
		assert.deepEqual(await unknown.json(), requestedBody)
		assert.equal(messages.length, 1)
		const withoutRedirect = await fetch(`${baseURL}/api/auth/request-password-reset`, {
			method: 'POST',
			headers: { ...frontHeaders, 'X-Real-IP': '192.0.2.13' },
			body: JSON.stringify({ email: `unknown-no-redirect-${randomUUID()}@example.com` }),
		})
		assert.equal(withoutRedirect.status, 200)
		assert.deepEqual(await withoutRedirect.json(), requestedBody)

		const invalidOrigin = await fetch(`${baseURL}/api/auth/request-password-reset`, {
			method: 'POST',
			headers: { ...frontHeaders, 'X-Real-IP': '192.0.2.11' },
			body: JSON.stringify({
				email: nativeEmail,
				redirectTo: `https://untrusted.example/reset?token=${token}&email=${nativeEmail}`,
			}),
		})
		assert.equal(invalidOrigin.status, 403)

		rejectAuth = true
		const failedDelivery = await fetch(`${baseURL}/api/auth/request-password-reset`, {
			method: 'POST',
			headers: { ...frontHeaders, 'X-Real-IP': '192.0.2.12' },
			body: JSON.stringify({ email: nativeEmail, redirectTo }),
		})
		assert.equal(failedDelivery.status, 200)
		await waitForCondition(
			() => logs.includes('[MAIL] Password reset email delivery failed'),
			'SMTP failure was not recorded',
		)
		assert.equal(logs.includes(nativeEmail), false)
		assert.equal(logs.includes(token), false)
		assert.equal(logs.includes('smtp-password'), false)
		assert.equal(logs.includes('Reset link:'), false)
		rejectAuth = false

		const thirdRequest = await fetch(`${baseURL}/api/auth/request-password-reset`, {
			method: 'POST',
			headers: resetHeaders,
			body: JSON.stringify({ email: `unknown-third-${randomUUID()}@example.com`, redirectTo }),
		})
		assert.equal(thirdRequest.status, 200)
		const limited = await resetRequest()
		assert.equal(limited.status, 429)
		assert.match(limited.headers.get('content-type') ?? '', /text\/plain/)
		assert.match(limited.headers.get('x-retry-after') ?? '', /^\d+$/)
		assert.deepEqual(await limited.json(), {
			message: 'Too many requests. Please try again later.',
		})

		assert.equal(
			(
				await fetch(`${baseURL}/api/auth/sign-out`, {
					method: 'POST',
					headers: { ...frontHeaders, Cookie: nativeCookie },
					body: '{}',
				})
			).status,
			200,
		)
		assert.equal(
			(
				await fetch(`${baseURL}/api/auth/callback/google?error=access_denied`, {
					redirect: 'manual',
				})
			).status,
			302,
		)

		const signout = await fetch(`${baseURL}/auth/logout`, {
			method: 'POST',
			headers: { Cookie: cookie, Origin: baseURL, 'Content-Type': 'application/json' },
			body: '{}',
		})
		assert.equal(signout.status, 200)
		const expired = await fetch(`${baseURL}/users/me`, {
			headers: { Cookie: cookie },
		})
		assert.equal(expired.status, 401)
		assertOperationsCovered([
			'GET /',
			'GET /health/live',
			'GET /health/ready',
			'POST /auth/register',
			'POST /auth/login',
			'POST /auth/logout',
			'GET /users/me',
			'GET /auth/google',
			'GET /api/auth/callback/google',
			'POST /api/auth/sign-up/email',
			'POST /api/auth/sign-in/email',
			'POST /api/auth/sign-out',
			'GET /api/auth/get-session',
			'POST /api/auth/request-password-reset',
		])
	} finally {
		server.kill('SIGTERM')
		if (server.exitCode === null) await once(server, 'exit')
		await new Promise<void>((resolve) => smtp.close(resolve))
		rmSync(temp, { recursive: true, force: true })
	}

	const disabledTemp = mkdtempSync(join(tmpdir(), 'silverbox-auth-disabled-'))
	const disabledURL = 'http://127.0.0.1:18004'
	const disabledEnv: NodeJS.ProcessEnv = {
		...serverEnv,
		PORT: '18004',
		BETTER_AUTH_URL: disabledURL,
		STORAGE_ROOT: disabledTemp,
	}
	for (const key of [
		'SMTP_HOST',
		'SMTP_PORT',
		'SMTP_USER',
		'SMTP_PASSWORD',
		'SMTP_SECURE',
		'MAIL_FROM',
	])
		disabledEnv[key] = ''
	delete disabledEnv.NODE_EXTRA_CA_CERTS
	const disabledServer = spawn(process.execPath, ['dist/server.js'], {
		cwd: process.cwd(),
		env: disabledEnv,
		stdio: 'ignore',
	})
	try {
		await waitForServer(disabledServer, disabledURL)
		const disabled = await fetch(`${disabledURL}/api/auth/request-password-reset`, {
			method: 'POST',
			headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: 'user@example.com' }),
		})
		assert.equal(disabled.status, 400)
		assert.equal((await disabled.json()).code, 'RESET_PASSWORD_DISABLED')
	} finally {
		disabledServer.kill('SIGTERM')
		if (disabledServer.exitCode === null) await once(disabledServer, 'exit')
		rmSync(disabledTemp, { recursive: true, force: true })
	}
})

test('invalid auth and database configuration fails with readable errors', () => {
	const result = spawnSync(process.execPath, ['dist/server.js'], {
		cwd: process.cwd(),
		env: {
			...process.env,
			DATABASE_URL: 'not-a-url',
			BETTER_AUTH_SECRET: 'short',
		},
		encoding: 'utf8',
	})
	assert.equal(result.status, 1)
	assert.match(result.stderr, /DATABASE_URL: Invalid URL/)
	assert.match(result.stderr, /BETTER_AUTH_SECRET must be at least 32 characters/)
	assert.doesNotMatch(result.stderr, /TypeError|ERR_INVALID_URL/)
})
