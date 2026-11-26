import { z } from 'zod'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

const emptyToUndefined = (value: unknown) =>
	typeof value === 'string' && value.trim() === '' ? undefined : value

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
		SMTP_HOST: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
		SMTP_PORT: z.preprocess(
			emptyToUndefined,
			z.coerce.number().int().min(1).max(65535).optional(),
		),
		SMTP_USER: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
		SMTP_PASSWORD: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
		SMTP_SECURE: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).optional()),
		MAIL_FROM: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),

		BILLING_MODE: z.enum(['disabled', 'sandbox']).default('disabled'),
		ASAAS_API_KEY: z.string().trim().optional(),
		ASAAS_WEBHOOK_TOKEN: z.string().trim().optional(),
		BILLING_RETURN_ORIGIN: z.string().trim().optional(),
		BILLING_PUBLIC_RETURN_ORIGIN: z.string().trim().optional(),
		BILLING_MAX_CHARGE_CENTS: z.string().trim().optional(),

		LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
		STORAGE_ROOT: z
			.string()
			.refine(isAbsolute, 'STORAGE_ROOT must be an absolute path')
			.optional(),
		STORAGE_MAX_BYTES: z.coerce.bigint().positive().optional(),
		STORAGE_MIN_FREE_BYTES: z.coerce.bigint().nonnegative().default(104857600n),
		STORAGE_MIN_FREE_PERCENT: z.coerce.number().min(0).max(100).default(0),
		STORAGE_MIN_FREE_INODES: z.coerce.bigint().nonnegative().default(1024n),
		STORAGE_MAX_TRANSFERS: z.coerce.number().int().positive().default(4),
		STORAGE_MAX_USER_TRANSFERS: z.coerce.number().int().positive().default(2),
		CORS_ALLOW_ALL_ORIGINS: z
			.enum(['true', 'false'])
			.default('false')
			.transform((v) => v === 'true'),
		FRONTEND_ORIGINS: z
			.string()
			.default('http://localhost:5173,http://localhost:3000')
			.transform((value) =>
				value
					.split(',')
					.map((origin) => origin.trim())
					.filter(Boolean),
			)
			.pipe(
				z.array(
					z.url().refine((value) => {
						const url = new URL(value)
						return /^https?:$/.test(url.protocol) && url.origin === value
					}, 'Use an HTTP(S) origin without a trailing slash'),
				),
			),
		MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(1073741824).default(1073741824),
	})
	.refine((value) => Boolean(value.GOOGLE_CLIENT_ID) === Boolean(value.GOOGLE_CLIENT_SECRET), {
		message: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together',
		path: ['GOOGLE_CLIENT_ID'],
	})
	.superRefine((value, context) => {
		const smtpKeys = [
			'SMTP_HOST',
			'SMTP_PORT',
			'SMTP_USER',
			'SMTP_PASSWORD',
			'SMTP_SECURE',
			'MAIL_FROM',
		] as const
		const smtpIsPartiallyConfigured = smtpKeys.some((key) => value[key] !== undefined)
		if (smtpIsPartiallyConfigured && smtpKeys.some((key) => value[key] === undefined))
			context.addIssue({
				code: 'custom',
				path: ['SMTP_HOST'],
				message:
					'SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_SECURE and MAIL_FROM must be set together',
			})

		if (value.BILLING_MODE === 'sandbox') {
			if (!value.ASAAS_API_KEY) context.addIssue({
				code: 'custom', path: ['ASAAS_API_KEY'], message: 'Required in Sandbox mode',
			})
			if (!value.ASAAS_WEBHOOK_TOKEN || value.ASAAS_WEBHOOK_TOKEN.length < 32 ||
				value.ASAAS_WEBHOOK_TOKEN === value.ASAAS_API_KEY) context.addIssue({
				code: 'custom', path: ['ASAAS_WEBHOOK_TOKEN'], message: 'Use a dedicated token of at least 32 characters',
			})
			const origin = URL.parse(value.BILLING_RETURN_ORIGIN ?? '')
			if (!origin || origin.origin !== value.BILLING_RETURN_ORIGIN ||
				(origin.protocol !== 'https:' && !(origin.protocol === 'http:' && origin.hostname === 'localhost'))) {
				context.addIssue({
					code: 'custom', path: ['BILLING_RETURN_ORIGIN'], message: 'Use an HTTPS origin or an HTTP localhost origin',
				})
			}
			if (value.BILLING_PUBLIC_RETURN_ORIGIN) {
				const publicOrigin = URL.parse(value.BILLING_PUBLIC_RETURN_ORIGIN)
				if (publicOrigin?.protocol !== 'https:' || publicOrigin.origin !== value.BILLING_PUBLIC_RETURN_ORIGIN) {
					context.addIssue({
						code: 'custom', path: ['BILLING_PUBLIC_RETURN_ORIGIN'], message: 'Use an HTTPS origin without a path or trailing slash',
					})
				}
			}
			const limit = value.BILLING_MAX_CHARGE_CENTS ?? ''
			if (!/^\d+$/.test(limit) || !Number.isSafeInteger(Number(limit)) || Number(limit) < 1) {
				context.addIssue({
					code: 'custom', path: ['BILLING_MAX_CHARGE_CENTS'], message: 'Use the Sandbox account charge limit in cents',
				})
			}
		}
		if (value.NODE_ENV === 'production') {
			for (const key of ['STORAGE_ROOT', 'STORAGE_MAX_BYTES'] as const) {
				if (value[key] === undefined)
					context.addIssue({
						code: 'custom',
						path: [key],
						message: `${key} is required in production`,
					})
			}
		}
		if (value.STORAGE_MAX_USER_TRANSFERS > value.STORAGE_MAX_TRANSFERS)
			context.addIssue({
				code: 'custom',
				path: ['STORAGE_MAX_USER_TRANSFERS'],
				message: 'Cannot exceed STORAGE_MAX_TRANSFERS',
			})
	})
	.transform((value) => ({
		...value,
		SMTP_SECURE: value.SMTP_SECURE === undefined ? undefined : value.SMTP_SECURE === 'true',
		BILLING_MAX_CHARGE_CENTS: value.BILLING_MODE === 'sandbox' ? Number(value.BILLING_MAX_CHARGE_CENTS) : undefined,
		STORAGE_ROOT: value.STORAGE_ROOT ?? resolve(process.cwd(), '.data'),
		STORAGE_MAX_BYTES: value.STORAGE_MAX_BYTES ?? 10737418240n,
	}))

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
