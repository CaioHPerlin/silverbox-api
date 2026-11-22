import { betterAuth } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { admin } from 'better-auth/plugins'
import { env } from '../config/env.js'
import { sendEmail, smtpConfigured } from './email.js'
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
		resetPasswordTokenExpiresIn: 15 * 60,
		revokeSessionsOnPasswordReset: true,
		...(smtpConfigured
			? {
					sendResetPassword: async ({ user, url }) => {
						void sendEmail({
							to: user.email,
							subject: 'Reset your Silverbox password',
							text: `Hello ${user.name},\n\nUse this link to reset your Silverbox password. It expires in 15 minutes.\n\n${url}\n`,
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
			if (ctx.path === '/change-password')
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
