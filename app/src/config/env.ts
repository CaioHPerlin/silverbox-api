import { z } from 'zod'
import { existsSync } from 'node:fs'

if (existsSync('.env')) {
	process.loadEnvFile()
}

const envSchema = z.object({
	NODE_ENV: z.enum(['development', 'production']).default('development'),

	PORT: z.coerce.number().int().positive().default(8000),

	DATABASE_URL: z
		.string()
		.min(1, 'DATABASE_URL is required')
		.refine((v) => v.startsWith('postgres'), 'DATABASE_URL must start with postgresql://'),

	LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
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
