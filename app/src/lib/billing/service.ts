import { createHash, timingSafeEqual } from 'node:crypto'
import type { BillingPurchase, BillingWebhookEvent, PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { HttpError } from '../errors.js'
import { AsaasError, AsaasGateway, checkoutReturnUrl, checkoutUrl, providerId, type AsaasPayment } from './asaas.js'
import { isCheckoutEnabled, priceSelection } from './catalog.js'
import { applyPayment, markReview, ReconciliationError, storeInstructions, transition } from './reconciliation.js'
import { asaasCents, asaasProvider, checkoutMinutes, isPayable, type AsaasEnvironment, type BillingMode } from './rules.js'
import { purchaseIdSchema, type CheckoutSelection } from './validation.js'

type BillingConfig = {
	environment: AsaasEnvironment
	apiKey: string
	webhookToken: string
	returnOrigin: string
	publicReturnOrigin?: string
	maxChargeCents: number
}
const checkoutEvents = {
	CHECKOUT_CREATED: 'pending',
	CHECKOUT_CANCELED: 'cancelled',
	CHECKOUT_EXPIRED: 'expired',
	CHECKOUT_PAID: 'pending',
} as const
const paymentEvents = new Set([
	'PAYMENT_CREATED', 'PAYMENT_UPDATED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED',
	'PAYMENT_DELETED', 'PAYMENT_RESTORED', 'PAYMENT_OVERDUE', 'PAYMENT_REFUNDED',
	'PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_REFUND_IN_PROGRESS', 'PAYMENT_REFUND_DENIED',
	'PAYMENT_RECEIVED_IN_CASH_UNDONE', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE',
	'PAYMENT_AWAITING_CHARGEBACK_REVERSAL', 'PAYMENT_BANK_SLIP_CANCELLED', 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED',
])
const webhookEnvelope = z.object({
	id: z.string().regex(/^[A-Za-z0-9_&.:-]{1,160}$/),
	event: z.string().regex(/^[A-Z0-9_]{1,64}$/),
	payment: z.unknown().optional(),
	checkout: z.unknown().optional(),
})
const checkoutNotice = z.object({
	id: providerId,
	externalReference: z.string().max(200).nullish(),
	billingTypes: z.array(z.string().max(64)).max(8).optional(),
	chargeTypes: z.array(z.string().max(64)).max(8).optional(),
	items: z.array(z.object({ value: z.number().nonnegative(), quantity: z.number().int().positive() })).max(100).optional(),
	callback: z.object({ successUrl: z.string().max(2048).nullish() }).nullish(),
})
type CheckoutNotice = z.infer<typeof checkoutNotice>
const checkoutEvidence = z.object({
	reference: purchaseIdSchema.nullable(),
	amountCents: z.number().int().nullable(),
	detachedCard: z.boolean(),
})

function view(purchase: BillingPurchase) {
	const { id, planCode, cycle, seats, currency, amountCents, method, environment } = purchase
	const elapsed = purchase.instructionsUntil && purchase.instructionsUntil <= new Date()
	const status = elapsed && isPayable(purchase.status) && method !== 'boleto' ? 'expired' : purchase.status
	return {
		id, planCode, cycle, seats, currency, amountCents, method, status, environment,
		...(isPayable(status) && purchase.instructions && !elapsed ? { paymentInstructions: purchase.instructions } : {}),
	}
}

function isUniqueConflict(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

function failureCode(error: unknown) {
	return error instanceof AsaasError || error instanceof ReconciliationError ? error.code : 'internal_retry'
}

const recoveryDelay = 60_000
const leaseMillis = 120_000
const later = (millis: number) => new Date(Date.now() + millis)

export class BillingService {
	readonly gateway: AsaasGateway | undefined

	constructor(
		private readonly db: PrismaClient,
		private readonly config?: BillingConfig,
		fetcher?: typeof fetch,
	) {
		if (config) this.gateway = new AsaasGateway(config.environment, config.apiKey, config.returnOrigin, fetcher, config.publicReturnOrigin)
	}

	get mode(): BillingMode {
		return this.config?.environment ?? 'disabled'
	}

	private get scope() {
		return { provider: asaasProvider, environment: this.config?.environment ?? 'sandbox' }
	}

	get checkoutReturnFrontendOrigin() {
		return this.config?.publicReturnOrigin ? this.config.returnOrigin : undefined
	}

	private purchase(id: string) {
		return this.db.billingPurchase.findUniqueOrThrow({ where: { id } })
	}

	private customer(userId: number) {
		return this.db.billingCustomer.findUnique({ where: { userId_provider_environment: { userId, ...this.scope } } })
	}

	async getPurchase(userId: number, id: string) {
		const purchase = await this.db.billingPurchase.findFirst({
			where: { id, userId, ...(this.config ? this.scope : { provider: asaasProvider }) },
		})
		if (!purchase) throw new HttpError(404, 'Compra não encontrada.')
		return view(purchase)
	}

	async start(userId: number, key: string, input: CheckoutSelection) {
		const snapshot = priceSelection(input.planCode, input.cycle, input.seats)
		if (!snapshot) throw new HttpError(400, 'Quantidade de pessoas inválida para o plano.')
		const gateway = this.gateway
		if (!this.config || !gateway) throw new HttpError(503, 'Checkout temporariamente indisponível.')
		if (!isCheckoutEnabled(input.planCode, this.mode)) throw new HttpError(422, 'Este plano ainda não está disponível para contratação.')
		if ((this.mode === 'production' || input.billingEnvironment) && input.billingEnvironment !== this.mode) {
			throw new HttpError(409, 'O ambiente de pagamento mudou. Recarregue a página de planos e tente novamente.')
		}

		const where = { userId_provider_environment_idempotencyKey: { userId, ...this.scope, idempotencyKey: key } }
		let purchase = await this.db.billingPurchase.findUnique({ where })
		let created = false
		if (!purchase) {
			if (snapshot.amountCents > this.config.maxChargeCents) {
				throw new HttpError(422, 'Valor acima do limite de cobrança da conta Asaas.')
			}
			if (input.method !== 'credit_card' && !input.payerCpf && !(await this.customer(userId))?.providerCustomerId) {
				throw new HttpError(400, 'Informe o CPF do pagador para a primeira compra com Pix ou boleto.')
			}
			try {
				const { planCode, cycle, seats, method } = input
				purchase = await this.db.billingPurchase.create({
					data: { userId, ...this.scope, idempotencyKey: key, planCode, cycle, seats, method, ...snapshot },
				})
				created = true
			} catch (error) {
				if (!isUniqueConflict(error)) throw error
				purchase = await this.db.billingPurchase.findUniqueOrThrow({ where })
			}
		}
		if (purchase.planCode !== input.planCode || purchase.cycle !== input.cycle ||
			purchase.seats !== input.seats || purchase.method !== input.method) {
			throw new HttpError(409, 'Esta chave já foi usada para outra seleção.')
		}

		try {
			if (purchase.status === 'preparing' || (isPayable(purchase.status) && !purchase.instructions) ||
				(purchase.status === 'review' && purchase.lastError === 'customer_requires_review')) {
				if (purchase.status === 'review') {
					await transition(this.db, purchase, { status: 'preparing', lastError: null })
					purchase = await this.purchase(purchase.id)
				}
				await this.resume(gateway, purchase, input.payerCpf)
			}
		} catch (error) {
			if (!(error instanceof AsaasError || error instanceof ReconciliationError)) throw error
		}

		const result = await this.purchase(purchase.id)
		const body = view(result)
		const waiting = result.status === 'preparing' || result.status === 'processing' ||
			(isPayable(result.status) && !body.paymentInstructions && !result.instructions && result.nextSyncAt !== null)
		return { status: waiting ? 202 : created && body.paymentInstructions ? 201 : 200, body }
	}

	private async resolveCustomer(gateway: AsaasGateway, userId: number, cpf?: string) {
		let customer = await this.customer(userId)
		if (!customer && !cpf) return null
		customer ??= await this.db.billingCustomer.upsert({
			where: { userId_provider_environment: { userId, ...this.scope } },
			create: { userId, ...this.scope },
			update: {},
		}).catch(async (error: unknown) => {
			if (!isUniqueConflict(error)) throw error
			return this.customer(userId)
		})
		if (!customer || customer.providerCustomerId) return customer?.providerCustomerId ?? null

		if (customer.submittedAt) {
			const external = await gateway.findCustomer(customer.id)
			if (!external) return null
			if (external.externalReference !== customer.id) throw new AsaasError('invalid_response')
			await this.db.billingCustomer.update({
				where: { id: customer.id }, data: { providerCustomerId: external.id },
			})
			return external.id
		}
		if (!cpf) return null
		const user = await this.db.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } })
		const submittedAt = new Date()
		const claim = await this.db.billingCustomer.updateMany({
			where: { id: customer.id, submittedAt: null },
			data: { submittedAt },
		})
		if (!claim.count) return null
		try {
			const external = await gateway.createCustomer(customer.id, user.name, cpf)
			if (external.externalReference && external.externalReference !== customer.id) throw new AsaasError('invalid_response')
			await this.db.billingCustomer.update({
				where: { id: customer.id }, data: { providerCustomerId: external.id },
			})
			return external.id
		} catch (error) {
			if (error instanceof AsaasError && error.code === 'rejected') {
				await this.db.billingCustomer.updateMany({
					where: { id: customer.id, submittedAt, providerCustomerId: null },
					data: { submittedAt: null },
				})
			}
			throw error
		}
	}

	private async resume(gateway: AsaasGateway, purchase: BillingPurchase, cpf?: string) {
		if (purchase.submittedAt) {
			await this.recover(gateway, purchase)
			return
		}
		let providerCustomerId: string | null = null
		if (purchase.method !== 'credit_card') {
			// CPF only lives inside this request. A later attempt can resolve the customer's reference.
			await this.db.billingPurchase.updateMany({
				where: { id: purchase.id, nextSyncAt: null, submittedAt: null },
				data: { nextSyncAt: later(recoveryDelay) },
			})
			try {
				providerCustomerId = await this.resolveCustomer(gateway, purchase.userId, cpf)
			} catch (error) {
				if (error instanceof AsaasError && error.code === 'rejected') {
					throw new HttpError(422, 'O Asaas recusou o cadastro do pagador. Confira os dados e tente novamente.')
				}
				throw error
			}
			if (!providerCustomerId) {
				const customer = await this.customer(purchase.userId)
				if (customer?.submittedAt && Date.now() - customer.submittedAt.getTime() > checkoutMinutes * 60_000) {
					await markReview(this.db, purchase, 'customer_requires_review')
				} else if (!cpf && !customer?.submittedAt && !customer?.providerCustomerId) {
					await this.db.billingPurchase.updateMany({
						where: { id: purchase.id, submittedAt: null, revision: purchase.revision },
						data: { nextSyncAt: null },
					})
				}
				return
			}
		}
		const submittedAt = new Date()
		const claim = await this.db.billingPurchase.updateMany({
			where: { id: purchase.id, submittedAt: null, status: 'preparing', revision: purchase.revision },
			data: { submittedAt, providerCustomerId, nextSyncAt: later(recoveryDelay), revision: { increment: 1 } },
		})
		if (!claim.count) return
		const submitted = await this.purchase(purchase.id)

		try {
			if (submitted.method === 'credit_card') {
				const checkout = await gateway.createCheckout(submitted)
				if (checkout.externalReference && checkout.externalReference !== purchase.id) {
					await markReview(this.db, submitted, 'checkout_reference_mismatch')
					return
				}
				await this.attachCheckout(submitted, checkout.id, checkout.link)
				return
			}
			const payment = await gateway.createPayment(submitted, providerCustomerId!, submitted.method)
			await this.preparePayment(gateway, submitted, payment)
		} catch (error) {
			if (error instanceof AsaasError && error.code === 'rejected') {
				await transition(this.db, submitted, { status: 'failed', lastError: 'provider_rejected', nextSyncAt: null })
			}
			throw error
		}
	}

	private async attachCheckout(purchase: BillingPurchase, id: string, link?: string | null) {
		if (purchase.providerCheckoutId && purchase.providerCheckoutId !== id) {
			await markReview(this.db, purchase, 'checkout_reference_mismatch')
			throw new ReconciliationError('checkout_reference_mismatch')
		}
		if (purchase.status !== 'preparing' && purchase.status !== 'pending' &&
			!(purchase.status === 'review' && purchase.lastError === 'creation_requires_review')) return
		let url: string
		try {
			url = checkoutUrl(this.scope.environment, id, link)
		} catch (error) {
			await transition(this.db, purchase, { providerCheckoutId: id, nextSyncAt: later(recoveryDelay) })
			throw error
		}
		await transition(this.db, purchase, {
			status: 'pending',
			providerCheckoutId: id,
			instructions: { url },
			instructionsUntil: new Date(purchase.submittedAt!.getTime() + checkoutMinutes * 60_000),
			nextSyncAt: null,
		})
	}

	private async recover(gateway: AsaasGateway, purchase: BillingPurchase) {
		try {
			const payment = purchase.providerPaymentId
				? await gateway.getPayment(purchase.providerPaymentId)
				: await gateway.findPayment(purchase.providerCheckoutId
					? { checkoutSession: purchase.providerCheckoutId }
					: { externalReference: purchase.id })
			if (payment) {
				await this.preparePayment(gateway, purchase, payment)
				return
			}
			if (purchase.providerCheckoutId && purchase.status === 'preparing') {
				await this.attachCheckout(purchase, purchase.providerCheckoutId)
				return
			}
			const submittedAt = purchase.submittedAt
			if (submittedAt && Date.now() - submittedAt.getTime() > checkoutMinutes * 60_000) {
				await markReview(this.db, purchase, 'creation_requires_review')
			}
		} catch (error) {
			if (error instanceof AsaasError && error.code === 'duplicate_reference') {
				await markReview(this.db, purchase, 'duplicate_reference')
				return
			}
			throw error
		}
	}

	private async preparePayment(gateway: AsaasGateway, purchase: BillingPurchase, payment: AsaasPayment) {
		const revision = await applyPayment(this.db, purchase, payment, {
			checkoutId: purchase.providerCheckoutId ?? undefined, preparationOnly: true,
		})
		if (revision === undefined) return
		const current = await this.purchase(purchase.id)
		if (current.revision === revision) await storeInstructions(this.db, gateway, current, payment)
	}

	verifyWebhook(token: unknown) {
		if (!this.config) throw new HttpError(503, 'Checkout temporariamente indisponível.')
		const digest = (value: string) => createHash('sha256').update(value).digest()
		if (typeof token !== 'string' || !timingSafeEqual(digest(token), digest(this.config.webhookToken))) {
			throw new HttpError(401, 'Token de webhook inválido.')
		}
	}

	async saveEvent(body: unknown) {
		const event = webhookEnvelope.parse(body)
		const isCheckout = Object.hasOwn(checkoutEvents, event.event)
		const isPayment = paymentEvents.has(event.event)
		const checkout = isCheckout ? checkoutNotice.parse(event.checkout) : undefined
		const payment = isPayment ? z.object({ id: providerId }).parse(event.payment) : undefined
		const resourceId = checkout?.id ?? payment?.id ?? null
		const total = checkout?.items?.reduce((sum, item) => {
			const cents = asaasCents(item.value)
			return cents === null ? NaN : sum + cents * item.quantity
		}, 0)
		// Keep derived checkout evidence and provider IDs, without raw callbacks or payer data.
		const evidence = checkout ? {
			reference: this.referenceFromCheckout(checkout) ?? null,
			amountCents: typeof total === 'number' && Number.isSafeInteger(total) ? total : null,
			detachedCard: checkout.billingTypes?.length === 1 && checkout.billingTypes[0] === 'CREDIT_CARD' &&
				checkout.chargeTypes?.length === 1 && checkout.chargeTypes[0] === 'DETACHED',
		} : {}
		await this.db.billingWebhookEvent.createMany({
			data: {
				id: event.id, ...this.scope, type: event.event, resourceId, evidence,
				processedAt: resourceId ? null : new Date(),
			},
			skipDuplicates: true,
		})
	}

	private async reconcileCheckout(gateway: AsaasGateway, event: BillingWebhookEvent) {
		const notice = checkoutEvidence.parse(event.evidence)
		const checkoutId = event.resourceId!
		let purchase = await this.db.billingPurchase.findUnique({
			where: { provider_environment_providerCheckoutId: { ...this.scope, providerCheckoutId: checkoutId } },
		})
		if (!purchase) {
			const reference = notice.reference
			if (!reference) return
			purchase = await this.db.billingPurchase.findFirst({
				where: { id: reference, ...this.scope, method: 'credit_card', submittedAt: { not: null } },
			})
			if (!purchase) return
			if (notice.amountCents !== purchase.amountCents || !notice.detachedCard) {
				throw new ReconciliationError('checkout_mismatch')
			}
		}
		if (purchase.providerCheckoutId && purchase.providerCheckoutId !== checkoutId) {
			throw new ReconciliationError('checkout_reference_mismatch')
		}

		const payment = purchase.providerPaymentId
			? await gateway.getPayment(purchase.providerPaymentId)
			: await gateway.findPayment({ checkoutSession: checkoutId })
		if (payment) {
			await applyPayment(this.db, purchase, payment, { checkoutId, eventType: event.type })
			return
		}
		if (event.type === 'CHECKOUT_PAID') throw new ReconciliationError('checkout_payment_not_visible')
		if (event.type === 'CHECKOUT_CREATED') {
			if (purchase.status === 'preparing' || (purchase.status === 'review' && purchase.lastError === 'creation_requires_review')) {
				await this.attachCheckout(purchase, checkoutId)
			}
			return
		}
		if (purchase.status === 'preparing' || purchase.status === 'review' || isPayable(purchase.status)) {
			await transition(this.db, purchase, {
				status: checkoutEvents[event.type as keyof typeof checkoutEvents],
				providerCheckoutId: checkoutId,
				nextSyncAt: null,
			})
		}
	}

	private referenceFromCheckout(notice: CheckoutNotice): string | undefined {
		const reference = purchaseIdSchema.safeParse(notice.externalReference)
		if (reference.success) return reference.data
		if (!notice.callback?.successUrl || !this.config || !this.gateway) return undefined
		try {
			const actual = new URL(notice.callback.successUrl)
			const id = purchaseIdSchema.parse(actual.searchParams.get('purchaseId'))
			if (actual.href === this.gateway.returnUrls(id).successUrl ||
				actual.href === checkoutReturnUrl(this.config.returnOrigin, id, 'success')) return id
		} catch {
			return undefined
		}
	}

	private async reconcilePayment(gateway: AsaasGateway, event: BillingWebhookEvent) {
		const id = event.resourceId!
		let purchase = await this.db.billingPurchase.findUnique({
			where: { provider_environment_providerPaymentId: { ...this.scope, providerPaymentId: id } },
		})
		try {
			const alreadyLinked = Boolean(purchase)
			let payment = await gateway.getPayment(id)
			if (!purchase && payment.checkoutSession) {
				purchase = await this.db.billingPurchase.findUnique({
					where: { provider_environment_providerCheckoutId: { ...this.scope, providerCheckoutId: payment.checkoutSession } },
				})
			}
			const reference = purchaseIdSchema.safeParse(payment.externalReference)
			if (!purchase && reference.success) {
				purchase = await this.db.billingPurchase.findFirst({ where: { id: reference.data, ...this.scope } })
			}
			if (!purchase && payment.checkoutSession) throw new ReconciliationError('checkout_link_not_visible')
			if (purchase) {
				if (!alreadyLinked) payment = await gateway.getPayment(id)
				await applyPayment(this.db, purchase, payment, {
					eventType: event.type,
					checkoutId: purchase.providerPaymentId === id ? purchase.providerCheckoutId ?? undefined : undefined,
				})
			}
		} catch (error) {
			if (event.type !== 'PAYMENT_DELETED' || !(error instanceof AsaasError) || error.code !== 'not_found') throw error
			if (purchase && purchase.status !== 'refunded') {
				await transition(this.db, purchase, { status: 'cancelled', nextSyncAt: null }, 'revoke')
			}
		}
	}

	async runOnce() {
		const gateway = this.gateway
		if (!gateway) return
		const scope = this.scope
		const events = await this.db.billingWebhookEvent.findMany({
			where: { ...scope, processedAt: null, nextAttemptAt: { lte: new Date() } },
			orderBy: { nextAttemptAt: 'asc' },
			take: 10,
		})
		for (const event of events) {
			const identity = { ...scope, id: event.id, processedAt: null }
			const lease = later(leaseMillis)
			const claim = await this.db.billingWebhookEvent.updateMany({
				where: { ...identity, attempts: event.attempts },
				data: { attempts: { increment: 1 }, nextAttemptAt: lease },
			})
			if (!claim.count) continue
			const where = { ...identity, nextAttemptAt: lease }
			try {
				if (Object.hasOwn(checkoutEvents, event.type)) await this.reconcileCheckout(gateway, event)
				else if (event.resourceId) await this.reconcilePayment(gateway, event)
				await this.db.billingWebhookEvent.updateMany({ where, data: { processedAt: new Date(), lastError: null } })
			} catch (error) {
				const code = failureCode(error)
				if (code !== event.lastError) console.warn('[BILLING] Webhook pending', { eventId: event.id, code })
				await this.db.billingWebhookEvent.updateMany({
					where,
					data: { lastError: code, nextAttemptAt: later(Math.min(3600_000, 5000 * 2 ** Math.min(event.attempts, 10))) },
				})
			}
		}

		const purchases = await this.db.billingPurchase.findMany({
			where: { ...scope, nextSyncAt: { lte: new Date() } },
			orderBy: { nextSyncAt: 'asc' },
			take: 10,
		})
		for (const purchase of purchases) {
			const claim = await this.db.billingPurchase.updateMany({
				where: { id: purchase.id, nextSyncAt: purchase.nextSyncAt },
				data: { nextSyncAt: later(recoveryDelay) },
			})
			if (!claim.count) continue
			try {
				await this.resume(gateway, purchase)
			} catch (error) {
				const code = failureCode(error)
				if (code !== purchase.lastError && code !== 'concurrent_update') {
					console.warn('[BILLING] Purchase pending', { purchaseId: purchase.id, code })
					await this.db.billingPurchase.updateMany({
						where: { id: purchase.id, revision: purchase.revision },
						data: { lastError: code },
					})
				}
			}
		}
	}
}
