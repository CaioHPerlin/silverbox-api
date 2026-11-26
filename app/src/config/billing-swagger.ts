import { checkoutReturnStatuses } from '../lib/billing/asaas.js'
import { cycles, paidPlans, paymentMethods } from '../lib/billing/catalog.js'
import { purchaseStatuses } from '../lib/billing/rules.js'

type Schema = Record<string, unknown>
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const text = (properties: Schema = {}) => ({ type: 'string', ...properties })
const integer = (properties: Schema = {}) => ({ type: 'integer', ...properties })
const enumText = (values: readonly string[]) => text({ enum: values })
const boolean = { type: 'boolean' }
const object = (properties: Record<string, Schema>, required = Object.keys(properties)) => ({
	type: 'object', properties, required,
})
const array = (items: Schema) => ({ type: 'array', items })
const uuid = text({ format: 'uuid' })
const url = text({ format: 'uri' })
const cents = integer({ minimum: 0 })
const currency = enumText(['BRL'])
const nullableInteger = integer({ minimum: 0, nullable: true })
const selection = { planCode: enumText(paidPlans), cycle: enumText(cycles), seats: integer({ minimum: 1, maximum: 100 }) }
const selectionAndMethod = { ...selection, method: enumText(paymentMethods) }
const purchaseProperties = { id: uuid, ...selectionAndMethod, currency, amountCents: cents, status: enumText(purchaseStatuses) }
const checkoutExamples = {
	proMonthly: { summary: 'Pro mensal por Pix', value: { planCode: 'pro', cycle: 'month', seats: 1, method: 'pix' } },
	proYearly: { summary: 'Pro anual por cartão', value: { planCode: 'pro', cycle: 'year', seats: 1, method: 'credit_card' } },
	teamMonthly: { summary: 'Team mensal por cartão', value: { planCode: 'team', cycle: 'month', seats: 3, method: 'credit_card' } },
	teamYearly: { summary: 'Team anual por Pix', value: { planCode: 'team', cycle: 'year', seats: 3, method: 'pix' } },
	businessMonthly: { summary: 'Business mensal por boleto', value: { planCode: 'business', cycle: 'month', seats: 5, method: 'boleto' } },
	businessYearly: { summary: 'Business anual por boleto', value: { planCode: 'business', cycle: 'year', seats: 5, method: 'boleto' } },
}

export const billingSchemas = {
	PricingPlan: object({
		code: enumText(['free', ...paidPlans]), name: text(), audience: text(), description: text(),
		status: enumText(['available', 'coming-soon']), monthlyPriceCents: cents, yearlyPriceCents: cents,
		perSeat: boolean, seatMin: integer(), seatMax: integer(), featured: boolean, checkoutEnabled: boolean,
		storageBytes: integer(), egressBytes: nullableInteger, maxFileBytes: integer(),
		versionDays: nullableInteger, trashDays: nullableInteger, highlights: array(text()),
	}, [
		'code', 'name', 'audience', 'description', 'status', 'monthlyPriceCents', 'yearlyPriceCents',
		'perSeat', 'seatMin', 'seatMax', 'checkoutEnabled', 'storageBytes', 'egressBytes', 'maxFileBytes',
		'versionDays', 'trashDays', 'highlights',
	]),
	PlanCatalog: object({ currency, paymentMethods: array(enumText(paymentMethods)), plans: array(ref('PricingPlan')) }),
	PlanCheckout: {
		...object({
			...selectionAndMethod,
			payerCpf: text({
				pattern: '^(?:[0-9]{11}|[0-9]{3}\\.[0-9]{3}\\.[0-9]{3}-[0-9]{2})$',
				description: 'CPF do primeiro pagador de Pix ou boleto.',
			}),
		}, Object.keys(selectionAndMethod)),
		additionalProperties: false,
	},
	PlanPurchase: {
		oneOf: [
			{ method: 'credit_card', instructions: object({ url }) },
			{ method: 'pix', instructions: object({ qrCodeBase64: text(), copyPaste: text(), expiresAt: text({ format: 'date-time' }) }) },
			{ method: 'boleto', instructions: object({ url, digitableLine: text(), dueDate: text({ format: 'date' }) }) },
		].map(({ method, instructions }) => object(
			{ ...purchaseProperties, method: enumText([method]), paymentInstructions: instructions },
			Object.keys(purchaseProperties),
		)),
	},
	AsaasEvent: object({
		id: text({ maxLength: 160 }), event: text({ maxLength: 64 }),
		payment: object({ id: text() }), checkout: object({ id: text() }),
	}, ['id', 'event']),
}

const json = (schema: Schema) => ({ 'application/json': { schema } })
const response = (description: string, schema: Schema) => ({ description, content: json(schema) })
const problem = (description: string) => response(description, ref('Error'))
const success = (description: string) => response(description, ref('PlanPurchase'))
const session = [{ sessionCookie: [] }]
const errors = {
	400: problem('Dados inválidos.'),
	401: problem('Sessão ausente ou inválida.'),
	413: problem('Corpo da requisição acima do limite.'),
	415: problem('Formato inválido. Envie JSON.'),
	500: problem('Erro interno.'),
	503: problem('Integração de cobrança desabilitada.'),
}

export const billingPaths = {
	'/plans': {
		get: {
			tags: ['Plans'], summary: 'Consulta o catálogo comercial', security: [],
			responses: { 200: response('Catálogo público com valores em centavos de real.', ref('PlanCatalog')) },
		},
	},
	'/plans/checkout': {
		post: {
			tags: ['Plans'], summary: 'Cria ou recupera uma compra avulsa', security: session,
			description: 'O checkout opera em Asaas Sandbox. Calcula o valor integral do ciclo em centavos e aplica a quantidade de pessoas. Na primeira compra por Pix ou boleto, adicione payerCpf ao exemplo.',
			parameters: [{
				in: 'header', name: 'Idempotency-Key', required: true,
				description: 'Reutilize a mesma chave em todas as tentativas da mesma compra.',
				schema: text({ pattern: '^[A-Za-z0-9_.:-]{1,128}$' }),
			}],
			requestBody: {
				required: true,
				content: { 'application/json': { schema: ref('PlanCheckout'), examples: checkoutExamples } },
			},
			responses: {
				...errors,
				200: success('Compra existente ou com estado conclusivo.'),
				201: success('Compra criada com instruções de pagamento.'),
				202: success('Compra em preparação ou conciliação. Consulte o estado pelo ID.'),
				403: problem('Origem não autorizada para cobrança.'),
				409: problem('Chave de idempotência já associada a outra seleção.'),
				422: problem('Limite de valor excedido ou cadastro do pagador recusado.'),
			},
		},
	},
	'/plans/purchases/{id}': {
		get: {
			tags: ['Plans'], summary: 'Consulta a compra do titular', security: session,
			parameters: [{ in: 'path', name: 'id', required: true, schema: uuid }],
			responses: {
				200: success('Estado da compra e instruções disponíveis.'),
				401: errors[401], 404: problem('Compra não encontrada.'), 500: errors[500],
			},
		},
	},
	'/plans/return': {
		get: {
			tags: ['Plans'], summary: 'Redireciona o retorno do checkout para o frontend', security: [],
			parameters: [
				{ in: 'query', name: 'purchaseId', required: true, schema: uuid },
				{ in: 'query', name: 'checkout', required: true, schema: enumText(checkoutReturnStatuses) },
			],
			responses: {
				302: {
					description: 'Redireciona o navegador para a página de planos configurada.',
					headers: { Location: { schema: url } },
				},
				400: errors[400], 404: problem('Retorno público do checkout desabilitado.'),
			},
		},
	},
	'/webhooks/asaas': {
		post: {
			tags: ['Billing'], summary: 'Recebe eventos do Asaas',
			security: [{ asaasWebhookToken: [] }],
			requestBody: { required: true, content: json(ref('AsaasEvent')) },
			responses: {
				...errors,
				200: response('Evento persistido ou já recebido.', object({ received: boolean })),
				401: problem('Token de webhook inválido.'),
			},
		},
	},
}
