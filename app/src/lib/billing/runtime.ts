import { env } from '../../config/env.js'
import { prisma } from '../prisma.js'
import { BillingService } from './service.js'

const config = env.BILLING_MODE !== 'disabled' ? {
	environment: env.BILLING_MODE,
	apiKey: env.BILLING_ASAAS_API_KEY!,
	webhookToken: env.BILLING_ASAAS_WEBHOOK_TOKEN!,
	returnOrigin: env.BILLING_RETURN_ORIGIN!,
	publicReturnOrigin: env.BILLING_PUBLIC_RETURN_ORIGIN,
	maxChargeCents: env.BILLING_MAX_CHARGE_CENTS!,
} : undefined

export const billing = new BillingService(prisma, config)

export function startBillingWorker() {
	let running: Promise<void> | undefined
	function tick() {
		running ??= billing.runOnce()
			.catch(() => console.error('[BILLING] Worker unavailable; will retry'))
			.finally(() => { running = undefined })
	}
	const interval = config ? setInterval(tick, 5000) : undefined
	if (interval) {
		interval.unref()
		tick()
	}
	return async () => {
		clearInterval(interval)
		await running
	}
}
