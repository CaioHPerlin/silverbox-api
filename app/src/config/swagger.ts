import swaggerJsdoc from 'swagger-jsdoc';

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
				url: 'http://localhost:3000',
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
				bearerAuth: {
					type: 'http',
					scheme: 'bearer',
					bearerFormat: 'JWT',
					description: 'Informe o token JWT obtido no login.',
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
							format: 'uuid',
							example: '550e8400-e29b-41d4-a716-446655440000',
						},

						email: {
							type: 'string',
							format: 'email',
							example: 'usuario@email.com',
						},

						role: {
							type: 'string',
							example: 'USER',
						},

						quotaBytes: {
							type: 'integer',
							format: 'int64',
							example: 1073741824,
							description: 'Limite de armazenamento do usuário em bytes.',
						},
					},
				},

				LoginResponse: {
					type: 'object',
					properties: {
						token: {
							type: 'string',
							description: 'Token JWT utilizado nas rotas protegidas.',
							example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
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
							format: 'uuid',
							example: '550e8400-e29b-41d4-a716-446655440001',
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
};

export const swaggerSpec = swaggerJsdoc(swaggerOptions);
