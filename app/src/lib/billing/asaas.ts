import { z } from 'zod'
import { asaasDate, asaasMethods, checkoutMinutes, type AsaasEnvironment, type PaymentInstructions } from './rules.js'

const endpoints = {
	sandbox: { api: 'https://api-sandbox.asaas.com/v3', public: ['https://sandbox.asaas.com'] },
	production: { api: 'https://api.asaas.com/v3', public: ['https://asaas.com', 'https://www.asaas.com'] },
} as const
export const providerId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const optionalText = z.string().max(200).nullish()
const providerStatus = z.string().regex(/^[A-Z0-9_]{1,64}$/)
const customerSchema = z.object({ id: providerId, externalReference: optionalText })
const checkoutResponse = z.object({
	id: providerId,
	link: z.string().max(2048).nullish(),
	externalReference: optionalText,
})
const money = z.number().nonnegative()
const paymentSchema = z.object({
	id: providerId,
	externalReference: optionalText,
	customer: providerId.nullish(),
	checkoutSession: providerId.nullish(),
	subscription: providerId.nullish(),
	installment: providerId.nullish(),
	billingType: providerStatus,
	status: providerStatus,
	value: money,
	originalValue: money.nullish(),
	currency: z.string().max(3).nullish(),
	deleted: z.boolean().optional(),
	canBePaidAfterDueDate: z.boolean().nullish(),
	dueDate: z.iso.date().nullish(),
	bankSlipUrl: z.string().max(2048).nullish(),
	paymentDate: z.string().max(64).nullish(),
	confirmedDate: z.string().max(64).nullish(),
	clientPaymentDate: z.string().max(64).nullish(),
	refunds: z.array(z.object({ status: providerStatus, value: money })).nullish(),
})
export type AsaasPayment = z.infer<typeof paymentSchema>
export type AsaasCheckout = z.infer<typeof checkoutResponse>

export class AsaasError extends Error {
	constructor(
		readonly code: 'unavailable' | 'invalid_response' | 'rejected' | 'not_found' | 'duplicate_reference',
	) {
		super(code)
	}
}

function publicPaymentUrl(value: string, origins: readonly string[], path: RegExp): URL {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new AsaasError('invalid_response')
	}
	if (!origins.includes(url.origin) || url.username || url.password || !path.test(url.pathname)) {
		throw new AsaasError('invalid_response')
	}
	return url
}

export function checkoutUrl(environment: AsaasEnvironment, id: string, link?: string | null): string {
	const origins = endpoints[environment].public
	const fallback = environment === 'production'
		? `${origins[0]}/checkoutSession/show?id=${encodeURIComponent(id)}`
		: `${origins[0]}/checkoutSession/show/${encodeURIComponent(id)}`
	const pathPattern = /^\/(?:[A-Za-z0-9_-]+\/)?checkoutSession\/show(?:\/([A-Za-z0-9_-]+))?$/
	const url = publicPaymentUrl(link ?? fallback, origins, pathPattern)
	const pathId = pathPattern.exec(url.pathname)?.[1]
	const queryIds = url.searchParams.getAll('id')
	if ((pathId ?? queryIds[0]) !== id || queryIds.some((queryId) => queryId !== id)) {
		throw new AsaasError('invalid_response')
	}
	return url.href
}

export const checkoutReturnStatuses = ['success', 'cancelled', 'expired'] as const
export const publicCheckoutReturnPath = '/return'

export function checkoutReturnUrl(origin: string, purchaseId: string, status: typeof checkoutReturnStatuses[number], path = '/planos') {
	const url = new URL(path, origin)
	url.searchParams.set('purchaseId', purchaseId)
	url.searchParams.set('checkout', status)
	return url.href
}

function paymentDateInBrazil(days: number): string {
	const date = new Date(Date.now() + days * 86400_000)
	return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', dateStyle: 'short' }).format(date)
}

export class AsaasGateway {
	constructor(
		private readonly environment: AsaasEnvironment,
		private readonly apiKey: string,
		private readonly returnOrigin: string,
		private readonly fetcher: typeof fetch = globalThis.fetch,
		private readonly publicReturnOrigin?: string,
	) {}

	returnUrls(purchaseId: string) {
		const origin = this.publicReturnOrigin || this.returnOrigin
		const path = this.publicReturnOrigin ? `/plans${publicCheckoutReturnPath}` : '/planos'
		return {
			successUrl: checkoutReturnUrl(origin, purchaseId, 'success', path),
			cancelUrl: checkoutReturnUrl(origin, purchaseId, 'cancelled', path),
			expiredUrl: checkoutReturnUrl(origin, purchaseId, 'expired', path),
		}
	}

	private async request<T>(path: string, schema: z.ZodType<T>, body?: object): Promise<T> {
		let response: Response
		try {
			response = await this.fetcher(endpoints[this.environment].api + path, {
				method: body ? 'POST' : 'GET',
				headers: {
					accept: 'application/json',
					'content-type': 'application/json',
					access_token: this.apiKey,
					'User-Agent': 'Silverbox/1.0',
				},
				redirect: 'error',
				signal: AbortSignal.timeout(8000),
				...(body ? { body: JSON.stringify(body) } : {}),
			})
		} catch {
			throw new AsaasError('unavailable')
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => {})
			if (response.status === 404 && !body) throw new AsaasError('not_found')
			if (body && [400, 401, 403, 422].includes(response.status)) throw new AsaasError('rejected')
			throw new AsaasError('unavailable')
		}
		const parsed = schema.safeParse(await response.json().catch(() => null))
		if (!parsed.success) throw new AsaasError('invalid_response')
		return parsed.data
	}

	private async findOne<T>(path: string, filter: Record<string, string>, schema: z.ZodType<T>): Promise<T | null> {
		const query = new URLSearchParams({ ...filter, limit: '2' })
		const result = await this.request(`${path}?${query}`, z.object({ hasMore: z.boolean(), data: z.array(schema) }))
		if (result.hasMore || result.data.length > 1) throw new AsaasError('duplicate_reference')
		return result.data[0] ?? null
	}

	findCustomer(reference: string) {
		return this.findOne('/customers', { externalReference: reference }, customerSchema)
	}

	createCustomer(reference: string, name: string, cpf: string) {
		return this.request('/customers', customerSchema, {
			externalReference: reference, name, cpfCnpj: cpf, notificationDisabled: true,
		})
	}

	createCheckout(purchase: { id: string; planCode: string; cycle: string; seats: number; unitAmountCents: number }) {
		return this.request('/checkouts', checkoutResponse, {
			externalReference: purchase.id,
			billingTypes: ['CREDIT_CARD'],
			chargeTypes: ['DETACHED'],
			minutesToExpire: checkoutMinutes,
			callback: this.returnUrls(purchase.id),
			items: [{
				name: `Silverbox ${purchase.planCode}`,
				description: purchase.cycle === 'year' ? 'Acesso anual' : 'Acesso mensal',
				quantity: purchase.seats,
				value: purchase.unitAmountCents / 100,
			}],
		})
	}

	createPayment(purchase: { id: string; planCode: string; amountCents: number }, customer: string, method: 'pix' | 'boleto') {
		return this.request('/payments', paymentSchema, {
			externalReference: purchase.id,
			customer,
			billingType: asaasMethods[method],
			description: `Silverbox ${purchase.planCode}`,
			value: purchase.amountCents / 100,
			dueDate: paymentDateInBrazil(method === 'pix' ? 0 : 3),
		})
	}

	findPayment(filter: { externalReference: string } | { checkoutSession: string }) {
		return this.findOne('/payments', filter, paymentSchema)
	}

	async getPayment(id: string) {
		const payment = await this.request(`/payments/${encodeURIComponent(id)}`, paymentSchema)
		if (payment.id !== id) throw new AsaasError('invalid_response')
		return payment
	}

	async paymentInstructions(payment: AsaasPayment, method: 'pix' | 'boleto'): Promise<PaymentInstructions> {
		const path = `/payments/${encodeURIComponent(payment.id)}`
		if (method === 'pix') {
			const qr = await this.request(`${path}/pixQrCode`, z.object({
				encodedImage: z.string().min(4).max(512_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
				payload: z.string().min(1).max(4096),
				expirationDate: z.string().max(64),
			}))
			const expiration = asaasDate(qr.expirationDate)
			if (!expiration) throw new AsaasError('invalid_response')
			return { qrCodeBase64: qr.encodedImage, copyPaste: qr.payload, expiresAt: expiration.toISOString() }
		}
		if (!payment.bankSlipUrl || !payment.dueDate) throw new AsaasError('invalid_response')
		const url = publicPaymentUrl(payment.bankSlipUrl, endpoints[this.environment].public, /^\/(?:[A-Za-z0-9_-]+\/)?b\/pdf\/[A-Za-z0-9_-]+\/?$/)
		const slip = await this.request(`${path}/identificationField`, z.object({
			identificationField: z.string().min(30).max(80).regex(/^[0-9. -]+$/),
		}))
		return { url: url.href, digitableLine: slip.identificationField, dueDate: payment.dueDate }
	}
}
