import { betterAuth } from 'better-auth'
import { APIError, createAuthMiddleware, getAuthoritativeSessionFromCtx } from 'better-auth/api'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { admin } from 'better-auth/plugins'
import { env } from '../config/env.js'
import { sendEmail, smtpConfigured } from './email.js'
import { maxPasswordLength, minPasswordLength, newPasswordError } from './password-policy.js'
import { passwordResetEmail, passwordResetTtlMinutes } from './passwordResetEmail.js'
import { prisma } from './prisma.js'

export const auth = betterAuth({
	database: prismaAdapter(prisma, { provider: 'postgresql' }),
	baseURL: env.BETTER_AUTH_URL,
	secret: env.BETTER_AUTH_SECRET,
	trustedOrigins: env.FRONTEND_ORIGINS,
	logger: {
		// Native diagnostics can contain callback URLs, tokens, or user data.
		log: (level) => console[level](`[AUTH] ${level}: authentication event`),
	},
	emailAndPassword: {
		enabled: true,
		minPasswordLength,
		maxPasswordLength,
		resetPasswordTokenExpiresIn: passwordResetTtlMinutes * 60,
		revokeSessionsOnPasswordReset: true,
		...(smtpConfigured
			? {
					sendResetPassword: async ({ user, url }) => {
						void sendEmail({
							to: user.email,
							...passwordResetEmail(user.name, url),
						}).catch(() => {
							console.error('[MAIL] Password reset email delivery failed')
						})
					},
				}
			: {}),
	},
	// Read current roles and revoked sessions from the database on every request.
	session: { cookieCache: { enabled: false } },
	rateLimit: { enabled: env.NODE_ENV !== 'development' },
	advanced: {
		database: { generateId: 'serial' },
		disableOriginCheck: false,
		ipAddress: { ipAddressHeaders: ['x-real-ip'] },
	},
	plugins: [admin({ schema: { user: { fields: { role: 'userRole' } } } })],
	// The product handles account mutations that need storage and administrator invariants.
	disabledPaths: [
		'/admin/ban-user',
		'/admin/set-role',
		'/admin/remove-user',
		'/admin/create-user',
		'/admin/update-user',
		'/admin/unban-user',
		'/admin/impersonate-user',
		'/admin/stop-impersonating',
	],
	hooks: {
		before: createAuthMiddleware(async (ctx) => {
			const changingPassword = ctx.path === '/change-password'
			const adminSettingPassword = ctx.path === '/admin/set-user-password'
			const signingUp = ctx.path === '/sign-up/email'
			if (signingUp || ctx.path === '/reset-password' || changingPassword || adminSettingPassword) {
				const password = signingUp ? ctx.body?.password : ctx.body?.newPassword
				const error = typeof password === 'string' ? newPasswordError(password) : null
				if (error) {
					if (!changingPassword && !adminSettingPassword) throw new APIError('BAD_REQUEST', error)

					// Preserve the endpoint's authorization error for requests that cannot change passwords.
					const session = await getAuthoritativeSessionFromCtx(ctx)
					const role = (session?.user as { role?: string | null } | undefined)?.role
					if (session && (!adminSettingPassword || role?.split(',').includes('admin')))
						throw new APIError('BAD_REQUEST', error)
				}
			}
			if (changingPassword)
				return { context: { body: { revokeOtherSessions: true } } }
			if (['/sign-up/email', '/update-user'].includes(ctx.path) && ctx.body?.image !== undefined)
				throw new APIError('BAD_REQUEST', {
					message: 'Use /users/me/avatar to change your profile image',
				})
		}),
	},
	socialProviders:
		env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
			? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
			: {},
})
