import swaggerJsdoc from 'swagger-jsdoc'
import { env } from './env.js'

type Schema = Record<string, unknown>
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` })
const str = (extra: Schema = {}): Schema => ({ type: 'string', ...extra })
const integer = (extra: Schema = {}): Schema => ({ type: 'integer', ...extra })
const date = str({ format: 'date-time' })
const object = (
	properties: Record<string, Schema>,
	required = Object.keys(properties),
): Schema => ({ type: 'object', properties, ...(required.length ? { required } : {}) })
const array = (items: Schema): Schema => ({ type: 'array', items })
const json = (schema: Schema) => ({ 'application/json': { schema } })
const response = (description: string, schema?: Schema) => ({
	description,
	...(schema ? { content: json(schema) } : {}),
})
const param = (
	name: string,
	where = 'path',
	schema: Schema = integer({ minimum: 1 }),
	required = where === 'path',
	description?: string,
) => ({ name, in: where, required, schema, ...(description ? { description } : {}) })
const ids = [param('id')]
const versionIds = [...ids, param('versionId')]
const body = (schema: Schema) => ({ required: true, content: json(schema) })
const binaryBody = {
	required: true,
	content: { 'application/octet-stream': { schema: str({ format: 'binary' }) } },
}
const binaryResponse = {
	description: 'Bytes originais. O cliente pode conferir o SHA-256 retornado nos metadados.',
	headers: {
		'Content-Length': { schema: str() },
		'Content-Disposition': {
			schema: str(),
			description: "attachment; filename*=UTF-8''<nome codificado>",
		},
		'X-Content-Type-Options': { schema: str({ enum: ['nosniff'] }) },
	},
	content: { '*/*': { schema: str({ format: 'binary' }) } },
}
const errors = (statuses: number[]) =>
	Object.fromEntries(
		statuses.map((status) => [
			status,
			response(
				(
					{
						400: 'Corpo, identificador, tamanho ou configuração do provedor inválido',
						401: 'Sessão ausente ou inválida',
						403: 'Origem não permitida',
						404: 'Recurso inexistente ou de outro usuário',
						409: 'Conflito: pasta não vazia, ciclo ou estado incompatível',
						410: 'Link expirado, revogado ou arquivo indisponível',
						413: 'Limite por arquivo ou cota individual excedido',
						415: 'Use application/octet-stream',
						429: 'Transferências simultâneas excedidas; Retry-After: 1',
						500: 'Falha interna',
						503: 'Banco ou armazenamento indisponível',
						507: 'Teto global, margem de segurança ou capacidade do disco insuficiente',
					} as Record<number, string>
				)[status] ?? 'Erro',
				ref('Error'),
			),
		]),
	)
const op = (
	tag: string,
	summary: string,
	success: Record<string, unknown>,
	options: {
		parameters?: unknown[]
		requestBody?: unknown
		public?: boolean
		errors?: number[]
		description?: string
	} = {},
) => ({
	tags: [tag],
	summary,
	...(options.description ? { description: options.description } : {}),
	security: options.public ? [] : [{ sessionCookie: [] }],
	...(options.parameters ? { parameters: options.parameters } : {}),
	...(options.requestBody ? { requestBody: options.requestBody } : {}),
	responses: {
		...errors(
			options.public
				? [400, 403, 500, ...(options.errors ?? [])]
				: [400, 401, 403, 404, 500, ...(options.errors ?? [])],
		),
		...success,
	},
})
const name = str({ minLength: 1, maxLength: 255, example: 'documento.pdf' })
const folderId = integer({ minimum: 1, nullable: true, example: null })
const uploadHeaders = [
	param(
		'X-File-Name',
		'header',
		str(),
		true,
		'Nome original codificado com encodeURIComponent; também obrigatório em novas versões.',
	),
	param(
		'X-File-Size',
		'header',
		str({ pattern: '^\\d+$', example: '5' }),
		true,
		'Quantidade exata de bytes, até MAX_UPLOAD_BYTES (máximo 1 GiB).',
	),
	param(
		'X-File-Mime',
		'header',
		str({ default: 'application/octet-stream', example: 'text/plain' }),
		false,
		'Tipo MIME sem parâmetros.',
	),
]
const schemas: Record<string, Schema> = {
	User: object(
		{
			id: str({ example: '1' }),
			name: str(),
			email: str({ format: 'email' }),
			emailVerified: { type: 'boolean' },
			image: str({ nullable: true }),
			createdAt: date,
			updatedAt: date,
		},
		['id', 'name', 'email'],
	),
	RegisterRequest: object({
		name: str({ minLength: 1, maxLength: 155 }),
		email: str({ format: 'email' }),
		password: str({ format: 'password', minLength: 8, maxLength: 128 }),
	}),
	LoginRequest: object({ email: str({ format: 'email' }), password: str({ format: 'password' }) }),
	AuthResponse: object(
		{ user: ref('User'), token: str({ nullable: true }), redirect: { type: 'boolean' } },
		['user', 'token'],
	),
	Folder: object({
		id: integer(),
		userId: integer(),
		parentFolderId: folderId,
		name,
		createdAt: date,
		updatedAt: date,
	}),
	FolderCreate: {
		...object({ name, parentFolderId: folderId }, ['name']),
		additionalProperties: false,
	},
	FolderUpdate: {
		...object({ name, parentFolderId: folderId }, []),
		minProperties: 1,
		additionalProperties: false,
	},
	File: object({
		id: integer(),
		folderId,
		originalName: name,
		sizeBytes: integer({ minimum: 0, maximum: 1073741824 }),
		mimeType: str(),
		checksum: str({ pattern: '^[a-f0-9]{64}$' }),
		isDeleted: { type: 'boolean' },
		createdAt: date,
		updatedAt: date,
	}),
	FileUpdate: {
		...object({ originalName: name, folderId }, []),
		minProperties: 1,
		additionalProperties: false,
	},
	Version: object({
		id: integer(),
		versionNumber: integer(),
		sizeBytes: integer({ minimum: 0 }),
		checksum: str({ pattern: '^[a-f0-9]{64}$' }),
		mimeType: str(),
		createdAt: date,
	}),
	Share: object({
		id: integer(),
		expiresAt: date,
		revokedAt: { ...date, nullable: true },
		createdAt: date,
	}),
	ShareCreate: {
		...object(
			{ expiresInSeconds: integer({ minimum: 60, maximum: 604800, default: 86400 }) },
			[],
		),
		additionalProperties: false,
	},
	ShareCreated: object({ id: integer(), url: str({ format: 'uri' }), expiresAt: date }),
	Usage: object(
		Object.fromEntries(
			['usedBytes', 'reservedBytes', 'limitBytes', 'availableBytes'].map((key) => [
				key,
				str({ pattern: '^\\d+$' }),
			]),
		),
	),
	Error: {
		type: 'object',
		properties: { error: str(), message: str(), code: str(), issues: array({ type: 'object' }) },
		anyOf: [{ required: ['error'] }, { required: ['message'] }],
	},
	Health: object({ status: str({ enum: ['ok', 'unavailable'] }) }),
}
const fileResponse = response(
	'Metadados do arquivo; nenhum caminho físico é exposto.',
	object({ file: ref('File') }),
)
const versionResponse = response(
	'Versão criada, incluindo bytes contabilizados na cota.',
	object({ version: ref('Version') }),
)
const uploadErrors = [409, 413, 415, 429, 503, 507]
const paths: Record<string, unknown> = {
	'/': {
		get: op(
			'Health',
			'Identificar a API',
			{ 200: response('API ativa', object({ message: str({ example: 'Hello, World' }) })) },
			{ public: true },
		),
	},
	'/health/live': {
		get: op(
			'Health',
			'Verificar processo ativo',
			{ 200: response('Processo ativo', ref('Health')) },
			{ public: true },
		),
	},
	'/health/ready': {
		get: op(
			'Health',
			'Verificar banco e diretório privado',
			{
				200: response('Pronta', ref('Health')),
				503: response('Dependência indisponível', ref('Health')),
			},
			{ public: true },
		),
	},
	'/auth/register': {
		post: op(
			'Auth',
			'Cadastrar e iniciar sessão',
			{
				200: {
					...response('Usuário e sessão criados', ref('AuthResponse')),
					headers: {
						'Set-Cookie': {
							schema: str(),
							description: 'Sessão HttpOnly; prefixo __Secure- em HTTPS.',
						},
					},
				},
			},
			{ public: true, requestBody: body(ref('RegisterRequest')), errors: [422, 429] },
		),
	},
	'/auth/login': {
		post: op(
			'Auth',
			'Entrar com e-mail e senha',
			{
				200: {
					...response('Sessão criada', ref('AuthResponse')),
					headers: { 'Set-Cookie': { schema: str() } },
				},
			},
			{ public: true, requestBody: body(ref('LoginRequest')), errors: [401, 429] },
		),
	},
	'/auth/logout': {
		post: op(
			'Auth',
			'Encerrar sessão',
			{ 200: response('Cookie invalidado', object({ success: { type: 'boolean' } })) },
			{ requestBody: body({ type: 'object', example: {} }) },
		),
	},
	'/users/me': {
		get: op('Auth', 'Consultar usuário autenticado', {
			200: response('Usuário atual', object({ user: ref('User') })),
		}),
	},
	'/auth/google': {
		get: op(
			'Auth',
			'Iniciar login Google no navegador',
			{
				302: {
					description:
						'Redirecionamento ao Google; mantém o cookie de estado no mesmo navegador.',
					headers: {
						Location: { schema: str({ format: 'uri' }) },
						'Set-Cookie': { schema: str() },
					},
				},
			},
			{
				public: true,
				errors: [404, 502],
				description:
					'Requer GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET. Abra esta URL no navegador para concluir o consentimento.',
			},
		),
	},
	'/api/auth/callback/google': {
		get: op(
			'Auth',
			'Callback OAuth usado pelo Google',
			{
				302: {
					description: 'Conclui ou redireciona o resultado do OAuth.',
					headers: { Location: { schema: str() }, 'Set-Cookie': { schema: str() } },
				},
			},
			{
				public: true,
				parameters: ['code', 'state', 'error', 'error_description'].map((key) =>
					param(key, 'query', str(), false),
				),
				description:
					'Chamado pelo Google. Não fabricar código/estado nem iniciar o fluxo por aqui.',
			},
		),
	},
	'/folders': {
		get: op(
			'Folders',
			'Listar pastas filhas; raiz por padrão',
			{ 200: response('Pastas', object({ folders: array(ref('Folder')) })) },
			{ parameters: [param('parentFolderId', 'query')] },
		),
		post: op(
			'Folders',
			'Criar pasta',
			{ 201: response('Pasta criada', object({ folder: ref('Folder') })) },
			{ requestBody: body(ref('FolderCreate')) },
		),
	},
	'/folders/{id}': {
		patch: op(
			'Folders',
			'Renomear ou mover pasta',
			{ 200: response('Pasta atualizada', object({ folder: ref('Folder') })) },
			{ parameters: ids, requestBody: body(ref('FolderUpdate')), errors: [409] },
		),
		delete: op(
			'Folders',
			'Excluir pasta vazia',
			{ 204: response('Pasta removida; sem corpo') },
			{ parameters: ids, errors: [409] },
		),
	},
	'/storage/usage': {
		get: op('Storage', 'Consultar cota individual, incluindo lixeira, versões e reservas', {
			200: response('Contadores BIGINT em strings decimais', ref('Usage')),
		}),
	},
	'/files': {
		post: op(
			'Files',
			'Enviar arquivo em fluxo',
			{ 201: fileResponse },
			{
				requestBody: binaryBody,
				parameters: [...uploadHeaders, param('X-Folder-Id', 'header')],
				errors: uploadErrors,
			},
		),
		get: op(
			'Files',
			'Listar arquivos ativos da pasta; raiz por padrão',
			{
				200: response(
					'Lista paginada',
					object({
						files: array(ref('File')),
						page: integer(),
						limit: integer(),
						total: integer(),
					}),
				),
			},
			{
				parameters: [
					param('folderId', 'query'),
					param('page', 'query', integer({ minimum: 1, default: 1 })),
					param('limit', 'query', integer({ minimum: 1, maximum: 100, default: 50 })),
				],
			},
		),
	},
	'/files/trash': {
		get: op('Files', 'Listar lixeira', {
			200: response('Arquivos retidos na cota', object({ files: array(ref('File')) })),
		}),
	},
	'/files/{id}': {
		get: op(
			'Files',
			'Consultar metadados do arquivo ativo',
			{ 200: fileResponse },
			{ parameters: ids },
		),
		patch: op(
			'Files',
			'Renomear ou mover arquivo',
			{ 200: fileResponse },
			{ parameters: ids, requestBody: body(ref('FileUpdate')) },
		),
		delete: op(
			'Files',
			'Mover para lixeira e revogar links',
			{ 204: response('Movido; sem corpo') },
			{ parameters: ids },
		),
	},
	'/files/{id}/download': {
		get: op(
			'Files',
			'Baixar versão atual',
			{ 200: binaryResponse },
			{ parameters: ids, errors: [503] },
		),
	},
	'/files/{id}/restore': {
		post: op(
			'Files',
			'Restaurar da lixeira; links continuam revogados',
			{ 200: fileResponse },
			{ parameters: ids, errors: [409] },
		),
	},
	'/files/{id}/permanent': {
		delete: op(
			'Files',
			'Excluir definitivamente um arquivo na lixeira',
			{
				204: response('Bytes e metadados removidos; sem corpo'),
				202: response(
					'Exclusão pendente para nova tentativa',
					object({ status: str({ enum: ['deleting'] }) }),
				),
			},
			{ parameters: ids, errors: [409] },
		),
	},
	'/files/{id}/versions': {
		post: op(
			'Files',
			'Enviar nova versão preservando as anteriores',
			{ 201: versionResponse },
			{ parameters: [...ids, ...uploadHeaders], requestBody: binaryBody, errors: uploadErrors },
		),
		get: op(
			'Files',
			'Listar histórico; permitido na lixeira',
			{
				200: response(
					'Versões em ordem decrescente',
					object({ versions: array(ref('Version')) }),
				),
			},
			{ parameters: ids },
		),
	},
	'/files/{id}/versions/{versionId}/download': {
		get: op(
			'Files',
			'Baixar versão específica de arquivo ativo',
			{ 200: binaryResponse },
			{ parameters: versionIds, errors: [503] },
		),
	},
	'/files/{id}/versions/{versionId}/restore': {
		post: op(
			'Files',
			'Copiar versão antiga para uma nova versão; exige cota',
			{ 201: versionResponse },
			{ parameters: versionIds, errors: [409, 413, 429, 503, 507] },
		),
	},
	'/files/{id}/shares': {
		post: op(
			'Shares',
			'Criar link temporário',
			{ 201: response('URL revelada uma única vez', ref('ShareCreated')) },
			{ parameters: ids, requestBody: body(ref('ShareCreate')) },
		),
		get: op(
			'Shares',
			'Listar links sem revelar tokens',
			{ 200: response('Links', object({ shares: array(ref('Share')) })) },
			{ parameters: ids },
		),
	},
	'/files/{id}/shares/{shareId}': {
		delete: op(
			'Shares',
			'Revogar link para as próximas requisições',
			{ 204: response('Link revogado; sem corpo') },
			{ parameters: [...ids, param('shareId')] },
		),
	},
	'/shares/{token}': {
		get: op(
			'Shares',
			'Baixar arquivo por link temporário público',
			{ 200: binaryResponse },
			{
				public: true,
				parameters: [param('token', 'path', str({ minLength: 43, maxLength: 43 }))],
				errors: [404, 410, 503],
			},
		),
	},
}
// Native aliases already exposed by Better Auth; same request and response contract.
for (const [native, alias] of [
	['/api/auth/sign-up/email', '/auth/register'],
	['/api/auth/sign-in/email', '/auth/login'],
	['/api/auth/sign-out', '/auth/logout'],
] as const)
	paths[native] = paths[alias]
paths['/api/auth/get-session'] = {
	get: op(
		'Auth',
		'Consultar sessão nativa Better Auth',
		{
			200: response('Sessão ou null', {
				type: 'object',
				nullable: true,
				properties: { user: ref('User'), session: { type: 'object' } },
			}),
		},
		{ public: true },
	),
}

export const swaggerSpec = swaggerJsdoc({
	definition: {
		openapi: '3.0.3',
		info: {
			title: 'Silverbox API',
			version: '1.0.0',
			description:
				'Entre por /auth/register ou /auth/login no Try it out para usar a sessão HttpOnly. Use o mesmo hostname em todas as chamadas. Uploads recebem bytes brutos, não multipart. Em HTTPS o cookie usa o prefixo __Secure-.',
		},
		servers: [{ url: env.BETTER_AUTH_URL, description: 'Origem pública configurada' }],
		tags: ['Auth', 'Folders', 'Files', 'Shares', 'Storage', 'Health'].map((name) => ({ name })),
		components: {
			securitySchemes: {
				sessionCookie: {
					type: 'apiKey',
					in: 'cookie',
					name: env.BETTER_AUTH_URL.startsWith('https:')
						? '__Secure-better-auth.session_token'
						: 'better-auth.session_token',
					description:
						'Cookie HttpOnly obtido no cadastro/login; o navegador o envia automaticamente.',
				},
			},
			schemas,
		},
		paths,
	},
	apis: [],
})
