import { z } from 'zod'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

if (existsSync('.env')) {
	process.loadEnvFile()
}

const envSchema = z
	.object({
		NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

		PORT: z.coerce.number().int().min(1).max(65535).default(8000),

		DATABASE_URL: z
			.url()
			.refine(
				(value) => /^postgres(?:ql)?:\/\//.test(value),
				'DATABASE_URL must use PostgreSQL',
			),
		BETTER_AUTH_URL: z.url().refine((value) => {
			const url = new URL(value)
			return /^https?:$/.test(url.protocol) && url.pathname === '/' && !url.search && !url.hash
		}, 'BETTER_AUTH_URL must be an HTTP(S) origin without path, query or hash'),
		BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
		GOOGLE_CLIENT_ID: z.string().optional(),
		GOOGLE_CLIENT_SECRET: z.string().optional(),

		LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
		STORAGE_ROOT: z
			.string()
			.refine(isAbsolute, 'STORAGE_ROOT must be an absolute path')
			.default(resolve(process.cwd(), '.data')),
		MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(1073741824).default(1073741824),
	})
	.refine((value) => Boolean(value.GOOGLE_CLIENT_ID) === Boolean(value.GOOGLE_CLIENT_SECRET), {
		message: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together',
		path: ['GOOGLE_CLIENT_ID'],
	})

function loadEnv() {
	const result = envSchema.safeParse(process.env)

	if (!result.success) {
		console.error('Invalid or missing environment variables:\n')
		for (const issue of result.error.issues) {
			console.error(`  - ${issue.path.join('.')}: ${issue.message}`)
		}
		console.error('\nCheck your .env file (see .env.example) and try again.')
		process.exit(1)
	}

	return result.data
}

export const env = loadEnv()
export type Env = typeof env
