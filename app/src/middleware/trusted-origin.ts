import type { RequestHandler } from 'express'
import { env } from '../config/env.js'

export const requireTrustedMutationOrigin: RequestHandler = (req, res, next) => {
	if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
		next()
		return
	}
	const origin = req.get('origin')
	if (
		origin === new URL(env.BETTER_AUTH_URL).origin ||
		(origin && env.FRONTEND_ORIGINS.includes(origin))
	) {
		next()
		return
	}
	res.status(403).json({ error: 'Origin is not allowed' })
}
