import swaggerJsdoc from 'swagger-jsdoc'
import { env } from './env.js'
import { billingPaths, billingSchemas } from './billing-swagger.js'

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
			schema: str({ pattern: '^attachment;' }),
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
						415: 'Tipo ou codificação do corpo incompatível com a operação',
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
const sharePermission = str({ enum: ['view', 'download'] })
const shareExpiry = { ...date, nullable: true }
const userRole = str({ enum: ['user', 'admin'] })
const userId = str({ pattern: '^\\d+$', example: '1' })
const adminUnauthorized = response('Sessão ausente ou inválida; sem corpo')
const adminForbidden = response(
	'Sessão sem permissão administrativa ou origem não permitida',
	ref('Error'),
)
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
			id: userId,
			name: str(),
			email: str({ format: 'email' }),
			emailVerified: { type: 'boolean' },
			image: str({ nullable: true }),
			role: str({ description: 'Papéis registrados pelo Better Auth, separados por vírgula.' }),
			createdAt: date,
			updatedAt: date,
		},
		['id', 'name', 'email'],
	),
	SessionUser: { allOf: [ref('User'), object({ role: userRole })] },
	RegisterRequest: object({
		name: str({ minLength: 1, maxLength: 155 }),
		email: str({ format: 'email' }),
		password: str({ format: 'password', minLength: 8, maxLength: 128 }),
	}),
	LoginRequest: object({ email: str({ format: 'email' }), password: str({ format: 'password' }) }),
	PasswordResetRequest: object(
		{ email: str({ format: 'email' }), redirectTo: str({ format: 'uri' }) },
		['email'],
	),
	PasswordResetResponse: object({ status: { type: 'boolean' }, message: str() }),
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
	SearchItem: object({
		kind: str({ enum: ['file', 'folder'] }),
		id: integer(),
		name,
		folderId: {
			...folderId,
			description: 'Pasta onde o item está (para pastas, a pasta-mãe); null na raiz',
		},
		path: {
			...array(object({ id: integer(), name })),
			description: 'Pastas da raiz até o local do item, sem incluir o próprio item',
		},
		sizeBytes: integer({ minimum: 0, nullable: true, description: 'null para pastas' }),
		mimeType: str({ nullable: true, description: 'null para pastas' }),
		isDeleted: { type: 'boolean', description: 'true apenas com includeTrash=true' },
		createdAt: date,
		updatedAt: date,
	}),
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
		permission: sharePermission,
		expiresAt: shareExpiry,
		revokedAt: { ...date, nullable: true },
		createdAt: date,
	}),
	UserShare: object({
		id: integer(),
		permission: sharePermission,
		expiresAt: shareExpiry,
		revokedAt: { ...date, nullable: true },
		createdAt: date,
		file: object({
			id: integer(),
			originalName: name,
			mimeType: str(),
			sizeBytes: integer({ minimum: 0 }),
		}),
		sharedBy: object({ id: integer(), name: str() }),
		status: str({ enum: ['active', 'expired', 'revoked'] }),
	}),
	ShareCreate: {
		...object(
			{
				expiresInSeconds: integer({
					minimum: 60,
					maximum: 604800,
					default: 86400,
					nullable: true,
					description: 'Use null para criar um link sem expiração.',
				}),
				permission: { ...sharePermission, default: 'download' },
			},
			[],
		),
		additionalProperties: false,
	},
	ShareCreated: object({
		id: integer(),
		url: str({ format: 'uri' }),
		expiresAt: shareExpiry,
		permission: sharePermission,
	}),
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
		get: op(
			'Auth',
			'Consultar usuário autenticado e seu papel efetivo',
			{ 200: response('Usuário atual', object({ user: ref('SessionUser') })) },
			{ description: 'Retorna admin quando a conta tem esse papel e user nos demais casos.' },
		),
	},
	'/api/auth/admin/list-users': {
		get: op(
			'Admin',
			'Listar usuários com uma sessão administrativa',
			{
				200: response(
					'Usuários e contagem',
					object(
						{
							users: array(ref('User')),
							total: integer(),
							limit: integer(),
							offset: integer(),
						},
						['users', 'total'],
					),
				),
				401: adminUnauthorized,
				403: adminForbidden,
			},
			{
				parameters: [
					param('limit', 'query', integer({ minimum: 1 })),
					param('offset', 'query', integer({ minimum: 0 })),
				],
			},
		),
	},
	'/api/auth/admin/set-role': {
		post: op(
			'Admin',
			'Alterar os papéis de um usuário',
			{
				200: response('Usuário atualizado', object({ user: ref('User') })),
				409: response('A operação removeria o último administrador ativo', ref('Error')),
				403: adminForbidden,
			},
			{
				requestBody: body(object({ userId, role: { oneOf: [userRole, array(userRole)] } })),
				description: 'Sessões existentes passam a usar os novos papéis na próxima requisição.',
			},
		),
	},
	'/api/auth/admin/revoke-user-sessions': {
		post: op(
			'Admin',
			'Revogar todas as sessões de um usuário',
			{
				200: response('Sessões revogadas', object({ success: { type: 'boolean' } })),
				401: adminUnauthorized,
				403: adminForbidden,
			},
			{ requestBody: body(object({ userId })) },
		),
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
	'/search': {
		get: op(
			'Search',
			'Buscar arquivos e pastas pelo nome',
			{
				200: response(
					'Página de resultados',
					object({
						items: array(ref('SearchItem')),
						page: integer(),
						limit: integer(),
						total: integer({ minimum: 0 }),
					}),
				),
			},
			{
				description: [
					'Busca por trecho do nome, sem diferenciar maiúsculas/minúsculas nem acentos',
					'("relatorio" encontra "Relatório.pdf"). `%`, `_` e `\\` são tratados literalmente.',
					'Retorna somente itens do usuário da sessão. Arquivos na lixeira ficam de fora,',
					'salvo includeTrash=true; pastas não têm lixeira.',
					'Ordem estável: pastas antes de arquivos, depois nome e id.',
					'O filtro, a contagem e a paginação são feitos no banco.',
				].join(' '),
				parameters: [
					param(
						'q',
						'query',
						str({ minLength: 1, maxLength: 100 }),
						true,
						'Trecho do nome; espaços nas pontas são ignorados',
					),
					param(
						'scope',
						'query',
						str({ enum: ['all', 'folder'], default: 'all' }),
						false,
						'all: todas as pastas do usuário. folder: a pasta folderId (ou a raiz, se omitida) e todas as subpastas; a própria pasta não aparece no resultado.',
					),
					param(
						'folderId',
						'query',
						integer({ minimum: 1 }),
						false,
						'Somente com scope=folder',
					),
					param('type', 'query', str({ enum: ['all', 'file', 'folder'], default: 'all' })),
					param('includeTrash', 'query', str({ enum: ['true', 'false'], default: 'false' })),
					param('page', 'query', integer({ minimum: 1, maximum: 10000, default: 1 })),
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
			'Criar link de compartilhamento',
			{
				201: response('URL revelada uma única vez', ref('ShareCreated')),
				415: response('Tipo de arquivo incompatível com visualização', ref('Error')),
			},
			{ parameters: ids, requestBody: { ...body(ref('ShareCreate')), required: false } },
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
	'/shares': {
		get: op(
			'Shares',
			'Listar links criados pelo usuário',
			{
				200: response(
					'Links e metadados de paginação quando solicitados',
					object(
						{
							shares: array(ref('UserShare')),
							page: integer(),
							limit: integer(),
							total: integer(),
						},
						['shares'],
					),
				),
			},
			{
				parameters: [
					param('page', 'query', integer({ minimum: 1, maximum: 10000, default: 1 })),
					param('limit', 'query', integer({ minimum: 1, maximum: 100, default: 50 })),
					param('q', 'query', str({ maxLength: 155 }), false, 'Busca por nome do arquivo.'),
				],
				description:
					'Sem parâmetros, preserva a resposta { shares }. Com parâmetros, ordena por criação e ID decrescentes e devolve apenas a página solicitada. A resposta não contém tokens.',
			},
		),
	},
	'/shares/{shareId}/download': {
		get: op(
			'Shares',
			'Baixar arquivo pelo ID de um compartilhamento criado pelo usuário autenticado',
			{
				200: binaryResponse,
				403: response('Origem não permitida ou link sem permissão de download', ref('Error')),
			},
			{ parameters: [param('shareId')], errors: [410, 503] },
		),
	},
	'/shares/{token}': {
		get: op(
			'Shares',
			'Baixar arquivo por link público',
			{
				200: binaryResponse,
				403: response('Origem não permitida ou link sem permissão de download', ref('Error')),
			},
			{
				public: true,
				parameters: [param('token', 'path', str({ minLength: 43, maxLength: 43 }))],
				errors: [404, 410, 503],
			},
		),
	},
	'/shares/{token}/preview': {
		get: op(
			'Shares',
			'Visualizar arquivo por link público',
			{
				200: {
					...binaryResponse,
					description:
						'Conteúdo inline em sandbox. Suporta AVIF, GIF, JPEG, PNG, WebP e texto puro.',
					headers: {
						...binaryResponse.headers,
						'Content-Disposition': {
							schema: str({ pattern: '^inline;' }),
							description: "inline; filename*=UTF-8''<nome codificado>",
						},
						'Content-Security-Policy': { schema: str() },
						'Referrer-Policy': { schema: str({ enum: ['no-referrer'] }) },
					},
				},
				415: response('Tipo de arquivo incompatível com visualização', ref('Error')),
			},
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
		{
			public: true,
			description: 'O campo user.role contém os papéis registrados pelo Better Auth.',
		},
	),
}
paths['/api/auth/request-password-reset'] = {
	post: op(
		'Auth',
		'Solicitar recuperação de senha',
		{
			200: response(
				'Solicitação aceita; o corpo é igual para e-mails cadastrados e desconhecidos.',
				ref('PasswordResetResponse'),
			),
			429: {
				description: 'Limite nativo Better Auth excedido; corpo JSON enviado como text/plain.',
				headers: {
					'X-Retry-After': {
						description: 'Segundos até uma nova tentativa.',
						schema: str({ pattern: '^\\d+$' }),
					},
				},
				content: {
					'text/plain': {
						schema: str({
							example: '{"message":"Too many requests. Please try again later."}',
						}),
					},
				},
			},
		},
		{
			public: true,
			requestBody: body(ref('PasswordResetRequest')),
			description:
				'Token de uso único com validade de 15 minutos. A redefinição revoga as sessões existentes. Envio disponível somente quando SMTP está configurado. redirectTo é opcional e precisa usar uma origem confiável. O Better Auth limita a três solicitações por minuto por IP.',
		},
	),
}

const nativeAuthError = object({ code: str(), message: str() }, [])
const newPassword = str({ format: 'password', minLength: 8, maxLength: 128 })
const resetToken = str({ minLength: 1 })
paths['/api/auth/reset-password'] = {
	post: op(
		'Auth',
		'Redefinir a senha com o token de recuperação',
		{
			200: response(
				'Senha redefinida e sessões anteriores revogadas',
				object({ status: { type: 'boolean' } }),
			),
			400: response('Token inválido, expirado ou já usado, ou senha inválida', nativeAuthError),
			403: response('Origem não permitida', nativeAuthError),
			429: response('Limite de tentativas atingido'),
		},
		{
			public: true,
			description:
				'Informe o token de uso único no corpo ou na query. A redefinição bem-sucedida encerra todas as sessões anteriores.',
			parameters: [param('token', 'query', resetToken)],
			requestBody: body(object({ token: resetToken, newPassword }, ['newPassword'])),
		},
	),
}
paths['/api/auth/change-password'] = {
	post: op(
		'Auth',
		'Trocar a senha de uma conta autenticada',
		{
			200: response(
				'Senha trocada. O cookie da sessão que fez a troca é renovado.',
				object({ token: str(), user: ref('User') }),
			),
			400: response('Senha atual incorreta ou nova senha inválida', nativeAuthError),
			401: response('Sessão ausente ou inválida'),
			403: response('Origem não permitida', nativeAuthError),
			429: response('Limite de tentativas atingido'),
		},
		{
			description:
				'O servidor revoga as sessões anteriores em toda troca válida e entrega uma nova sessão ao cliente que fez a troca.',
			requestBody: body(object({ currentPassword: str({ format: 'password' }), newPassword })),
		},
	),
}

const decimalBytes = str({ pattern: '^-?\\d+$', description: 'Quantidade de bytes em decimal.' })
const pagination = [
	param('page', 'query', integer({ minimum: 1, maximum: 10000, default: 1 })),
	param('limit', 'query', integer({ minimum: 1, maximum: 100, default: 50 })),
]
const searchTerm = param('q', 'query', str({ maxLength: 155 }))
const paging = (key: string, item: Schema) =>
	object({ [key]: array(item), page: integer(), limit: integer(), total: integer() })
const adminUser = object({
	id: userId,
	name,
	email: str({ format: 'email' }),
	role: str(),
	banned: { type: 'boolean', nullable: true },
	deletionPending: { type: 'boolean' },
	quotaLimitBytes: decimalBytes,
	createdAt: date,
})
const adminAccountChange = object(
	{
		role: userRole,
		banned: { type: 'boolean' },
		quotaLimitBytes: str({ pattern: '^[1-9]\\d{0,18}$' }),
	},
	[],
)
const adminFile = {
	allOf: [
		ref('File'),
		object({
			ownerId: integer(),
			ownerName: name,
			ownerEmail: str({ format: 'email' }),
		}),
	],
}
const auditLog = object({
	id: integer(),
	createdAt: date,
	userId: integer({ nullable: true }),
	actorName: str({ nullable: true }),
	actorEmail: str({ nullable: true }),
	action: str(),
	ipAddress: str(),
	requestId: str({ nullable: true }),
	details: str({ nullable: true }),
})
const auditParams = [
	param('since', 'query', date, false, 'Início inclusivo.'),
	param('until', 'query', date, false, 'Fim exclusivo.'),
	param('userId', 'query'),
	param('action', 'query', str({ maxLength: 80 })),
]
const queuedDeletion = response(
	'Exclusão iniciada; resta limpeza no armazenamento',
	object({ status: str({ enum: ['deleting'] }) }),
)

paths['/auth/providers'] = {
	get: op(
		'Auth',
		'Consultar os provedores habilitados',
		{
			200: response('Disponibilidade dos provedores', object({ google: { type: 'boolean' } })),
		},
		{ public: true },
	),
}
paths['/users/me/avatar'] = {
	get: op('Auth', 'Ler o avatar da conta autenticada', {
		200: {
			description: 'Avatar privado normalizado em WebP',
			content: { 'image/webp': { schema: str({ format: 'binary' }) } },
		},
	}),
	post: op(
		'Auth',
		'Salvar ou substituir o avatar',
		{
			200: response(
				'Referência gerenciada e bytes contabilizados',
				object({ image: str(), sizeBytes: decimalBytes }),
			),
		},
		{
			description:
				'Envie uma imagem JPEG, PNG ou WebP no corpo cru, até 2 MiB. O servidor valida e normaliza o conteúdo.',
			requestBody: {
				required: true,
				content: Object.fromEntries(
					['image/jpeg', 'image/png', 'image/webp'].map((mime) => [
						mime,
						{ schema: str({ format: 'binary' }) },
					]),
				),
			},
			errors: [413, 415, 507],
		},
	),
	delete: op('Auth', 'Remover o avatar e liberar a cota correspondente', {
		204: response('Avatar removido'),
	}),
}
paths['/admin/users'] = {
	get: op(
		'Admin',
		'Listar contas e cotas',
		{
			200: response(
				'Contas paginadas com uso efetivo',
				paging('users', {
					allOf: [
						adminUser,
						object({
							usedBytes: {
								...decimalBytes,
								description:
									'Versões de arquivos e avatar, em bytes. Exclui reservas de upload.',
							},
						}),
					],
				}),
			),
		},
		{ parameters: [...pagination, searchTerm] },
	),
	post: op(
		'Admin',
		'Criar uma conta',
		{ 201: response('Conta criada', object({ user: ref('User') })) },
		{
			requestBody: body(
				object(
					{
						name,
						email: str({ format: 'email' }),
						password: str({ minLength: 8, maxLength: 128 }),
						role: userRole,
					},
					['name', 'email', 'password'],
				),
			),
		},
	),
}
paths['/admin/users/{id}'] = {
	patch: op(
		'Admin',
		'Alterar papel, cota ou bloqueio de uma conta',
		{
			200: response('Conta atualizada', object({ user: adminUser })),
		},
		{ parameters: ids, requestBody: body(adminAccountChange), errors: [409] },
	),
	delete: op(
		'Admin',
		'Excluir conta, arquivos e sessões',
		{
			204: response('Conta removida'),
			202: queuedDeletion,
		},
		{ parameters: ids, errors: [409] },
	),
}
paths['/admin/files'] = {
	get: op(
		'Admin',
		'Listar arquivos com o proprietário',
		{ 200: response('Arquivos paginados', paging('files', adminFile)) },
		{
			parameters: [
				...pagination,
				searchTerm,
				param('trash', 'query', str({ enum: ['true', 'false'] })),
			],
		},
	),
}
paths['/admin/files/{id}'] = {
	delete: op(
		'Admin',
		'Mover arquivo para a lixeira e revogar os links',
		{ 204: response('Movido para a lixeira') },
		{ parameters: ids, errors: [409] },
	),
}
paths['/admin/files/{id}/download'] = {
	get: op(
		'Admin',
		'Baixar um arquivo com registro de auditoria',
		{ 200: binaryResponse },
		{ parameters: ids, errors: [503] },
	),
}
paths['/admin/files/{id}/permanent'] = {
	delete: op(
		'Admin',
		'Expurgar um arquivo da lixeira e liberar a cota',
		{
			204: response('Arquivo expurgado'),
			202: queuedDeletion,
		},
		{ parameters: ids, errors: [409] },
	),
}
paths['/admin/audit'] = {
	get: op(
		'Admin',
		'Listar eventos de auditoria',
		{ 200: response('Eventos paginados', paging('logs', auditLog)) },
		{ parameters: [...pagination, ...auditParams] },
	),
}
paths['/admin/audit/export'] = {
	get: op(
		'Admin',
		'Exportar os eventos filtrados em CSV',
		{
			200: {
				description: 'CSV UTF-8 por streaming',
				content: { 'text/csv': { schema: str({ format: 'binary' }) } },
			},
		},
		{ parameters: auditParams },
	),
}
paths['/admin/stats'] = {
	get: op(
		'Admin',
		'Consultar métricas globais e tráfego diário',
		{
			200: response(
				'Resumo e série diária UTC',
				object({
					users: object({ total: integer(), admins: integer(), blocked: integer() }),
					files: object({ active: integer(), trash: integer() }),
					storage: object({
						usedBytes: decimalBytes,
						trashBytes: decimalBytes,
						reservedBytes: decimalBytes,
						limitBytes: decimalBytes,
						availableBytes: decimalBytes,
						diskAvailableBytes: decimalBytes,
						diskTotalBytes: decimalBytes,
					}),
					traffic: array(
						object({
							day: str({ format: 'date' }),
							uploads: integer(),
							downloads: integer(),
							uploadBytes: decimalBytes,
							downloadBytes: decimalBytes,
						}),
					),
				}),
			),
		},
		{ parameters: [param('days', 'query', str({ enum: ['7', '30'], default: '7' }))] },
	),
}

export const swaggerSpec = swaggerJsdoc({
	definition: {
		openapi: '3.0.3',
		info: {
			title: 'Silverbox API',
			version: '1.0.0',
			description:
				'Entre por /auth/register ou /auth/login no Try it out para usar a sessão HttpOnly. Use o mesmo hostname em todas as chamadas. Uploads recebem bytes brutos, não multipart. Em HTTPS o cookie usa o prefixo __Secure-. O deploy permite CORS de origens HTTP(S), refletindo Origin com credenciais; isso não dispensa sessão nem autoriza acesso a arquivos de terceiros. Para desenvolver o front no localhost contra esta API, use o proxy /__api do Vite em silverbox-web; cookies SameSite=Lax não são enviados diretamente entre sites distintos. Origens de autenticação direta continuam configuradas em FRONTEND_ORIGINS.',
		},
		servers: [{ url: env.BETTER_AUTH_URL, description: 'Origem pública configurada' }],
		tags: ['Auth', 'Admin', 'Folders', 'Files', 'Search', 'Shares', 'Storage', 'Health', 'Plans', 'Billing'].map(
			(name) => ({
				name,
			}),
		),
		components: {
			securitySchemes: {
				asaasWebhookToken: { type: 'apiKey', in: 'header', name: 'asaas-access-token' },
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
			schemas: { ...schemas, ...billingSchemas },
		},
		paths: { ...paths, ...billingPaths },
	},
	apis: [],
})
