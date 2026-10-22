import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { validateHttpContracts } from '../contracts.js'

const project = `silverbox-e2e-${randomUUID().slice(0, 8)}`
const baseURL = 'http://localhost:8000'
function command(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
		let output = ''
		child.stdout.on('data', (data) => {
			output = (output + data.toString()).slice(-12000)
		})
		child.stderr.on('data', (data) => {
			output = (output + data.toString()).slice(-12000)
		})
		child.on('error', reject)
		child.on('exit', (code) =>
			code === 0
				? resolve(output)
				: reject(new Error(`docker ${args.join(' ')} exited ${code}:\n${output}`)),
		)
	})
}
const compose = (...args: string[]) =>
	command(['compose', '--env-file', '/dev/null', '--project-name', project, ...args])

test(
	'a clean Docker Compose starts without .env, runs non-root, and preserves sessions and bytes across container replacement',
	{ timeout: 300000 },
	async () => {
		try {
			await compose('up', '--build', '-d', '--wait')
			assert.equal((await fetch(`${baseURL}/health/ready`)).status, 200)
			await validateHttpContracts(baseURL)
			assert.equal((await fetch(`${baseURL}/docs`)).status, 200)
			const signup = await fetch(`${baseURL}/auth/register`, {
				method: 'POST',
				headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: 'Docker Front',
					email: `${randomUUID()}@example.com`,
					password: 'correct-horse-battery-staple',
				}),
			})
			assert.equal(signup.status, 200)
			const cookie = signup.headers.get('set-cookie')!.split(';')[0]!
			const upload = await fetch(`${baseURL}/files`, {
				method: 'POST',
				headers: {
					Origin: 'http://localhost:5173',
					Cookie: cookie,
					'Content-Type': 'application/octet-stream',
					'X-File-Name': 'docker.txt',
					'X-File-Size': '5',
					'X-File-Mime': 'text/plain',
				},
				body: 'hello',
			})
			assert.equal(upload.status, 201)
			const file = (await upload.json()).file
			assert.equal((await compose('exec', '-T', 'api', 'id', '-u')).trim(), '1000')
			assert.equal(
				(
					await compose('exec', '-T', 'api', 'stat', '-c', '%u %a', '/var/lib/silverbox/files')
				).trim(),
				'1000 700',
			)
			const modes = await compose(
				'exec',
				'-T',
				'api',
				'find',
				'/var/lib/silverbox/files/objects',
				'-type',
				'f',
				'-exec',
				'stat',
				'-c',
				'%u %a',
				'{}',
				';',
			)
			assert.equal(modes.trim(), '1000 600')
			await assert.rejects(
				compose('run', '--rm', '--no-deps', '--user', '65534', 'api', 'node', 'dist/server.js'),
				/ownership must match/,
			)
			await assert.rejects(
				compose(
					'run',
					'--rm',
					'--no-deps',
					'--user',
					'0',
					'-e',
					'NODE_ENV=production',
					'api',
					'node',
					'dist/server.js',
				),
				/must not run as root/,
			)
			await compose('up', '-d', '--force-recreate', '--no-deps', '--wait', 'api')
			assert.equal(
				(await fetch(`${baseURL}/users/me`, { headers: { Cookie: cookie } })).status,
				200,
			)
			assert.equal(
				await (
					await fetch(`${baseURL}/files/${file.id}/download`, { headers: { Cookie: cookie } })
				).text(),
				'hello',
			)
			const disabledGoogle = await fetch(`${baseURL}/auth/google`, { redirect: 'manual' })
			assert.equal(disabledGoogle.status, 400)
		} finally {
			await compose('down', '--volumes', '--remove-orphans')
		}
	},
)
