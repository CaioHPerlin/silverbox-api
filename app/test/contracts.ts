import assert from 'node:assert/strict'
import SwaggerParser from '@apidevtools/swagger-parser'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

const originalFetch = globalThis.fetch
export const observedOperations = new Set<string>()
export function assertOperationsCovered(operations: string[]): void {
	for (const operation of operations)
		assert.ok(observedOperations.has(operation), `Operation was not exercised: ${operation}`)
}

export async function validateHttpContracts(baseURL: string): Promise<void> {
	const schemaResponse = await originalFetch(`${baseURL}/docs.json`)
	assert.equal(schemaResponse.status, 200)
	const document = await schemaResponse.json()
	await SwaggerParser.validate(structuredClone(document))
	const spec = (await SwaggerParser.dereference(document)) as any
	const ajv = new Ajv({ strict: false, allErrors: true })
	addFormats(ajv)
	const paths = Object.keys(spec.paths).sort(
		(a, b) => (a.match(/\{/g)?.length ?? 0) - (b.match(/\{/g)?.length ?? 0),
	)
	globalThis.fetch = async (input, init) => {
		const result = await originalFetch(input, init)
		const url = new URL(input instanceof Request ? input.url : String(input))
		if (url.origin !== baseURL) return result
		const path = paths.find((path) =>
			new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(url.pathname),
		)
		const method = (
			init?.method ?? (input instanceof Request ? input.method : 'GET')
		).toLowerCase()
		const operation = path && spec.paths[path][method]
		if (!operation) return result
		const response = operation.responses[result.status]
		assert.ok(response, `${method.toUpperCase()} ${path}: undocumented status ${result.status}`)
		const copy = result.clone()
		if (response.content?.['application/json']) {
			assert.match(result.headers.get('content-type') ?? '', /application\/json/)
			const value = await copy.json()
			const valid = ajv.compile(response.content['application/json'].schema)
			assert.ok(
				valid(value),
				`${method.toUpperCase()} ${path} ${result.status}: ${ajv.errorsText(valid.errors)}`,
			)
		} else if (response.content?.['*/*']) {
			const bytes = await copy.arrayBuffer()
			assert.equal(result.headers.get('content-length'), String(bytes.byteLength))
			assert.match(result.headers.get('content-disposition') ?? '', /^attachment;/)
		} else if (result.status === 204) {
			assert.equal((await copy.arrayBuffer()).byteLength, 0)
		}
		observedOperations.add(`${method.toUpperCase()} ${path}`)
		return result
	}
}
