import { randomUUID } from 'node:crypto';
import { pinoHttp, stdSerializers, type Options } from 'pino-http';
import { env } from '../config/env.js';

const logLevel = env.LOG_LEVEL;

const options: Options = {
	level: logLevel,
	genReqId: (req, res) => {
		const id = randomUUID();
		res.setHeader('x-request-id', id);
		return id;
	},
	customProps: (req) => ({
		reqId: String(req.id),
	}),
	customLogLevel: (req, res, err) => {
		if (res.statusCode >= 500 || err) return 'error';
		if (res.statusCode >= 400) return 'warn';
		return 'info';
	},
	customSuccessMessage: () => 'request completed',
	customErrorMessage: (_req, _res, err) => `request failed: ${err?.message ?? 'unknown error'}`,
	serializers: {
		req: (req) => {
			const r = req as unknown as {
				id: string;
				method: string;
				path: string;
				headers: Record<string, string | undefined>;
				ip: string;
				socket?: { remotePort?: number };
			};
			return {
				id: r.id,
				method: r.method,
				path: r.path,
				headers: {
					'user-agent': r.headers['user-agent'],
					'content-type': r.headers['content-type'],
				},
				remoteAddress: r.ip,
				remotePort: r.socket?.remotePort,
			};
		},
		res: (res) => ({
			statusCode: res.statusCode,
		}),
		err: stdSerializers.err,
	},
	autoLogging: {
		ignore: (req) => {
			const r = req as unknown as { path: string };
			return r.path === '/health' || r.path === '/favicon.ico';
		},
	},
};

export const loggerMiddleware = pinoHttp(options);
