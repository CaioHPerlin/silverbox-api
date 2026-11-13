import type { RequestHandler } from 'express'
import { env } from '../config/env.js'

const allowed = new Set([env.BETTER_AUTH_URL, ...env.FRONTEND_ORIGINS])
function isHttpOrigin(value: string): boolean {
	try {
		const url = new URL(value)
		return /^https?:$/.test(url.protocol) && url.origin === value
	} catch {
		return false
	}
}

export const corsMiddleware: RequestHandler = (req, res, next) => {
	const origin = req.headers.origin
	res.vary('Origin')
	if (origin) {
		if (!allowed.has(origin) && !(env.CORS_ALLOW_ALL_ORIGINS && isHttpOrigin(origin))) {
			res.status(403).json({ error: 'Origin is not allowed' })
			return
		}
		res.setHeader('Access-Control-Allow-Origin', origin)
		res.setHeader('Access-Control-Allow-Credentials', 'true')
		res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Request-Id')
	}
	if (req.method === 'OPTIONS') {
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
		res.setHeader(
			'Access-Control-Allow-Headers',
			'Content-Type, X-File-Name, X-File-Size, X-File-Mime, X-Folder-Id',
		)
		res.setHeader('Access-Control-Max-Age', '600')
		res.status(204).end()
		return
	}
	next()
}
