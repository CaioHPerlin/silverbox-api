import type { BillingPurchase, Prisma, PrismaClient } from '@prisma/client'
import type { AsaasGateway, AsaasPayment } from './asaas.js'
import { grantsStorage } from './catalog.js'
import { asaasCents, asaasDate, asaasMethods, isPayable, paymentStatus, periodEnd } from './rules.js'

export class ReconciliationError extends Error {
	constructor(readonly code: string) {
		super(code)
	}
}

// A later worker must read the provider again if this snapshot lost the race.
export async function transition(
	db: PrismaClient,
	purchase: BillingPurchase,
	data: Prisma.BillingPurchaseUpdateManyMutationInput,
	grant: 'activate' | 'revoke' | 'preserve' = 'preserve',
) {
	await db.$transaction(async (tx) => {
		const includesStorageGrant = grantsStorage(purchase.planCode)
		if (includesStorageGrant && grant !== 'preserve') {
			// Same lock order as file-service reserve and upload commit.
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(714923, 1)`
			await tx.$queryRaw`SELECT id FROM silverbox_api.users WHERE id = ${purchase.userId} FOR UPDATE`
		}
		const result = await tx.billingPurchase.updateMany({
			where: { id: purchase.id, revision: purchase.revision },
			data: { ...data, revision: { increment: 1 } },
		})
		if (result.count !== 1) throw new ReconciliationError('concurrent_update')
		if (!includesStorageGrant) return
		if (grant === 'activate') {
			const snapshot = purchase.benefits as { storageBytes: number }
			const startsAt = data.confirmedAt as Date
			await tx.billingGrant.upsert({
				where: { purchaseId: purchase.id },
				create: {
					purchaseId: purchase.id,
					userId: purchase.userId,
					storageBytes: BigInt(snapshot.storageBytes),
					startsAt,
					endsAt: periodEnd(startsAt, purchase.cycle),
				},
				update: { revokedAt: null },
			})
		}
		if (grant === 'revoke') {
			await tx.billingGrant.updateMany({
				where: { purchaseId: purchase.id, revokedAt: null },
				data: { revokedAt: new Date() },
			})
		}
	})
}

export async function markReview(db: PrismaClient, purchase: BillingPurchase, reason: string) {
	if (purchase.status === 'refunded') return
	await transition(db, purchase, { status: 'review', lastError: reason, nextSyncAt: null })
	console.warn('[BILLING] Reconciliation requires review', { purchaseId: purchase.id, code: reason })
}

interface PaymentEvidence {
	checkoutId?: string | undefined
	eventType?: string | undefined
	preparationOnly?: boolean | undefined
}

export function paymentMatches(purchase: BillingPurchase, payment: AsaasPayment, checkoutId?: string) {
	if (!purchase.submittedAt || (purchase.providerPaymentId && purchase.providerPaymentId !== payment.id)) return false
	if (payment.billingType !== asaasMethods[purchase.method] || payment.subscription || payment.installment) return false
	if (payment.currency && payment.currency !== purchase.currency) return false
	const collectedCents = asaasCents(payment.value)
	if (collectedCents === null || collectedCents < purchase.amountCents ||
		asaasCents(payment.originalValue ?? payment.value) !== purchase.amountCents) return false
	if (purchase.method === 'credit_card') {
		const paymentCheckout = payment.checkoutSession ?? checkoutId
		return Boolean(paymentCheckout &&
			(!purchase.providerCheckoutId || purchase.providerCheckoutId === paymentCheckout) &&
			(!checkoutId || checkoutId === paymentCheckout) &&
			(!payment.externalReference || payment.externalReference === purchase.id) &&
			(purchase.providerCheckoutId || checkoutId || payment.externalReference === purchase.id))
	}
	return !payment.checkoutSession &&
		payment.externalReference === purchase.id &&
		purchase.providerCustomerId !== null &&
		purchase.providerCustomerId === payment.customer
}

export async function applyPayment(
	db: PrismaClient, purchase: BillingPurchase, payment: AsaasPayment, evidence: PaymentEvidence = {},
) {
	if (!paymentMatches(purchase, payment, evidence.checkoutId)) {
		await markReview(db, purchase, 'payment_mismatch')
		throw new ReconciliationError('payment_mismatch')
	}
	if (purchase.status === 'refunded') return

	let status = paymentStatus(purchase.method, payment.status, payment)
	const type = evidence.eventType
	if (type === 'PAYMENT_BANK_SLIP_CANCELLED' && purchase.method === 'boleto' && payment.status === 'OVERDUE') {
		status = 'cancelled'
	}
	const partialRefund = type === 'PAYMENT_PARTIALLY_REFUNDED' || /PARTIAL/.test(payment.status) ||
		purchase.lastError === 'partial_refund' ||
		payment.refunds?.some((refund) => refund.status === 'DONE' && refund.value > 0)
	if (partialRefund && status !== 'refunded' && status !== 'disputed' && status !== 'cancelled') status = 'review'
	const awaitingPayment = isPayable(status) || status === 'processing'
	if ((type === 'PAYMENT_REFUNDED' && status !== 'refunded') ||
		(type === 'PAYMENT_RECEIVED' && awaitingPayment && payment.status !== 'RECEIVED_IN_CASH') ||
		(type === 'PAYMENT_CONFIRMED' && awaitingPayment &&
			payment.status !== 'CONFIRMED' && payment.status !== 'RECEIVED_IN_CASH') ||
		(type === 'PAYMENT_DELETED' && awaitingPayment) ||
		(type === 'CHECKOUT_PAID' && awaitingPayment) ||
		((type === 'PAYMENT_CHARGEBACK_REQUESTED' || type === 'PAYMENT_CHARGEBACK_DISPUTE') && awaitingPayment)) {
		throw new ReconciliationError('payment_state_not_visible')
	}
	if (evidence.preparationOnly && status === 'paid') status = 'processing'
	if ((purchase.status === 'paid' || purchase.status === 'disputed') &&
		(isPayable(status) || status === 'processing')) return
	if (purchase.status === 'cancelled' && status === 'overdue') return

	const now = new Date()
	const providerPaidAt = [payment.confirmedDate, payment.paymentDate, payment.clientPaymentDate]
		.flatMap((date) => date ? [asaasDate(date)] : [])
		.find((date) => date !== null && date >= purchase.createdAt && date <= now)
	const confirmedAt = purchase.confirmedAt ?? (status === 'paid' ? providerPaidAt ?? now : null)
	const lastError = status === 'review' ? (partialRefund ? 'partial_refund' : 'provider_state_review') : null
	const needsInstructions = purchase.method !== 'credit_card' && isPayable(status) && !purchase.instructions
	const grant = status === 'paid' ? 'activate' :
		(status === 'refunded' || status === 'disputed' || status === 'cancelled') ? 'revoke' : 'preserve'
	await transition(db, purchase, {
		status,
		providerPaymentId: payment.id,
		providerCheckoutId: purchase.providerCheckoutId ?? payment.checkoutSession ?? evidence.checkoutId ?? null,
		confirmedAt,
		lastError,
		nextSyncAt: needsInstructions ? now : null,
	}, grant)
	if (lastError && lastError !== purchase.lastError) {
		console.warn('[BILLING] Reconciliation requires review', { purchaseId: purchase.id, code: lastError })
	}
	return purchase.revision + 1
}

export async function storeInstructions(db: PrismaClient, gateway: AsaasGateway, purchase: BillingPurchase, payment: AsaasPayment) {
	if (purchase.method === 'credit_card' || !isPayable(purchase.status) || purchase.instructions ||
		payment.status === 'CONFIRMED' || payment.status === 'RECEIVED_IN_CASH') return
	const instructions = await gateway.paymentInstructions(payment, purchase.method)
	const instructionsUntil = 'expiresAt' in instructions ? new Date(instructions.expiresAt) : null
	const result = await db.billingPurchase.updateMany({
		where: { id: purchase.id, revision: purchase.revision, status: { in: ['pending', 'overdue'] } },
		data: { instructions, instructionsUntil, nextSyncAt: null, revision: { increment: 1 } },
	})
	if (result.count !== 1) throw new ReconciliationError('concurrent_update')
}
