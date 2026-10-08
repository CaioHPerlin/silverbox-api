import express, { type Application } from 'express'
import { loggerMiddleware } from './middleware/logger.js'
import swaggerUi from 'swagger-ui-express'
import { toNodeHandler } from 'better-auth/node'
import { swaggerSpec } from './config/swagger.js'
import { auth } from './lib/auth.js'
import { authRouter, usersRouter } from './routes/auth.js'

export function createApp(): Application {
	const app = express()

	// Middleware
	app.set('trust proxy', 1)
	app.use(loggerMiddleware)
	app.disable('x-powered-by')
	app.all('/api/auth/*splat', toNodeHandler(auth))
	app.use(express.json())
	app.use('/auth', authRouter)
	app.use('/users', usersRouter)

	app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec))

	// Routes
	app.get('/', (_, res) => {
		res.json({ message: 'Hello, World' })
	})

	app.get('/docs.json', (_req, res) => {
		res.json(swaggerSpec)
	})

	return app
}
