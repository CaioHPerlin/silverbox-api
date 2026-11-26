import express, {
  type Application,
  type NextFunction,
  type Request,
  type Response,
} from 'express'
import swaggerUi from 'swagger-ui-express'
import { toNodeHandler } from 'better-auth/node'
import { ZodError } from 'zod'

import { swaggerSpec } from './config/swagger.js'
import { env } from './config/env.js'
import { billing } from './lib/billing/runtime.js'
import { createPaymentRouters } from './routes/plans.js'
import { auth } from './lib/auth.js'
import { HttpError } from './lib/file-service.js'
import { prisma } from './lib/prisma.js'
import { storage } from './lib/storage.js'
import { corsMiddleware } from './middleware/cors.js'
import {
  errorHandler,
  notFoundHandler,
} from './middleware/error-handler.js'
import { loggerMiddleware } from './middleware/logger.js'
import { authRouter, usersRouter } from './routes/auth.js'
import { adminRouter, nativeAdminRouter } from './routes/admin.js'
import { avatarRouter } from './routes/avatar.js'
import {
  filesRouter,
  foldersRouter,
  searchRouter,
  sharesRouter,
  storageRouter,
} from './routes/files.js'

export function createApp(paymentService = billing): Application {
  const app = express()

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

  app.use('/api/auth/admin', nativeAdminRouter)
  app.all('/api/auth/*splat', toNodeHandler(auth))
  const paymentRouters = createPaymentRouters(paymentService, [
    new URL(env.BETTER_AUTH_URL).origin,
    ...env.FRONTEND_ORIGINS,
  ])
  app.use('/plans', paymentRouters.plans)
  app.use('/webhooks', paymentRouters.webhooks)
  app.use(express.json())

  app.use('/auth', authRouter)
  app.use('/users/me/avatar', avatarRouter)
  app.use('/users', usersRouter)
  app.use('/admin', adminRouter)
  app.use('/folders', foldersRouter)
  app.use('/files', filesRouter)
  app.use('/search', searchRouter)
  app.use('/shares', sharesRouter)
  app.use('/storage', storageRouter)

  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      swaggerOptions: { withCredentials: true },
    }),
  )

  app.get('/', (_req, res) => {
    res.json({ message: 'Hello, World' })
  })

  app.get('/docs.json', (_req, res) => {
    res.json(swaggerSpec)
  })

  // Os handlers ficam depois de todas as rotas.
  app.use(notFoundHandler)

  // Preserva os casos da main; demais erros seguem para o handler centralizado.
  app.use(
    (error: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) {
        next(error)
        return
      }

      if (error instanceof HttpError) {
        if (error.status === 429) {
          res.setHeader('Retry-After', '1')
        }
        res.status(error.status).json({ error: error.message, code: error.code })
        return
      }

      if (
        error instanceof SyntaxError &&
        'status' in error &&
        error.status === 400
      ) {
        res.status(400).json({ error: 'Invalid JSON' })
        return
      }

      if (error instanceof Error && 'type' in error) {
        if (error.type === 'entity.too.large') {
          res.status(413).json({ error: 'Request body is too large' })
          return
        }
        if (error.type === 'encoding.unsupported') {
          res.status(415).json({ error: 'Unsupported content encoding' })
          return
        }
      }

      if (error instanceof ZodError) {
        res.status(400).json({
          error: 'Invalid request',
          issues: error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        })
        return
      }

      next(error)
    },
  )

  app.use(errorHandler)

  return app
}
