import swaggerJsdoc from 'swagger-jsdoc'
import { env } from './env.js'

const swaggerOptions: swaggerJsdoc.Options = {
	definition: {
		openapi: '3.0.3',

		info: {
			title: 'Minha Nuvem API',
			version: '1.0.0',
			description:
				'API para autenticação, upload de arquivos, armazenamento no MinIO e controle de cota de armazenamento.',
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
	},

	apis: ['./src/modules/**/*.ts'],
}

export const swaggerSpec = swaggerJsdoc(swaggerOptions)
