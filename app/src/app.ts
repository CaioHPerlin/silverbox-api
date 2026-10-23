import express, { type Application } from 'express'
import swaggerUi from 'swagger-ui-express'
import { toNodeHandler } from 'better-auth/node'

import { loggerMiddleware } from './middleware/logger.js'
import { corsMiddleware } from './middleware/cors.js'
import { errorHandler, notFoundHandler } from './middleware/error-handler.js'
import { swaggerSpec } from './config/swagger.js'
import { auth } from './lib/auth.js'
import { authRouter, usersRouter } from './routes/auth.js'
import { filesRouter, foldersRouter, sharesRouter, storageRouter } from './routes/files.js'
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

	// O Better Auth recebe o corpo original antes de express.json().
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

	app.get('/', (_req, res) => {
		res.json({ message: 'Hello, World' })
	})
	app.get('/docs.json', (_req, res) => {
		res.json(swaggerSpec)
	})

	// Não registrar novas rotas após esses middlewares.
	app.use(notFoundHandler)
	app.use(errorHandler)

	return app
}
