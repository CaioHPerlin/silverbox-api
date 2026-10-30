import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { test } from 'node:test'
import pg from 'pg'
import { assertOperationsCovered, validateHttpContracts } from './contracts.js'

const baseURL = process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:18000'

async function waitForServer(server) {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (server.exitCode !== null) throw new Error(`API exited with code ${server.exitCode}`)
		try {
			const response = await fetch(`${baseURL}/api/auth/ok`)
			if (response.ok) return
		} catch {
			// Wait for the listener to become available.
		}
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	throw new Error('API did not start within five seconds')
}

test('auth signup, signin, session, and signout work with PostgreSQL', async () => {
	const server = spawn(process.execPath, ['dist/server.js'], {
		cwd: process.cwd(),
		env: process.env,
		stdio: 'ignore',
	})

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
		const database = new pg.Client({ connectionString: process.env.DATABASE_URL })
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
		const googleURL = new URL(google.headers.get('location'))
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
		])
	} finally {
		server.kill('SIGTERM')
		if (server.exitCode === null) await once(server, 'exit')
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
