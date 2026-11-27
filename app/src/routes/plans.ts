import { Router, json, type ErrorRequestHandler } from 'express'
import { ZodError } from 'zod'
import { env } from '../config/env.js'
import { checkoutReturnStatuses, checkoutReturnUrl, publicCheckoutReturnPath } from '../lib/billing/asaas.js'
import { pricingCatalog } from '../lib/billing/catalog.js'
import type { BillingService } from '../lib/billing/service.js'
import { checkoutSchema, idempotencyKeySchema, purchaseIdSchema } from '../lib/billing/validation.js'
import { HttpError } from '../lib/errors.js'
import { currentUser, requireAuth } from '../middleware/auth.js'

// Express's JSON parser attaches the submitted body to some errors.
const billingError: ErrorRequestHandler = (error, req, res, next) => {
	if (res.headersSent) return next(error)
	if (error instanceof HttpError || error instanceof ZodError) return next(error)
	if (error?.type === 'entity.parse.failed') {
		res.status(400).json({ error: 'JSON inválido.' })
		return
	}
	if (error?.type === 'entity.too.large') {
		res.status(413).json({ error: 'Corpo da requisição muito grande.' })
		return
	}
	if (error?.status === 415) {
		res.status(415).json({ error: 'Formato de requisição não aceito.' })
		return
	}
	req.log.error('Billing request failed')
	res.status(500).json({ error: 'Erro interno do servidor.' })
}

export function createPaymentRouters(service: BillingService, allowedOrigins: readonly string[]) {
	const plans = Router()
	const webhooks = Router()

	plans.get('/', (_req, res) => {
		res.setHeader('Cache-Control', 'public, max-age=60')
		res.json(pricingCatalog(service.mode, env.MAX_UPLOAD_BYTES))
	})
	plans.get(publicCheckoutReturnPath, (req, res) => {
		const origin = service.checkoutReturnFrontendOrigin
		if (!origin) throw new HttpError(404, 'Retorno público do checkout desabilitado.')
		const id = purchaseIdSchema.safeParse(req.query.purchaseId)
		const status = checkoutReturnStatuses.find((value) => value === req.query.checkout)
		if (!id.success || !status) throw new HttpError(400, 'Retorno do checkout inválido.')
		res.setHeader('Cache-Control', 'no-store')
		res.setHeader('Referrer-Policy', 'no-referrer')
		res.redirect(checkoutReturnUrl(origin, id.data, status))
	})
	plans.post('/checkout', requireAuth, (req, res, next) => {
		res.setHeader('Cache-Control', 'no-store')
		const origin = req.get('Origin')
		if (origin !== undefined && !allowedOrigins.includes(origin)) {
			throw new HttpError(403, 'Origem não autorizada para cobrança.')
		}
		next()
	}, json({ limit: '8kb' }), async (req, res) => {
		const selection = checkoutSchema.parse(req.body)
		const key = idempotencyKeySchema.safeParse(req.get('Idempotency-Key'))
		if (!key.success) throw new HttpError(400, 'Informe um cabeçalho Idempotency-Key válido.')
		const result = await service.start(currentUser(res).id, key.data, selection)
		res.status(result.status).json(result.body)
	})
	plans.get('/purchases/:id', requireAuth, async (req, res) => {
		res.setHeader('Cache-Control', 'no-store')
		const id = purchaseIdSchema.safeParse(req.params.id)
		if (!id.success) throw new HttpError(404, 'Compra não encontrada.')
		res.json(await service.getPurchase(currentUser(res).id, id.data))
	})

	webhooks.post('/asaas', (req, res, next) => {
		res.setHeader('Cache-Control', 'no-store')
		service.verifyWebhook(req.get('asaas-access-token'))
		next()
	}, json({ limit: '64kb' }), async (req, res) => {
		await service.saveEvent(req.body)
		res.status(200).json({ received: true })
	})

	plans.use(billingError)
	webhooks.use(billingError)
	return { plans, webhooks }
}
