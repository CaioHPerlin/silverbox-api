import { randomUUID } from 'node:crypto'
import { pinoHttp, type Options } from 'pino-http'
import { env } from '../config/env.js'

const logLevel = env.LOG_LEVEL

function safeRequestPath(url: string | undefined): string | undefined {
	if (!url) return undefined
	const pathname = url.split('?', 1)[0] ?? url
	if (pathname.startsWith('/shares/')) return '/shares/[redacted]'
	return pathname.replace(/(\/(?:api\/auth\/)?reset-password\/)[^/]+/i, '$1[redacted]')
}

const options: Options = {
	level: logLevel,
	genReqId: (req, res) => {
		const id = randomUUID()
		res.setHeader('x-request-id', id)
		return id
	},
	customProps: (req) => ({
		reqId: String(req.id),
	}),
	customLogLevel: (req, res, err) => {
		if (res.statusCode >= 500 || err) return 'error'
		if (res.statusCode >= 400) return 'warn'
		return 'info'
	},
	customSuccessMessage: () => 'request completed',
	customErrorMessage: () => 'request failed',
	serializers: {
		req: (req) => {
			const r = req as unknown as {
				id: string
				method: string
				url?: string
				headers: Record<string, string | undefined>
				remoteAddress?: string
				remotePort?: number
			}
			return {
				id: r.id,
				method: r.method,
				path: safeRequestPath(r.url),
				headers: {
					'user-agent': r.headers['user-agent'],
					'content-type': r.headers['content-type'],
				},
				remoteAddress: r.remoteAddress,
				remotePort: r.remotePort,
			}
		},
		res: (res) => ({
			statusCode: res.statusCode,
		}),
		err: (err) => ({ type: err?.name ?? 'Error' }),
	},
	autoLogging: {
		ignore: (req) => {
			const r = req as unknown as { path: string }
			return r.path === '/health' || r.path === '/favicon.ico'
		},
	},
}

export const loggerMiddleware = pinoHttp(options)
