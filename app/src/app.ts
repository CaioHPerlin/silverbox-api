import express, { type Application } from 'express'
import { loggerMiddleware } from './middleware/logger.js'
import swaggerUi from 'swagger-ui-express'
import { toNodeHandler } from 'better-auth/node'
import { swaggerSpec } from './config/swagger.js'
import { auth } from './lib/auth.js'
import { authRouter, usersRouter } from './routes/auth.js'
import { filesRouter, foldersRouter, sharesRouter, storageRouter } from './routes/files.js'
import { HttpError } from './lib/file-service.js'
import { ZodError } from 'zod'
import type { NextFunction, Request, Response } from 'express'
import { corsMiddleware } from './middleware/cors.js'
import { prisma } from './lib/prisma.js'
import { storage } from './lib/storage.js'

export function createApp(): Application {
	const app = express()

	// Middleware
	app.set('trust proxy', 1)
	app.use(loggerMiddleware)
	app.use(corsMiddleware)
	app.disable('x-powered-by')
	app.get('/health/live', (_req, res) => {
		res.json({ status: 'ok' })
	})
	app.get('/health/ready', async (_req, res) => {
		try {
			await prisma.$queryRaw`SELECT 1`
			await storage.capacity()
			res.json({ status: 'ok' })
		} catch {
			res.status(503).json({ status: 'unavailable' })
		}
	})
	app.all('/api/auth/*splat', toNodeHandler(auth))
	app.use(express.json())
	app.use('/auth', authRouter)
	app.use('/users', usersRouter)
	app.use('/folders', foldersRouter)
	app.use('/files', filesRouter)
	app.use('/shares', sharesRouter)
	app.use('/storage', storageRouter)

	app.use(
		'/docs',
		swaggerUi.serve,
		swaggerUi.setup(swaggerSpec, { swaggerOptions: { withCredentials: true } }),
	)

	// Routes
	app.get('/', (_, res) => {
		res.json({ message: 'Hello, World' })
	})

	app.get('/docs.json', (_req, res) => {
		res.json(swaggerSpec)
	})

	app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
		if (res.headersSent) return
		if (error instanceof HttpError) {
			if (error.status === 429) res.setHeader('Retry-After', '1')
			res.status(error.status).json({ error: error.message })
			return
		}
		if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
			res.status(400).json({ error: 'Invalid JSON' })
			return
		}
		if (error instanceof ZodError) {
			res.status(400).json({
				error: 'Invalid request',
				issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
			})
			return
		}
		console.error('[SERVER] Request failed:', error)
		res.status(500).json({ error: 'Internal server error' })
	})

	return app
}
