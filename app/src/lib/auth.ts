import { betterAuth } from 'better-auth'
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
		resetPasswordTokenExpiresIn: 3600,
		...(smtpConfigured
			? {
					sendResetPassword: async ({ user, url }) => {
						void sendEmail({
							to: user.email,
							subject: 'Reset your Silverbox password',
							text: `Hello ${user.name},\n\nUse this link to reset your Silverbox password. It expires in one hour.\n\n${url}\n`,
						}).catch(() => {
							console.error('[MAIL] Password reset email delivery failed')
						})
					},
				}
			: {}),
	},
	rateLimit: { enabled: env.NODE_ENV !== 'development' },
	advanced: {
		database: { generateId: 'serial' },
		disableOriginCheck: false,
		ipAddress: { ipAddressHeaders: ['x-real-ip'] },
	},
	plugins: [admin({ schema: { user: { fields: { role: 'userRole' } } } })],
	//The admin plugin is only used for roles. Switch off its ban and impersonation endpoints.
	disabledPaths: [
		'/admin/ban-user',
		'/admin/unban-user',
		'/admin/impersonate-user',
		'/admin/stop-impersonating',
	],
	socialProviders:
		env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
			? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
			: {},
})
