import swaggerJsdoc from 'swagger-jsdoc'
import { env } from './env.js'

const swaggerOptions: swaggerJsdoc.Options = {
	definition: {
		openapi: '3.0.3',

		info: {
			title: 'Silverbox API',
			version: '1.0.0',
			description:
				'API de autenticação e gerenciamento de arquivos com armazenamento local privado, versões, lixeira e cota por usuário.',
		},

		servers: [
			{
				url: env.BETTER_AUTH_URL,
				description: 'Servidor de desenvolvimento',
			},
		],

		tags: [
			{
				name: 'Auth',
				description: 'Autenticação de usuários',
			},
			{
				name: 'Files',
				description: 'Upload e gerenciamento de arquivos',
			},
			{ name: 'Folders', description: 'Pastas do usuário' },
			{ name: 'Shares', description: 'Links temporários' },
			{ name: 'Storage', description: 'Uso e cota' },
		],

		components: {
			securitySchemes: {
				sessionCookie: {
					type: 'apiKey',
					in: 'cookie',
					name: 'better-auth.session_token',
					description: 'Cookie HTTP-only criada pelo Better Auth no cadastro ou login.',
				},
			},

			schemas: {
				LoginRequest: {
					type: 'object',
					required: ['email', 'password'],
					properties: {
						email: {
							type: 'string',
							format: 'email',
							example: 'usuario@email.com',
						},

						password: {
							type: 'string',
							format: 'password',
							example: 'senha123',
						},
					},
				},

				User: {
					type: 'object',
					properties: {
						id: {
							type: 'string',
							example: '1',
						},

						email: {
							type: 'string',
							format: 'email',
							example: 'usuario@email.com',
						},
					},
				},

				LoginResponse: {
					type: 'object',
					properties: {
						token: {
							type: 'string',
							description: 'Token de sessão. O cliente deve preferir a cookie HTTP-only.',
						},

						user: {
							$ref: '#/components/schemas/User',
						},
					},
				},

				FileUploadResponse: {
					type: 'object',
					properties: {
						fileId: {
							type: 'string',
							example: '1',
						},

						originalName: {
							type: 'string',
							example: 'documento.pdf',
						},

						size: {
							type: 'integer',
							format: 'int64',
							example: 1024000,
						},
					},
				},

				ErrorResponse: {
					type: 'object',
					properties: {
						error: {
							type: 'string',
							example: 'Credenciais inválidas',
						},
					},
					required: ['error'],
				},
			},
		},
		paths: {
			'/folders': {
				get: {
					tags: ['Folders'],
					summary: 'Listar pastas de uma pasta pai (raiz por padrão)',
					parameters: [{ name: 'parentFolderId', in: 'query', schema: { type: 'integer' } }],
					security: [{ sessionCookie: [] }],
					responses: { 200: { description: 'Pastas' } },
				},
				post: {
					tags: ['Folders'],
					summary: 'Criar pasta',
					security: [{ sessionCookie: [] }],
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: {
									type: 'object',
									required: ['name'],
									properties: {
										name: { type: 'string' },
										parentFolderId: { type: 'integer', nullable: true },
									},
								},
							},
						},
					},
					responses: { 201: { description: 'Pasta criada' } },
				},
			},
			'/folders/{id}': {
				patch: {
					tags: ['Folders'],
					summary: 'Renomear ou mover pasta',
					security: [{ sessionCookie: [] }],
					parameters: [
						{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
					],
					responses: {
						200: { description: 'Pasta atualizada' },
						409: { description: 'Movimento cíclico' },
					},
				},
				delete: {
					tags: ['Folders'],
					summary: 'Excluir pasta vazia',
					security: [{ sessionCookie: [] }],
					parameters: [
						{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
					],
					responses: {
						204: { description: 'Pasta excluída' },
						409: { description: 'Pasta não vazia' },
					},
				},
			},
			'/storage/usage': {
				get: {
					tags: ['Storage'],
					summary: 'Consultar bytes usados, reservados, limite e disponíveis',
					security: [{ sessionCookie: [] }],
					responses: { 200: { description: 'Valores em strings decimais' } },
				},
			},
			'/files': {
				post: {
					tags: ['Files'],
					summary:
						'Enviar bytes em fluxo; informar X-File-Name, X-File-Size e opcionalmente X-File-Mime e X-Folder-Id',
					security: [{ sessionCookie: [] }],
					parameters: [
						{ name: 'X-File-Name', in: 'header', required: true, schema: { type: 'string' } },
						{
							name: 'X-File-Size',
							in: 'header',
							required: true,
							schema: { type: 'integer', format: 'int64' },
						},
						{ name: 'X-File-Mime', in: 'header', schema: { type: 'string' } },
						{ name: 'X-Folder-Id', in: 'header', schema: { type: 'integer' } },
					],
					requestBody: {
						required: true,
						content: {
							'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
						},
					},
					responses: {
						201: { description: 'Arquivo criado' },
						413: { description: 'Cota ou limite excedido' },
					},
				},
				get: {
					tags: ['Files'],
					summary: 'Listar arquivos ativos por pasta, com page e limit',
					security: [{ sessionCookie: [] }],
					parameters: [
						{ name: 'folderId', in: 'query', schema: { type: 'integer' } },
						{ name: 'page', in: 'query', schema: { type: 'integer' } },
						{ name: 'limit', in: 'query', schema: { type: 'integer' } },
					],
					responses: { 200: { description: 'Arquivos e total' } },
				},
			},
			'/files/trash': {
				get: {
					tags: ['Files'],
					summary: 'Listar lixeira',
					security: [{ sessionCookie: [] }],
					responses: { 200: { description: 'Arquivos na lixeira' } },
				},
			},
			'/files/{id}': {
				get: {
					tags: ['Files'],
					summary: 'Consultar metadados',
					security: [{ sessionCookie: [] }],
					parameters: [
						{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
					],
					responses: { 200: { description: 'Arquivo' } },
				},
				patch: {
					tags: ['Files'],
					summary: 'Renomear ou mover arquivo',
					security: [{ sessionCookie: [] }],
					parameters: [
						{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
					],
					responses: { 200: { description: 'Arquivo atualizado' } },
				},
				delete: {
					tags: ['Files'],
					summary: 'Mover para lixeira e revogar links',
					security: [{ sessionCookie: [] }],
					parameters: [
						{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
					],
					responses: { 204: { description: 'Movido para lixeira' } },
				},
			},
			'/files/{id}/download': {
				get: {
					tags: ['Files'],
					summary: 'Baixar versão atual',
					security: [{ sessionCookie: [] }],
					parameters: [
						{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
					],
					responses: { 200: { description: 'Bytes do arquivo' } },
				},
			},
			'/files/{id}/restore': {
				post: {
					tags: ['Files'],
					summary: 'Restaurar da lixeira',
					security: [{ sessionCookie: [] }],
					parameters: [
						{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
					],
					responses: { 200: { description: 'Arquivo restaurado' } },
				},
			},
			'/files/{id}/permanent': {
				delete: {
					tags: ['Files'],
					summary: 'Excluir definitivamente um arquivo na lixeira',
					security: [{ sessionCookie: [] }],
					parameters: [
						{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
					],
					responses: { 204: { description: 'Bytes e metadados removidos' } },
				},
			},
			'/files/{id}/versions': {
				post: {
					tags: ['Files'],
					summary: 'Enviar nova versão em fluxo com os mesmos cabeçalhos de upload',
					security: [{ sessionCookie: [] }],
					parameters: [
						{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
					],
					requestBody: {
						required: true,
						content: {
							'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
						},
					},
					responses: { 201: { description: 'Versão criada' } },
				},
				get: {
					tags: ['Files'],
					summary: 'Listar versões',
					security: [{ sessionCookie: [] }],
					parameters: [
						{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
					],
					responses: { 200: { description: 'Histórico' } },
				},
			},
			'/files/{id}/versions/{versionId}/download': {
				get: {
					tags: ['Files'],
					summary: 'Baixar versão antiga',
					security: [{ sessionCookie: [] }],
					parameters: [
						{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
						{ name: 'versionId', in: 'path', required: true, schema: { type: 'integer' } },
					],
					responses: { 200: { description: 'Bytes da versão' } },
				},
			},
			'/files/{id}/versions/{versionId}/restore': {
				post: {
					tags: ['Files'],
					summary: 'Copiar versão antiga como nova versão',
					security: [{ sessionCookie: [] }],
					parameters: [
						{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
						{ name: 'versionId', in: 'path', required: true, schema: { type: 'integer' } },
					],
					responses: { 201: { description: 'Nova versão' } },
				},
			},
			'/files/{id}/shares': {
				post: {
					tags: ['Shares'],
					summary: 'Criar link de 60 a 604800 segundos; padrão 86400',
					security: [{ sessionCookie: [] }],
					parameters: [
						{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
					],
					responses: { 201: { description: 'URL e expiração' } },
				},
				get: {
					tags: ['Shares'],
					summary: 'Listar links sem expor tokens',
					security: [{ sessionCookie: [] }],
					parameters: [
						{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
					],
					responses: { 200: { description: 'Links' } },
				},
			},
			'/files/{id}/shares/{shareId}': {
				delete: {
					tags: ['Shares'],
					summary: 'Revogar link imediatamente',
					security: [{ sessionCookie: [] }],
					parameters: [
						{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
						{ name: 'shareId', in: 'path', required: true, schema: { type: 'integer' } },
					],
					responses: { 204: { description: 'Link revogado' } },
				},
			},
			'/shares/{token}': {
				get: {
					tags: ['Shares'],
					summary: 'Baixar arquivo por token temporário',
					parameters: [
						{ name: 'token', in: 'path', required: true, schema: { type: 'string' } },
					],
					responses: {
						200: { description: 'Bytes do arquivo' },
						410: { description: 'Link expirado ou revogado' },
					},
				},
			},
		},
	},

	apis: [],
}

export const swaggerSpec = swaggerJsdoc(swaggerOptions)
