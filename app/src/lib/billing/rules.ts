import type { Cycle, PaymentMethod } from './catalog.js'

export const asaasScope = { provider: 'asaas', environment: 'sandbox' } as const
export const checkoutMinutes = 30
export const asaasMethods = { credit_card: 'CREDIT_CARD', pix: 'PIX', boleto: 'BOLETO' } as const
export const purchaseStatuses = [
	'preparing', 'pending', 'processing', 'overdue', 'paid', 'expired', 'cancelled', 'refunded', 'disputed', 'review', 'failed',
] as const
export type PurchaseStatus = (typeof purchaseStatuses)[number]

export type PaymentInstructions =
	| { url: string }
	| { qrCodeBase64: string; copyPaste: string; expiresAt: string }
	| { url: string; digitableLine: string; dueDate: string }

export function normalizeCpf(value: string): string | null {
	if (!/^(?:\d{11}|\d{3}\.\d{3}\.\d{3}-\d{2})$/.test(value)) return null
	const cpf = value.replace(/\D/g, '')
	if (/^(\d)\1{10}$/.test(cpf)) return null
	for (const length of [9, 10]) {
		const sum = [...cpf.slice(0, length)].reduce((total, digit, index) => total + Number(digit) * (length + 1 - index), 0)
		if (((sum * 10) % 11) % 10 !== Number(cpf[length])) return null
	}
	return cpf
}

export function asaasCents(value: number): number | null {
	const scaled = value * 100
	const cents = Math.round(scaled)
	return Number.isSafeInteger(cents) && Math.abs(scaled - cents) < 1e-6 ? cents : null
}

export function periodEnd(start: Date, cycle: Cycle): Date {
	const end = new Date(start)
	const day = end.getUTCDate()
	end.setUTCDate(1)
	end.setUTCMonth(end.getUTCMonth() + (cycle === 'year' ? 12 : 1))
	const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate()
	end.setUTCDate(Math.min(day, lastDay))
	return end
}

export function asaasDate(value: string): Date | null {
	let normalized = value.replace(' ', 'T')
	if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) normalized += 'T00:00:00'
	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(normalized)) normalized += '-03:00'
	const date = new Date(normalized)
	return Number.isNaN(date.getTime()) ? null : date
}

export function paymentStatus(
	method: PaymentMethod,
	remoteStatus: string,
	options: { deleted?: boolean | undefined; canBePaidAfterDueDate?: boolean | null | undefined },
): PurchaseStatus {
	if (options.deleted) return 'cancelled'
	switch (remoteStatus) {
		case 'RECEIVED':
			return 'paid'
		case 'CONFIRMED':
			return method === 'pix' ? 'processing' : 'paid'
		case 'OVERDUE':
			return method === 'boleto' && options.canBePaidAfterDueDate === false ? 'cancelled' : 'overdue'
		case 'REFUNDED':
			return 'refunded'
		case 'CHARGEBACK_REQUESTED':
		case 'CHARGEBACK_DISPUTE':
		case 'AWAITING_CHARGEBACK_REVERSAL':
			return 'disputed'
		case 'REFUND_REQUESTED':
		case 'REFUND_IN_PROGRESS':
		case 'PARTIALLY_REFUNDED':
		case 'REFUNDED_PARTIALLY':
			return 'review'
		case 'DELETED':
		case 'CANCELED':
		case 'CANCELLED':
			return 'cancelled'
		case 'AUTHORIZED':
		case 'AWAITING_RISK_ANALYSIS':
		case 'RECEIVED_IN_CASH':
			return 'processing'
		case 'PENDING':
		case 'DUNNING_REQUESTED':
		case 'DUNNING_RECEIVED':
			return 'pending'
		default:
			return 'review'
	}
}

export function isPayable(status: PurchaseStatus): boolean {
	return status === 'pending' || status === 'overdue'
}
