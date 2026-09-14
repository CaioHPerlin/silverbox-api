# Documentação da API — Minha Nuvem

Este documento descreve a configuração e o uso da documentação OpenAPI/Swagger da API **Minha Nuvem**.

A documentação foi configurada para os principais endpoints públicos da aplicação:

- `POST /api/auth/login`
- `POST /api/files/upload`

A interface Swagger fica disponível em:

```text
http://localhost:3000/docs
```

A especificação OpenAPI em JSON fica disponível em:

```text
http://localhost:3000/docs.json
```


## Objetivo da documentação

A documentação OpenAPI descreve o contrato HTTP público da API.

Ela informa:

- endpoints disponíveis;
- método HTTP;
- parâmetros;
- corpo da requisição;
- autenticação;
- tipos de conteúdo;
- respostas de sucesso;
- respostas de erro.

Componentes internos como Prisma, PostgreSQL, MinIO, middlewares e services não são expostos como endpoints Swagger. Eles fazem parte da implementação interna da aplicação.

---

Os principais arquivos relacionados ao Swagger são:

```text
src/config/swagger.ts
src/modules/auth/auth.routes.ts
src/modules/files/files.routes.ts
src/app.ts
```

---

## Instalação

Instale as dependências necessárias:

```bash
npm install swagger-jsdoc swagger-ui-express
```

Instale também os tipos para TypeScript:

```bash
npm install -D @types/swagger-jsdoc @types/swagger-ui-express
```

---

## Configuração OpenAPI

A configuração principal fica em:

```text
src/config/swagger.ts
```

Exemplo:

```ts
import swaggerJsdoc from 'swagger-jsdoc';

const swaggerOptions: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.3',

    info: {
      title: 'Minha Nuvem API',
      version: '1.0.0',
      description:
        'API para autenticação, upload de arquivos, armazenamento no MinIO e controle de cota.',
    },

    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Servidor de desenvolvimento',
      },
    ],

    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
  },

  apis: ['./src/**/*.ts'],
};

export const swaggerSpec = swaggerJsdoc(swaggerOptions);
```

---

## Configuração no Express

No `app.ts`, a documentação deve ser registrada no Express:

```ts
import express from 'express';
import swaggerUi from 'swagger-ui-express';

import { swaggerSpec } from './config/swagger';

export const app = express();

app.use(express.json());

app.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec)
);

app.get('/docs.json', (_req, res) => {
  res.json(swaggerSpec);
});
```

---

## Executando o projeto

Execute:

```bash
npm run dev
```

Após iniciar a aplicação, acesse:

```text
http://localhost:3000/docs
```

Para visualizar o JSON OpenAPI:

```text
http://localhost:3000/docs.json
```

---

# Endpoints documentados

## Autenticação

### POST `/api/auth/login`

Realiza a autenticação de um usuário.

### Request

Content-Type:

```text
application/json
```

Exemplo:

```json
{
  "email": "usuario@email.com",
  "password": "senha123"
}
```

### Resposta de sucesso

Status:

```text
200 OK
```

Exemplo:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "usuario@email.com",
    "role": "USER",
    "quotaBytes": 1073741824
  }
}
```

### Possíveis respostas

| Status | Descrição |
|---|---|
| `200` | Login realizado com sucesso |
| `400` | Dados inválidos |
| `401` | Credenciais inválidas |

---

## Upload de arquivo

### POST `/api/files/upload`

Realiza o upload de um arquivo.

Essa rota exige autenticação JWT.

### Autenticação

Header:

```http
Authorization: Bearer <token>
```

### Request

Content-Type:

```text
multipart/form-data
```

Campo obrigatório:

```text
file
```

O nome usado na documentação deve ser o mesmo configurado no Multer:

```ts
upload.single('file')
```

### Resposta de sucesso

Status:

```text
201 Created
```

Exemplo:

```json
{
  "fileId": "550e8400-e29b-41d4-a716-446655440001",
  "originalName": "documento.pdf",
  "size": 1024000
}
```

### Possíveis respostas

| Status | Descrição |
|---|---|
| `201` | Arquivo enviado com sucesso |
| `400` | Nenhum arquivo enviado ou requisição inválida |
| `401` | Usuário não autenticado |
| `413` | Cota excedida ou arquivo muito grande |

---

## Fluxo de autenticação no Swagger

Para testar uma rota protegida:

1. Abra `POST /api/auth/login`.
2. Clique em **Try it out**.
3. Informe email e senha.
4. Execute a requisição.
5. Copie o token JWT retornado.
6. Clique em **Authorize** no topo do Swagger.
7. Informe o token.
8. Teste `POST /api/files/upload`.

O Swagger enviará o header:

```http
Authorization: Bearer <token>
```

nas rotas que utilizam:

```yaml
security:
  - bearerAuth: []
```

---

## Boas práticas

- Manter a documentação atualizada junto com as rotas.
- Documentar respostas de sucesso e erro.
- Informar quando uma rota exige JWT.
- Utilizar `multipart/form-data` para upload de arquivos.
- Reutilizar schemas em `components.schemas` quando possível.
- Garantir que o nome do campo documentado para upload seja igual ao usado pelo Multer.
- Testar `/docs` antes de abrir o Pull Request.
- Testar `/docs.json` para verificar se a especificação OpenAPI foi gerada corretamente.

---

