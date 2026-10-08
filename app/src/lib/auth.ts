import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { env } from '../config/env.js'
import { prisma } from './prisma.js'

export const auth = betterAuth({
	database: prismaAdapter(prisma, { provider: 'postgresql' }),
	baseURL: env.BETTER_AUTH_URL,
	secret: env.BETTER_AUTH_SECRET,
	emailAndPassword: { enabled: true },
	advanced: { database: { generateId: 'serial' } },
	socialProviders:
		env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
			? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
			: {},
})
