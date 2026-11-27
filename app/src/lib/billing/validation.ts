import { z } from 'zod'
import { cycles, paidPlans, paymentMethods } from './catalog.js'
import { asaasEnvironments, normalizeCpf } from './rules.js'

export const purchaseIdSchema = z.uuid()
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)

const cpfSchema = z.string().transform((value, context) => {
	const normalized = normalizeCpf(value)
	if (normalized) return normalized
	context.addIssue({ code: 'custom', message: 'CPF inválido.' })
	return z.NEVER
})

export const checkoutSchema = z.strictObject({
	planCode: z.enum(paidPlans),
	cycle: z.enum(cycles),
	seats: z.number().int().min(1).max(100),
	method: z.enum(paymentMethods),
	billingEnvironment: z.enum(asaasEnvironments).optional(),
	payerCpf: cpfSchema.optional(),
}).refine((value) => value.method !== 'credit_card' || value.payerCpf === undefined, {
	path: ['payerCpf'],
	message: 'Informe os dados do pagador na página de cartão do Asaas.',
})

export type CheckoutSelection = z.infer<typeof checkoutSchema>
