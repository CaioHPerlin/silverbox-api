import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import type { Server } from 'node:http'
import express, { type Application } from 'express'
import { z } from 'zod'

// Variáveis obrigatórias na main atual; atribuir antes dos imports dinâmicos.
process.env.NODE_ENV = 'production'
process.env.LOG_LEVEL = 'error'
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/silverbox_test'
process.env.BETTER_AUTH_URL ??= 'http://localhost:8000'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-0123456789-0123456789'

const { errorHandler, notFoundHandler } = await import('../middleware/error-handler.js')
const { AppError, BadRequestError, InternalServerError } = await import('../errors/index.js')
const { HttpError } = await import('../lib/errors.js')

// Não importa createApp: os testes do middleware não devem depender de banco e storage.
function makeApp(): Application {
  const app = express()
  app.use((req, _res, next) => {
    Object.assign(req, { log: { error: () => {} } })
    next()
  })
  app.use(express.json())
  return app
}

async function serve(app: Application, context: TestContext): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running))
  })
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Porta indisponível')
  return `http://127.0.0.1:${address.port}`
}

test('express.json preserva status 400 com JSON malformado', async (context) => {
  const app = makeApp()
  app.post('/', (_req, res) => res.sendStatus(200))
  app.use(errorHandler)
  const url = await serve(app, context)
  const response = await fetch(`${url}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"incompleto":',
  })
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'JSON inválido no corpo da requisição' })
})

test('express.json preserva status 413 para corpo grande', async (context) => {
  const app = makeApp()
  app.post('/', (_req, res) => res.sendStatus(200))
  app.use(errorHandler)
  const url = await serve(app, context)
  const response = await fetch(`${url}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conteudo: 'x'.repeat(110_000) }),
  })
  assert.equal(response.status, 413)
  assert.deepEqual(await response.json(), { error: 'Corpo da requisição muito grande' })
})

test('express.json preserva status 415 para charset não suportado', async (context) => {
  const app = makeApp()
  app.post('/', (_req, res) => res.sendStatus(200))
  app.use(errorHandler)
  const url = await serve(app, context)
  const response = await fetch(`${url}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=iso-8859-1' },
    body: '{}',
  })
  assert.equal(response.status, 415)
  assert.deepEqual(await response.json(), { error: 'Formato ou codificação do corpo não suportado' })
})

test('preserva os status da main, o Retry-After e esconde erros 5xx', async (context) => {
  const app = makeApp()
  app.get('/limit', () => { throw new HttpError(429, 'Too many simultaneous transfers') })
  app.get('/capacity', () => { throw new HttpError(503, 'Storage capacity is unavailable') })
  app.get('/full', () => { throw new HttpError(507, 'Storage safety margin reached') })
  app.get('/app', () => { throw new AppError('credencial-secreta', 503, { token: 'secreto' }) })
  app.get('/internal', () => { throw new InternalServerError(new Error('password=segredo')) })
  app.get('/unexpected', () => { throw new Error('credencial-interna') })
  app.get('/bad', () => { throw new BadRequestError('Dados inválidos', { campo: 'nome' }) })
  app.use(notFoundHandler)
  app.use(errorHandler)
  const url = await serve(app, context)

  const limited = await fetch(`${url}/limit`)
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '1')
  assert.deepEqual(await limited.json(), { error: 'Too many simultaneous transfers' })

  for (const [route, status] of [
    ['/capacity', 503], ['/full', 507], ['/app', 503], ['/internal', 500], ['/unexpected', 500],
  ] as const) {
    const response = await fetch(`${url}${route}`)
    assert.equal(response.status, status)
    assert.deepEqual(await response.json(), { error: 'Erro interno do servidor' })
  }

  const bad = await fetch(`${url}/bad`)
  assert.equal(bad.status, 400)
  assert.deepEqual(await bad.json(), { error: 'Dados inválidos', details: { campo: 'nome' } })

  const missing = await fetch(`${url}/missing`)
  assert.equal(missing.status, 404)
  assert.deepEqual(await missing.json(), { error: 'Rota GET /missing não encontrada' })
})

test('resposta Zod mantém issues compatível com a main e details do PR', async (context) => {
  const app = makeApp()
  app.post('/', () => { z.object({ email: z.email() }).parse({ email: 'invalido' }) })
  app.use(errorHandler)
  const url = await serve(app, context)
  const response = await fetch(`${url}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(response.status, 400)
  const body = await response.json() as { error: string; details: unknown[]; issues: unknown[] }
  assert.equal(body.error, 'Dados inválidos')
  assert.equal(body.issues.length, 1)
  assert.equal(body.details.length, 1)
})
