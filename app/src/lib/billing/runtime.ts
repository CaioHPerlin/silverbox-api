import { env } from '../../config/env.js'
import { prisma } from '../prisma.js'
import { BillingService } from './service.js'

const sandbox = env.BILLING_MODE === 'sandbox' ? {
	apiKey: env.ASAAS_API_KEY!,
	webhookToken: env.ASAAS_WEBHOOK_TOKEN!,
	returnOrigin: env.BILLING_RETURN_ORIGIN!,
	publicReturnOrigin: env.BILLING_PUBLIC_RETURN_ORIGIN,
	maxChargeCents: env.BILLING_MAX_CHARGE_CENTS!,
} : undefined

export const billing = new BillingService(prisma, sandbox)

export function startBillingWorker() {
	let running: Promise<void> | undefined
	function tick() {
		running ??= billing.runOnce()
			.catch(() => console.error('[BILLING] Worker unavailable; will retry'))
			.finally(() => { running = undefined })
	}
	const interval = sandbox ? setInterval(tick, 5000) : undefined
	if (interval) {
		interval.unref()
		tick()
	}
	return async () => {
		clearInterval(interval)
		await running
	}
}
