import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SMTPServer, type SMTPServerOptions } from 'smtp-server'
import { generate } from 'selfsigned'

const configEnv = {
	DATABASE_URL: 'postgresql://silverbox:local@127.0.0.1:5432/silverbox',
	BETTER_AUTH_URL: 'http://localhost:8000',
	BETTER_AUTH_SECRET: 'test-secret-with-at-least-thirty-two-characters',
	NODE_ENV: 'test',
}

async function runMailer(
	env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; output: string }> {
	const child = spawn(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			"const { sendEmail } = await import('./dist/lib/email.js'); await sendEmail({ to: 'recipient@example.net', subject: 'Password reset', text: 'Reset link: https://example.net/reset-password/test-token' })",
		],
		{ cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] },
	)
	let output = ''
	child.stdout.on('data', (data) => (output += data.toString()))
	child.stderr.on('data', (data) => (output += data.toString()))
	const [code] = await once(child, 'close')
	return { status: code as number | null, output }
}

async function createSmtpServer(
	key: string,
	cert: string,
	options: { secure?: boolean; disableSTARTTLS?: boolean; rejectAuth?: boolean } = {},
) {
	const messages: string[] = []
	const secureSessions: boolean[] = []
	const smtp = new SMTPServer({
		key,
		cert,
		secure: options.secure ?? false,
		disabledCommands: options.disableSTARTTLS ? ['STARTTLS'] : undefined,
		disableReverseLookup: true,
		onAuth(auth, session, callback) {
			secureSessions.push(session.secure)
			if (
				options.rejectAuth ||
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
	} satisfies SMTPServerOptions)
	const listening = once(smtp.server, 'listening')
	smtp.listen(0, '127.0.0.1')
	await listening
	const address = smtp.server.address()
	assert.ok(address && typeof address !== 'string')
	return { smtp, port: address.port, messages, secureSessions }
}

function mailerEnv(port: number, secure: boolean, caPath?: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...configEnv,
		SMTP_HOST: '127.0.0.1',
		SMTP_PORT: String(port),
		SMTP_USER: 'smtp-user',
		SMTP_PASSWORD: 'smtp-password',
		SMTP_SECURE: String(secure),
		MAIL_FROM: 'Silverbox <no-reply@example.net>',
	}
	if (caPath) env.NODE_EXTRA_CA_CERTS = caPath
	else delete env.NODE_EXTRA_CA_CERTS
	return env
}

test('SMTP mailer sends over verified STARTTLS and direct TLS', async () => {
	const temp = mkdtempSync(join(tmpdir(), 'silverbox-smtp-'))
	let startTls: Awaited<ReturnType<typeof createSmtpServer>> | undefined
	let directTls: Awaited<ReturnType<typeof createSmtpServer>> | undefined
	try {
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
		startTls = await createSmtpServer(certificate.private, certificate.cert)
		directTls = await createSmtpServer(certificate.private, certificate.cert, { secure: true })

		const startTlsResult = await runMailer(mailerEnv(startTls.port, false, caPath))
		assert.equal(startTlsResult.status, 0, startTlsResult.output)
		assert.equal(startTls.messages.length, 1)
		assert.match(startTls.messages[0]!, /https:\/\/example\.net\/reset-password\/test-token/)
		assert.deepEqual(startTls.secureSessions, [true])

		const directTlsResult = await runMailer(mailerEnv(directTls.port, true, caPath))
		assert.equal(directTlsResult.status, 0, directTlsResult.output)
		assert.equal(directTls.messages.length, 1)
		assert.deepEqual(directTls.secureSessions, [true])
	} finally {
		for (const server of [startTls, directTls])
			if (server) await new Promise<void>((resolve) => server.smtp.close(resolve))
		rmSync(temp, { recursive: true, force: true })
	}
})

test('SMTP mailer rejects untrusted certificates, missing STARTTLS, and rejected credentials', async () => {
	const temp = mkdtempSync(join(tmpdir(), 'silverbox-smtp-failure-'))
	const servers: Awaited<ReturnType<typeof createSmtpServer>>[] = []
	try {
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
		const untrusted = await createSmtpServer(certificate.private, certificate.cert)
		const noStartTls = await createSmtpServer(certificate.private, certificate.cert, {
			disableSTARTTLS: true,
		})
		const rejectedAuth = await createSmtpServer(certificate.private, certificate.cert, {
			rejectAuth: true,
		})
		servers.push(untrusted, noStartTls, rejectedAuth)

		const untrustedEnv = mailerEnv(untrusted.port, false)
		const untrustedResult = await runMailer(untrustedEnv)
		assert.notEqual(untrustedResult.status, 0)
		assert.equal(untrusted.messages.length, 0)

		const noStartTlsResult = await runMailer(mailerEnv(noStartTls.port, false, caPath))
		assert.notEqual(noStartTlsResult.status, 0)
		assert.equal(noStartTls.messages.length, 0)

		const rejectedAuthResult = await runMailer(mailerEnv(rejectedAuth.port, false, caPath))
		assert.notEqual(rejectedAuthResult.status, 0)
		assert.equal(rejectedAuth.messages.length, 0)

		const unavailable = await createSmtpServer(certificate.private, certificate.cert)
		await new Promise<void>((resolve) => unavailable.smtp.close(resolve))
		const unavailableResult = await runMailer(mailerEnv(unavailable.port, false, caPath))
		assert.notEqual(unavailableResult.status, 0)
	} finally {
		for (const server of servers) await new Promise<void>((resolve) => server.smtp.close(resolve))
		rmSync(temp, { recursive: true, force: true })
	}
})

test('SMTP environment is disabled when blank and rejects partial or invalid configuration', async () => {
	const baseEnv: NodeJS.ProcessEnv = {
		...process.env,
		...configEnv,
		SMTP_HOST: '',
		SMTP_PORT: '',
		SMTP_USER: '',
		SMTP_PASSWORD: '',
		SMTP_SECURE: '',
		MAIL_FROM: '',
	}
	const runConfig = (env: NodeJS.ProcessEnv) =>
		new Promise<{ status: number | null; output: string }>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				['--input-type=module', '-e', "await import('./dist/config/env.js')"],
				{ cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] },
			)
			let output = ''
			child.stdout.on('data', (data) => (output += data.toString()))
			child.stderr.on('data', (data) => (output += data.toString()))
			child.on('error', reject)
			child.on('close', (code) => resolve({ status: code, output }))
		})

	const absentEnv = { ...baseEnv }
	for (const key of [
		'SMTP_HOST',
		'SMTP_PORT',
		'SMTP_USER',
		'SMTP_PASSWORD',
		'SMTP_SECURE',
		'MAIL_FROM',
	])
		delete absentEnv[key]
	const absent = await runConfig(absentEnv)
	assert.equal(absent.status, 0, absent.output)
	const blank = await runConfig({ ...baseEnv, SMTP_HOST: '  ' })
	assert.equal(blank.status, 0, blank.output)

	const partial = await runConfig({ ...baseEnv, SMTP_HOST: 'smtp.example.net' })
	assert.equal(partial.status, 1)

	const invalidSecure = await runConfig({
		...baseEnv,
		SMTP_HOST: 'smtp.example.net',
		SMTP_PORT: '587',
		SMTP_USER: 'user',
		SMTP_PASSWORD: 'password',
		SMTP_SECURE: 'yes',
		MAIL_FROM: 'no-reply@example.net',
	})
	assert.equal(invalidSecure.status, 1)

	const validStartTls = await runConfig({
		...baseEnv,
		SMTP_HOST: 'smtp.example.net',
		SMTP_PORT: '587',
		SMTP_USER: 'user',
		SMTP_PASSWORD: 'password',
		SMTP_SECURE: 'false',
		MAIL_FROM: 'no-reply@example.net',
	})
	assert.equal(validStartTls.status, 0, validStartTls.output)
})
