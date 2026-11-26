import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertOperationsCovered, validateHttpContracts } from './contracts.js'

const secret = 'sandbox-mock-webhook-token-test-only'
const config = {
	apiKey: 'sandbox-mock-key', webhookToken: secret, returnOrigin: 'http://localhost:5173', maxChargeCents: 5_000_000,
	publicReturnOrigin: 'https://sandbox-api.silverbox.example',
}

type MockPayment = {
	id: string
	externalReference?: string
	customer?: string
	checkoutSession?: string
	billingType: string
	value: number
	dueDate?: string
	bankSlipUrl?: string
	status: string
	canBePaidAfterDueDate?: boolean
}

function mockAsaas() {
	const customers = new Map<string, { id: string; externalReference: string }>()
	const payments = new Map<string, MockPayment>()
	const checkouts = new Map<string, {
		id: string; externalReference: string; link: string; billingTypes: string[]; chargeTypes: string[]
		callback: { successUrl: string; cancelUrl: string; expiredUrl: string }
		items: { value: number; quantity: number }[]
	}>()
	const failures = { losePayment: false, loseCheckout: false, failInstructions: false, failQuery: false }
	const fetcher: typeof fetch = async (input, options) => {
		const url = new URL(String(input))
		assert.equal(url.origin, 'https://api-sandbox.asaas.com')
		assert.equal(new Headers(options?.headers).get('access_token'), config.apiKey)
		const [, version, resource, id, detail] = url.pathname.split('/')
		assert.equal(version, 'v3')
		if (options?.method === 'POST') {
			const request = JSON.parse(String(options.body))
			if (resource === 'customers') {
				assert.equal(request.cpfCnpj, '52998224725')
				const customer = { id: `cus_${randomUUID()}`, externalReference: request.externalReference }
				customers.set(customer.id, customer)
				return Response.json(customer)
			}
			if (resource === 'checkouts') {
				assert.deepEqual(request.billingTypes, ['CREDIT_CARD'])
				assert.deepEqual(request.chargeTypes, ['DETACHED'])
				const id = randomUUID()
				const checkout = { ...request, id, link: `https://sandbox.asaas.com/000/checkoutSession/show/${id}` }
				checkouts.set(checkout.id, checkout)
				if (failures.loseCheckout) {
					failures.loseCheckout = false
					throw new Error('Checkout response lost after creation')
				}
				return Response.json(checkout)
			}
			assert.equal(resource, 'payments')
			assert.ok(customers.has(request.customer))
			const payment: MockPayment = {
				...request,
				id: `pay_${randomUUID()}`,
				status: 'PENDING',
			}
			if (payment.billingType === 'BOLETO') payment.bankSlipUrl = `https://sandbox.asaas.com/b/pdf/${payment.id}`
			payments.set(payment.id, payment)
			if (failures.losePayment) {
				failures.losePayment = false
				throw new Error('Payment response lost after creation')
			}
			return Response.json(payment)
		}
		if (!id) {
			const entries = resource === 'customers' ? [...customers.values()] : [...payments.values()]
			const filter = url.searchParams.get('checkoutSession')
			const data = filter
				? entries.filter((entry) => 'checkoutSession' in entry && entry.checkoutSession === filter)
				: entries.filter((entry) => entry.externalReference === url.searchParams.get('externalReference'))
			return Response.json({ hasMore: false, data })
		}
		if (failures.failQuery) {
			failures.failQuery = false
			return new Response(null, { status: 503 })
		}
		const payment = payments.get(id)
		if (!payment) return new Response(null, { status: 404 })
		if (failures.failInstructions && detail) {
			failures.failInstructions = false
			return new Response(null, { status: 503 })
		}
		if (detail === 'pixQrCode') return Response.json({
			encodedImage: 'cWlk', payload: 'mock-pix-payload', expirationDate: new Date(Date.now() + 3600_000).toISOString(),
		})
		if (detail === 'identificationField') return Response.json({ identificationField: '1234567890'.repeat(4) })
		return Response.json(payment)
	}
	return { customers, payments, checkouts, failures, fetcher }
}

test('Sandbox purchases, webhook recovery and storage integrate with PostgreSQL', {
	skip: !process.env.DATABASE_URL,
}, async () => {
	const root = await mkdtemp(join(tmpdir(), 'silverbox-billing-'))
	Object.assign(process.env, {
		NODE_ENV: 'test', STORAGE_ROOT: root, BILLING_MODE: 'sandbox',
		ASAAS_API_KEY: config.apiKey, ASAAS_WEBHOOK_TOKEN: secret,
		BILLING_RETURN_ORIGIN: config.returnOrigin, BILLING_MAX_CHARGE_CENTS: String(config.maxChargeCents),
		BILLING_PUBLIC_RETURN_ORIGIN: config.publicReturnOrigin,
	})
	const [{ createApp }, { env }, { prisma }, { storage }, { BillingService }] = await Promise.all([
		import('../src/app.js'), import('../src/config/env.js'), import('../src/lib/prisma.js'),
		import('../src/lib/storage.js'), import('../src/lib/billing/service.js'),
	])
	const mock = mockAsaas()
	let service = new BillingService(prisma, config, mock.fetcher)
	await storage.init()
	const server = createApp(service).listen(0, '127.0.0.1')
	await once(server, 'listening')
	const address = server.address()
	assert.ok(address && typeof address === 'object')
	const baseURL = `http://127.0.0.1:${address.port}`
	const json = { 'Content-Type': 'application/json' }
	let cookie: string
	let ownerId: number
	const eventIds: string[] = []
	const users: number[] = []

	async function register() {
		const response = await fetch(`${baseURL}/auth/register`, {
			method: 'POST', headers: { ...json, Origin: env.BETTER_AUTH_URL },
			body: JSON.stringify({ name: 'Billing Test', email: `${randomUUID()}@example.com`, password: 'correct-horse-battery-staple' }),
		})
		assert.equal(response.status, 200)
		const loginCookie = response.headers.get('set-cookie')?.split(';')[0]
		assert.ok(loginCookie)
		const id = Number((await response.json()).user.id)
		users.push(id)
		return { cookie: loginCookie, id }
	}

	function start(key: string, selection: object, headers: Record<string, string> = {}) {
		return fetch(`${baseURL}/plans/checkout`, {
			method: 'POST', headers: { ...json, Origin: env.BETTER_AUTH_URL, Cookie: cookie, 'Idempotency-Key': key, ...headers },
			body: JSON.stringify(selection),
		})
	}

	async function details(id: string) {
		const response = await fetch(`${baseURL}/plans/purchases/${id}`, { headers: { Cookie: cookie } })
		assert.equal(response.status, 200)
		return response.json()
	}

	async function quota() {
		const response = await fetch(`${baseURL}/storage/usage`, { headers: { Cookie: cookie } })
		assert.equal(response.status, 200)
		return (await response.json()).limitBytes
	}

	function event(type: string, body: object, token = secret, id = randomUUID()) {
		eventIds.push(id)
		return fetch(`${baseURL}/webhooks/asaas`, {
			method: 'POST', headers: { ...json, 'asaas-access-token': token },
			body: JSON.stringify({ event: type, id, ...body }),
		})
	}

	async function notify(type: string, body: object, id?: string) {
		assert.equal((await event(type, body, secret, id)).status, 200)
		await service.runOnce()
	}

	try {
		await validateHttpContracts(baseURL)
		const catalog = await fetch(`${baseURL}/plans`)
		assert.equal(catalog.status, 200)
		assert.equal((await catalog.json()).plans.length, 4)
		assert.equal((await fetch(`${baseURL}/plans/checkout`, { method: 'POST' })).status, 401)
		const owner = await register()
		ownerId = owner.id
		cookie = owner.cookie
		const other = await register()
		assert.equal(await quota(), '1073741824')
		const preflight = await fetch(`${baseURL}/plans/checkout`, {
			method: 'OPTIONS', headers: { Origin: config.returnOrigin, 'Access-Control-Request-Method': 'POST' },
		})
		assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /Idempotency-Key/i)
		const disabled = new BillingService(prisma)
		await assert.rejects(disabled.start(ownerId, randomUUID(), {
			planCode: 'pro', cycle: 'month', seats: 1, method: 'credit_card',
		}), { status: 503 })

		const pix = { planCode: 'pro', cycle: 'month', seats: 1, method: 'pix', payerCpf: '529.982.247-25' }
		assert.equal((await start(randomUUID(), pix, { Origin: 'https://untrusted.example' })).status, 403)
		assert.equal((await start(randomUUID(), { ...pix, amountCents: 1 })).status, 400)
		assert.equal((await start(randomUUID(), { planCode: 'business', cycle: 'year', seats: 56, method: 'boleto' })).status, 422)
		const key = randomUUID()
		mock.failures.losePayment = true
		mock.failures.failInstructions = true
		const concurrent = await Promise.all([start(key, pix), start(key, pix)])
		assert.ok(concurrent.every((response) => [200, 201, 202].includes(response.status)))
		const [purchase, replay] = await Promise.all(concurrent.map((response) => response.json()))
		assert.equal(purchase.id, replay.id)
		assert.equal(purchase.amountCents, 2990)
		assert.equal(mock.payments.size, 1)
		assert.equal(mock.customers.size, 1)
		assert.equal((await start(key, { ...pix, cycle: 'year' })).status, 409)
		assert.equal((await fetch(`${baseURL}/plans/purchases/${purchase.id}`, {
			headers: { Cookie: other.cookie },
		})).status, 404)
		const payment = [...mock.payments.values()][0]!
		assert.equal(payment.value, 29.9)
		let retry = await start(key, pix)
		if (retry.status === 202) retry = await start(key, pix)
		assert.equal(retry.status, 200)
		assert.equal((await retry.json()).paymentInstructions.copyPaste, 'mock-pix-payload')
		assert.equal(mock.payments.size, 1)

		assert.equal((await event('PAYMENT_RECEIVED', { payment: { id: payment.id } }, 'wrong')).status, 401)
		payment.status = 'CONFIRMED'
		await notify('PAYMENT_CONFIRMED', { payment })
		assert.equal((await details(purchase.id)).status, 'processing')
		assert.equal(await quota(), '1073741824')

		payment.status = 'RECEIVED'
		const webhookId = randomUUID()
		mock.failures.failQuery = true
		await notify('PAYMENT_RECEIVED', { payment }, webhookId)
		assert.equal(await quota(), '1073741824')
		await prisma.billingWebhookEvent.updateMany({
			where: { id: webhookId }, data: { nextAttemptAt: new Date(0) },
		})
		service = new BillingService(prisma, config, mock.fetcher)
		await service.runOnce()
		assert.equal((await details(purchase.id)).status, 'paid')
		assert.equal(await quota(), '214748364800')
		await notify('PAYMENT_RECEIVED', { payment }, webhookId)
		assert.equal(await prisma.billingGrant.count({ where: { purchaseId: purchase.id } }), 1)
		assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: ownerId } })).quotaLimitBytes, 1073741824n)

		const uploaded = await fetch(`${baseURL}/files`, {
			method: 'POST', body: 'abc', headers: {
				Cookie: cookie, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'billing.txt',
				'X-File-Size': '3', 'X-File-Mime': 'text/plain',
			},
		})
		assert.equal(uploaded.status, 201)
		const { file: upload } = await uploaded.json()
		payment.status = 'REFUNDED'
		await notify('PAYMENT_REFUNDED', { payment })
		await notify('PAYMENT_RECEIVED', { payment })
		assert.equal((await details(purchase.id)).status, 'refunded')
		assert.equal(await quota(), '1073741824')
		const downloaded = await fetch(`${baseURL}/files/${upload.id}/download`, { headers: { Cookie: cookie } })
		assert.equal(downloaded.status, 200)
		assert.equal(await downloaded.text(), 'abc')

		const boletoRes = await start(randomUUID(), { planCode: 'business', cycle: 'year', seats: 5, method: 'boleto' })
		assert.equal(boletoRes.status, 201)
		const boleto = await boletoRes.json()
		assert.equal(boleto.amountCents, 449500)
		assert.match(boleto.paymentInstructions.digitableLine, /^\d+$/)
		const slip = [...mock.payments.values()].find((item) => item.externalReference === boleto.id)!
		assert.equal(slip.value, 4495)
		slip.status = 'OVERDUE'
		await notify('PAYMENT_OVERDUE', { payment: slip })
		assert.equal((await details(boleto.id)).status, 'overdue')
		slip.status = 'RECEIVED'
		await notify('PAYMENT_RECEIVED', { payment: slip })
		assert.equal((await details(boleto.id)).status, 'paid')
		assert.equal(await quota(), '1073741824')

		mock.failures.loseCheckout = true
		const cardRes = await start(randomUUID(), { planCode: 'team', cycle: 'month', seats: 3, method: 'credit_card' })
		assert.equal(cardRes.status, 202)
		const card = await cardRes.json()
		assert.equal(card.amountCents, 14970)
		const checkout = [...mock.checkouts.values()][0]!
		assert.equal(checkout.items[0]?.value, 49.9)
		assert.equal(checkout.items[0]?.quantity, 3)
		for (const [callback, status] of [
			[checkout.callback.successUrl, 'success'], [checkout.callback.cancelUrl, 'cancelled'],
			[checkout.callback.expiredUrl, 'expired'],
		]) {
			const callbackPath = `/plans/return?purchaseId=${card.id}&checkout=${status}`
			assert.equal(callback, `${config.publicReturnOrigin}${callbackPath}`)
			const redirect = await fetch(`${baseURL}${callbackPath}&origin=https://untrusted.example`, { redirect: 'manual' })
			assert.equal(redirect.status, 302)
			assert.equal(redirect.headers.get('location'), `${config.returnOrigin}/planos?purchaseId=${card.id}&checkout=${status}`)
			assert.equal(redirect.headers.get('cache-control'), 'no-store')
		}
		assert.equal((await fetch(`${baseURL}/plans/return?purchaseId=${card.id}&checkout=paid`)).status, 400)
		assert.equal((await details(card.id)).status, 'preparing')
		await notify('CHECKOUT_CREATED', { checkout: {
			id: checkout.id, callback: checkout.callback, items: checkout.items,
			billingTypes: checkout.billingTypes, chargeTypes: checkout.chargeTypes,
		} })
		assert.match((await details(card.id)).paymentInstructions.url, /^https:\/\/sandbox\.asaas\.com\/checkoutSession\/show\//)
		const cardPayment = {
			id: 'pay_card_test', checkoutSession: checkout.id, billingType: 'CREDIT_CARD', value: 149.7, status: 'CONFIRMED',
		}
		mock.payments.set(cardPayment.id, cardPayment)
		await notify('CHECKOUT_PAID', { checkout: { id: checkout.id } })
		assert.equal((await details(card.id)).status, 'paid')
		cardPayment.status = 'CHARGEBACK_DISPUTE'
		await notify('PAYMENT_CHARGEBACK_DISPUTE', { payment: cardPayment })
		assert.equal((await details(card.id)).status, 'disputed')
		assert.equal(await quota(), '1073741824')

		const proYear = await start(randomUUID(), { planCode: 'pro', cycle: 'year', seats: 1, method: 'credit_card' })
		assert.equal(proYear.status, 201)
		const proYearPurchase = await proYear.json()
		assert.equal(proYearPurchase.amountCents, 29900)
		const proYearCheckout = [...mock.checkouts.values()].find((item) => item.externalReference === proYearPurchase.id)
		assert.equal(proYearCheckout?.items[0]?.value, 299)
		assert.equal(proYearCheckout?.items[0]?.quantity, 1)
		assert.equal(proYearPurchase.paymentInstructions.url, proYearCheckout?.link)

		for (const { selection, expectedCents } of [
			{ selection: { planCode: 'team', cycle: 'year', seats: 3, method: 'pix' }, expectedCents: 149700 },
			{ selection: { planCode: 'business', cycle: 'month', seats: 5, method: 'boleto' }, expectedCents: 44950 },
		]) {
			const response = await start(randomUUID(), selection)
			assert.equal(response.status, 201)
			const purchase = await response.json()
			assert.equal(purchase.amountCents, expectedCents)
			const charge = [...mock.payments.values()].find((item) => item.externalReference === purchase.id)
			assert.equal(charge?.value, expectedCents / 100)
		}
		assertOperationsCovered(['GET /plans', 'POST /plans/checkout', 'GET /plans/purchases/{id}', 'GET /plans/return', 'POST /webhooks/asaas'])

		await prisma.user.update({ where: { id: other.id }, data: { userRole: 'admin' } })
		const deletion = await fetch(`${baseURL}/admin/users/${ownerId}`, {
			method: 'DELETE', headers: { Origin: env.BETTER_AUTH_URL, Cookie: other.cookie },
		})
		assert.equal(deletion.status, 204)
		assert.equal(await prisma.user.findUnique({ where: { id: ownerId } }), null)
		assert.equal(await prisma.billingPurchase.count({ where: { userId: ownerId } }), 0)
	} finally {
		server.close()
		await once(server, 'close')
		await prisma.billingWebhookEvent.deleteMany({ where: { id: { in: eventIds } } })
		await prisma.billingGrant.deleteMany({ where: { userId: { in: users } } })
		await prisma.billingPurchase.deleteMany({ where: { userId: { in: users } } })
		await prisma.billingCustomer.deleteMany({ where: { userId: { in: users } } })
		await prisma.user.deleteMany({ where: { id: { in: users } } })
		await prisma.$disconnect()
		await rm(root, { recursive: true, force: true })
	}
})
