import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Server } from "node:http";
import express, { type Application } from "express";

// A configuração deve ser definida antes do import dos módulos da aplicação.
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = "error";
process.env.DATABASE_URL ??= "postgresql://localhost:5432/silverbox_test";

const { createApp } = await import("../app.js");
const { errorHandler } = await import("../middleware/error-handler.js");
const { AppError, BadRequestError, InternalServerError } = await import("../errors/index.js");

async function serve(app: Application, context: TestContext): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const running = app.listen(0, "127.0.0.1", () => resolve(running));
  });
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Porta não disponível");
  return `http://127.0.0.1:${address.port}`;
}

test("express.json preserva 400 para JSON malformado", async (context) => {
  const url = await serve(createApp(), context);
  const response = await fetch(`${url}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"incompleto":',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "JSON inválido no corpo da requisição" });
});

test("express.json devolve 413 para body além do limite", async (context) => {
  const url = await serve(createApp(), context);
  const response = await fetch(`${url}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conteudo: "x".repeat(110_000) }),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "Corpo da requisição muito grande" });
});

test("express.json preserva 415 para charset não suportado", async (context) => {
  const url = await serve(createApp(), context);
  const response = await fetch(`${url}/`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=iso-8859-1" },
    body: "{}",
  });
  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { error: "Formato ou codificação do corpo não suportado" });
});

test("erros 5xx nunca expõem mensagem ou details em produção", async (context) => {
  const app = express();
  const cause = new Error("senha-do-banco=secreta");
  const internalError = new InternalServerError(cause);
  assert.equal(internalError.cause, cause);
  assert.equal(internalError.statusCode, 500);
  assert.equal(internalError.message, "Erro interno do servidor");

  app.use((req, _res, next) => {
    // Os erros originais devem passar para o logger, não para o cliente.
    Object.assign(req, { log: { error: () => {} } });
    next();
  });
  app.get("/app-5xx", () => { throw new AppError("mensagem secreta", 503, { token: "secreto" }); });
  app.get("/internal", () => { throw internalError; });
  app.get("/unknown", () => { throw new Error("stack secreta"); });
  app.get("/bad-request", () => { throw new BadRequestError("Dados incorretos", { campo: "nome" }); });
  app.use(errorHandler);

  const url = await serve(app, context);
  for (const [route, status] of [["/app-5xx", 503], ["/internal", 500], ["/unknown", 500]] as const) {
    const response = await fetch(`${url}${route}`);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: "Erro interno do servidor" });
  }

  const badRequest = await fetch(`${url}/bad-request`);
  assert.equal(badRequest.status, 400);
  assert.deepEqual(await badRequest.json(), { error: "Dados incorretos", details: { campo: "nome" } });
});
