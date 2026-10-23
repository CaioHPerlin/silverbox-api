import type { ErrorRequestHandler, RequestHandler } from 'express'
import { ZodError } from 'zod'
import { env } from '../config/env.js'
import { AppError, NotFoundError, PayloadTooLargeError } from '../errors/index.js'
import { HttpError } from '../lib/errors.js'

type ErrorBody = {
	error: string
	details?: unknown
	// Compatibilidade com o formato que a main já usa para Zod.
	issues?: unknown
}

/** Erros do express.json/body-parser: códigos públicos sem ecoar o corpo da requisição. */
function parseBodyError(err: unknown): AppError | undefined {
	if (!(err instanceof Error)) return undefined

	const httpError = err as Error & {
		status?: unknown
		statusCode?: unknown
		type?: unknown
		expose?: unknown
	}
	const status = httpError.status ?? httpError.statusCode

	if (
		typeof httpError.type !== 'string' ||
		httpError.expose !== true ||
		typeof status !== 'number' ||
		!Number.isInteger(status) ||
		status < 400 ||
		status >= 500
	) {
		return undefined
	}

	if (status === 413) {
		return new PayloadTooLargeError('Corpo da requisição muito grande')
	}
	if (status === 400 && httpError.type === 'entity.parse.failed') {
		return new AppError('JSON inválido no corpo da requisição', 400)
	}
	if (status === 415) {
		return new AppError('Formato ou codificação do corpo não suportado', 415)
	}
	if (status === 403) {
		return new AppError('Corpo da requisição não permitido', 403)
	}

	return new AppError('Requisição inválida', status)
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
	next(new NotFoundError(`Rota ${req.method} ${req.path} não encontrada`))
}

/** Express 5 encaminha exceções lançadas em handlers async para este middleware. */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
	if (res.headersSent) {
		next(err)
		return
	}

	if (err instanceof ZodError) {
		const issues = err.issues.map((issue) => ({ path: issue.path, message: issue.message }))
		const body: ErrorBody = {
			error: 'Dados inválidos',
			details: issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
			issues,
		}
		res.status(400).json(body)
		return
	}

	// Mantém a compatibilidade com os HttpError da main (inclui 429, 503 e 507).
	if (err instanceof HttpError && err.status === 429) {
		res.setHeader('Retry-After', '1')
	}
	const appError =
		err instanceof AppError
			? err
			: err instanceof HttpError
				? new AppError(err.message, err.status)
				: parseBodyError(err)

	if (appError) {
		const isServerError = appError.statusCode >= 500
		if (isServerError) {
			req.log.error({ err, cause: appError.cause }, 'server error')
		}

		const hideDetails = isServerError && env.NODE_ENV === 'production'
		const body: ErrorBody = {
			error: hideDetails ? 'Erro interno do servidor' : appError.message,
		}
		if (!hideDetails && appError.details !== undefined) {
			body.details = appError.details
		}
		res.status(appError.statusCode).json(body)
		return
	}

	// Compatibilidade com SyntaxError que contêm body, mas não vêm tipados pelo parser.
	if (err instanceof SyntaxError && 'body' in err) {
		res.status(400).json({ error: 'JSON inválido no corpo da requisição' } satisfies ErrorBody)
		return
	}

	req.log.error({ err }, 'unhandled error')
	const body: ErrorBody = { error: 'Erro interno do servidor' }
	if (env.NODE_ENV !== 'production' && err instanceof Error) {
		body.details = { message: err.message, stack: err.stack }
	}
	res.status(500).json(body)
}
