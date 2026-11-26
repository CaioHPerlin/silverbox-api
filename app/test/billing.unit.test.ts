import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AsaasError, AsaasGateway, checkoutUrl } from '../src/lib/billing/asaas.js'
import { priceSelection, pricingCatalog } from '../src/lib/billing/catalog.js'
import { applyPayment, paymentMatches } from '../src/lib/billing/reconciliation.js'
import { normalizeCpf, paymentStatus, periodEnd } from '../src/lib/billing/rules.js'
import { checkoutSchema } from '../src/lib/billing/validation.js'
import type { BillingPurchase, PrismaClient } from '@prisma/client'

test('pricing preserves availability and uses whole-cycle cents per seat', () => {
	const catalog = pricingCatalog(true)
	assert.deepEqual(catalog.paymentMethods, ['credit_card', 'pix', 'boleto'])
	assert.deepEqual(catalog.plans.map(({ code, status, checkoutEnabled, storageBytes }) => ({
		code, status, checkoutEnabled, storageBytes,
	})), [
		{ code: 'free', status: 'available', checkoutEnabled: false, storageBytes: 1024 ** 3 },
		{ code: 'pro', status: 'coming-soon', checkoutEnabled: true, storageBytes: 200 * 1024 ** 3 },
		{ code: 'team', status: 'coming-soon', checkoutEnabled: true, storageBytes: 2 * 1024 ** 4 },
		{ code: 'business', status: 'coming-soon', checkoutEnabled: true, storageBytes: 5 * 1024 ** 4 },
	])
	assert.ok(pricingCatalog(false).plans.every((plan) => !plan.checkoutEnabled))
	assert.deepEqual(catalog.plans.map(({ code, monthlyPriceCents, yearlyPriceCents, seatMin }) => [
		code, monthlyPriceCents, yearlyPriceCents, seatMin,
	]), [
		['free', 0, 0, 1],
		['pro', 2990, 29900, 1],
		['team', 4990, 49900, 3],
		['business', 8990, 89900, 5],
	])

	assert.equal(priceSelection('pro', 'month', 1)?.amountCents, 2990)
	assert.equal(priceSelection('pro', 'year', 1)?.amountCents, 29900)
	assert.equal(priceSelection('team', 'month', 3)?.amountCents, 14970)
	assert.equal(priceSelection('team', 'year', 3)?.amountCents, 149700)
	assert.equal(priceSelection('business', 'month', 5)?.amountCents, 44950)
	assert.equal(priceSelection('business', 'year', 5)?.amountCents, 449500)
	assert.equal(priceSelection('business', 'year', 56)?.amountCents, 5034400)
	assert.equal(priceSelection('business', 'month', 101), null)
	assert.equal(priceSelection('team', 'month', 2), null)
	assert.equal(priceSelection('team', 'month', 3.5), null)
	assert.equal(priceSelection('pro', 'month', 2), null)
})

test('strict checkout JSON accepts validated CPF only for Pix and boleto', () => {
	const checkout = { planCode: 'pro', cycle: 'month', seats: 1, method: 'pix', payerCpf: '529.982.247-25' }
	assert.equal(checkoutSchema.parse(checkout).payerCpf, '52998224725')
	assert.equal(normalizeCpf('11111111111'), null)
	assert.equal(normalizeCpf('52998224724'), null)
	for (const invalid of [
		{ ...checkout, planCode: 'free' }, { ...checkout, cycle: 'quarter' }, { ...checkout, seats: 1.25 },
		{ ...checkout, method: 'debit_card' }, { ...checkout, method: 'credit_card' },
		{ ...checkout, amountCents: 1 }, { ...checkout, userId: 1 },
	]) {
		assert.equal(checkoutSchema.safeParse(invalid).success, false)
	}
})

test('calendar durations clamp month ends and leap dates', () => {
	assert.equal(periodEnd(new Date('2028-01-31T15:30:00Z'), 'month').toISOString(), '2028-02-29T15:30:00.000Z')
	assert.equal(periodEnd(new Date('2028-02-29T15:30:00Z'), 'year').toISOString(), '2029-02-28T15:30:00.000Z')
	assert.equal(periodEnd(new Date('2026-12-31T03:00:00Z'), 'month').toISOString(), '2027-01-31T03:00:00.000Z')
})

test('provider states distinguish authorization, Pix clearance, boleto and reversals', () => {
	assert.equal(paymentStatus('credit_card', 'AUTHORIZED', {}), 'processing')
	assert.equal(paymentStatus('credit_card', 'CONFIRMED', {}), 'paid')
	assert.equal(paymentStatus('pix', 'CONFIRMED', {}), 'processing')
	assert.equal(paymentStatus('pix', 'RECEIVED', {}), 'paid')
	assert.equal(paymentStatus('boleto', 'RECEIVED_IN_CASH', {}), 'processing')
	assert.equal(paymentStatus('boleto', 'OVERDUE', {}), 'overdue')
	assert.equal(paymentStatus('boleto', 'OVERDUE', { canBePaidAfterDueDate: false }), 'cancelled')
	assert.equal(paymentStatus('pix', 'REFUNDED', {}), 'refunded')
	assert.equal(paymentStatus('credit_card', 'CHARGEBACK_DISPUTE', {}), 'disputed')
})

test('Asaas sends detached hosted card requests to Sandbox and validates checkout URLs', async () => {
	const id = '92f0950a-1536-46be-80a7-0b4398938565'
	const gateway = new AsaasGateway('fake-access-token', 'https://test.silverbox.example', async (url, request) => {
		assert.equal(url, 'https://api-sandbox.asaas.com/v3/checkouts')
		assert.equal(request?.redirect, 'error')
		assert.ok(request?.signal)
		assert.equal(new Headers(request?.headers).get('access_token'), 'fake-access-token')
		const body = JSON.parse(String(request?.body))
		assert.deepEqual(body.billingTypes, ['CREDIT_CARD'])
		assert.deepEqual(body.chargeTypes, ['DETACHED'])
		assert.equal(body.externalReference, id)
		assert.equal(body.items[0].value * body.items[0].quantity, 1497)
		assert.equal(body.callback.successUrl, `https://test.silverbox.example/planos?purchaseId=${id}&checkout=success`)
		return Response.json({ id: 'sandbox_session' })
	})
	const { id: checkoutId } = await gateway.createCheckout({ id, planCode: 'team', cycle: 'year', seats: 3, unitAmountCents: 49900 })
	assert.equal(checkoutUrl(checkoutId), 'https://sandbox.asaas.com/checkoutSession/show/sandbox_session')
	const sandboxLink = 'https://sandbox.asaas.com/000/checkoutSession/show/sandbox_session'
	assert.equal(checkoutUrl(checkoutId, sandboxLink), sandboxLink)
	assert.throws(() => checkoutUrl(checkoutId, 'https://asaas.com/checkoutSession/show?id=sandbox_session'), AsaasError)
	assert.throws(() => checkoutUrl(checkoutId, 'https://sandbox.asaas.com/checkoutSession/show/another-session'), AsaasError)
	assert.throws(() => checkoutUrl(checkoutId, `${sandboxLink}?id=another-session`), AsaasError)
})

test('Asaas adapter validates Pix expiration, boleto instructions and duplicate references', async () => {
	const payment = { id: 'pay_test', customer: 'cus_test', billingType: 'PIX', status: 'PENDING', value: 29.9 }
	const gateway = new AsaasGateway('fake-access-token', 'http://localhost:5173', async (input) => {
		const url = new URL(String(input))
		if (url.pathname.endsWith('/pixQrCode')) {
			return Response.json({ encodedImage: 'cWlk', payload: 'pix-payload', expirationDate: '2028-01-20 23:59:59' })
		}
		if (url.pathname.endsWith('/identificationField')) return Response.json({ identificationField: '1234567890'.repeat(4) })
		return Response.json({ data: [payment, payment], hasMore: false })
	})
	assert.deepEqual(await gateway.paymentInstructions(payment, 'pix'), {
		qrCodeBase64: 'cWlk', copyPaste: 'pix-payload', expiresAt: '2028-01-21T02:59:59.000Z',
	})
	assert.deepEqual(await gateway.paymentInstructions({
		...payment, bankSlipUrl: 'https://sandbox.asaas.com/b/pdf/pay_test', dueDate: '2028-01-20',
	}, 'boleto'), {
		url: 'https://sandbox.asaas.com/b/pdf/pay_test', dueDate: '2028-01-20', digitableLine: '1234567890'.repeat(4),
	})
	await assert.rejects(gateway.findPayment({ externalReference: 'purchase' }), { code: 'duplicate_reference' })
})

test('only provider-confirmed financial transitions change a single Pro grant', async () => {
	let purchase = {
		id: 'eab82459-b20e-4010-9469-9e992fdbc044', userId: 1, planCode: 'pro', cycle: 'month',
		submittedAt: new Date(), createdAt: new Date(), confirmedAt: null, instructions: null,
		providerCustomerId: 'cus_test', providerPaymentId: null, providerCheckoutId: null,
		method: 'pix', amountCents: 2990, currency: 'BRL', status: 'preparing', revision: 0,
		benefits: { storageBytes: 200 * 1024 ** 3 },
	} as BillingPurchase
	let grant: { startsAt: Date; endsAt: Date; revokedAt?: Date | null } | undefined
	const db = {
		async $transaction(action: (tx: unknown) => Promise<void>) {
			await action({
				async $queryRaw() {},
				billingPurchase: {
					async updateMany({ where, data }: { where: { revision: number }; data: Record<string, unknown> }) {
						if (where.revision !== purchase.revision) return { count: 0 }
						purchase = { ...purchase, ...data, revision: purchase.revision + 1 }
						return { count: 1 }
					},
				},
				billingGrant: {
					async upsert({ create, update }: { create: NonNullable<typeof grant>; update: Partial<NonNullable<typeof grant>> }) {
						grant = grant ? { ...grant, ...update } : create
					},
					async updateMany({ data }: { data: Partial<NonNullable<typeof grant>> }) {
						if (grant) grant = { ...grant, ...data }
					},
				},
			})
		},
	} as unknown as PrismaClient
	const payment = {
		id: 'pay_test', externalReference: purchase.id, customer: 'cus_test', billingType: 'PIX',
		status: 'CONFIRMED', value: 29.9,
	}
	assert.equal(paymentMatches(purchase, { ...payment, value: 29.91 }), false)
	assert.equal(paymentMatches(purchase, { ...payment, billingType: 'BOLETO' }), false)
	assert.equal(paymentMatches(purchase, { ...payment, customer: 'cus_other' }), false)
	assert.equal(paymentMatches(purchase, { ...payment, externalReference: 'other' }), false)
	await applyPayment(db, purchase, payment)
	assert.equal(purchase.status, 'processing')
	assert.equal(grant, undefined)
	await applyPayment(db, purchase, { ...payment, status: 'RECEIVED' }, { preparationOnly: true })
	assert.equal(grant, undefined)
	const stale = purchase
	await applyPayment(db, purchase, { ...payment, status: 'RECEIVED' }, { eventType: 'PAYMENT_RECEIVED' })
	assert.equal(purchase.status, 'paid')
	assert.ok(grant)
	const startsAt = grant!.startsAt
	await assert.rejects(applyPayment(db, stale, { ...payment, status: 'RECEIVED' }), { code: 'concurrent_update' })
	await applyPayment(db, purchase, { ...payment, status: 'RECEIVED' }, { eventType: 'PAYMENT_PARTIALLY_REFUNDED' })
	assert.equal(purchase.status, 'review')
	assert.equal(grant!.revokedAt, undefined)
	await applyPayment(db, purchase, { ...payment, status: 'REFUNDED' }, { eventType: 'PAYMENT_REFUNDED' })
	assert.equal(purchase.status, 'refunded')
	assert.ok(grant!.revokedAt)
	await applyPayment(db, purchase, { ...payment, status: 'RECEIVED' })
	assert.equal(purchase.status, 'refunded')
	assert.equal(grant!.startsAt, startsAt)
})

test('concurrent replays after a lost Checkout response reserve a single external attempt', async () => {
	const { BillingService } = await import('../src/lib/billing/service.js')
	let row: BillingPurchase | null = null
	const id = 'c926bbfa-e8ea-4581-915e-a4d502dca185'
	let emissions = 0
	const db = {
		billingPurchase: {
			async findUnique({ where }: { where: { userId_provider_environment_idempotencyKey: { idempotencyKey: string } } }) {
				return row && row.idempotencyKey === where.userId_provider_environment_idempotencyKey.idempotencyKey
					? { ...row }
					: null
			},
			async findUniqueOrThrow() { return row && { ...row } },
			async create({ data }: { data: Partial<BillingPurchase> }) {
				if (row) throw Object.assign(new Error('unique'), { code: 'P2002' })
				row = {
					id, ...data, currency: 'BRL', status: 'preparing', revision: 0,
					submittedAt: null, instructions: null, createdAt: new Date(),
				} as BillingPurchase
				return { ...row }
			},
			async updateMany({ where, data }: {
				where: Pick<BillingPurchase, 'id' | 'revision' | 'status' | 'submittedAt'>
				data: Partial<BillingPurchase>
			}) {
				if (!row || Object.entries(where).some(([key, value]) => row?.[key as keyof BillingPurchase] !== value)) {
					return { count: 0 }
				}
				row = { ...row, ...data, revision: row.revision + 1 }
				return { count: 1 }
			},
		},
	} as unknown as PrismaClient
	const service = new BillingService(db, {
		apiKey: 'fake-key', webhookToken: 'fake-dedicated-token', returnOrigin: 'http://localhost:5173', maxChargeCents: 5_000_000,
	}, async (url, options) => {
		if (options?.method === 'POST') {
			emissions++
			throw new Error('response lost')
		}
		assert.equal(new URL(String(url)).searchParams.get('externalReference'), id)
		return Response.json({ hasMore: false, data: [] })
	})

	const selection = { planCode: 'team', cycle: 'month', seats: 3, method: 'credit_card' } as const
	const responses = await Promise.all([service.start(42, 'checkout-key', selection), service.start(42, 'checkout-key', selection)])
	assert.deepEqual(responses.map(({ status, body }) => [status, body.id]), [[202, id], [202, id]])
	assert.equal((await service.start(42, 'checkout-key', selection)).status, 202)
	await assert.rejects(service.start(42, 'checkout-key', { ...selection, cycle: 'year' }), { status: 409 })
	await assert.rejects(service.start(42, 'another-key', { ...selection, planCode: 'business', cycle: 'year', seats: 56 }), { status: 422 })
	assert.equal(emissions, 1)
	assert.throws(() => service.verifyWebhook('wrong-token'), { status: 401 })
	assert.doesNotThrow(() => service.verifyWebhook('fake-dedicated-token'))
})
