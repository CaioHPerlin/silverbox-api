import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { env } from "../config/env.js";
import { AppError, NotFoundError } from "../errors/index.js";

/**
 * Formato padrão das respostas de erro (ver ErrorResponse no swagger).
 */
type ErrorBody = {
  error: string;
  details?: unknown;
};

/**
 * Captura requisições para rotas que não existem.
 * Deve ser registrado depois de todas as rotas e antes do errorHandler.
 */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Rota ${req.method} ${req.path} não encontrada`));
};

/**
 * Middleware centralizado de erros. Deve ser o último app.use() do app.
 * No Express 5, erros lançados em handlers async chegam aqui sozinhos.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  // Erros de validação dos schemas Zod
  if (err instanceof ZodError) {
    const body: ErrorBody = {
      error: "Dados inválidos",
      details: err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
    res.status(400).json(body);
    return;
  }

  // Erros lançados pela própria aplicação (throw new NotFoundError(...))
  if (err instanceof AppError) {
    if (err.statusCode >= 500) req.log.error({ err }, err.message);

    const body: ErrorBody = { error: err.message };
    if (err.details !== undefined) body.details = err.details;
    res.status(err.statusCode).json(body);
    return;
  }

  // JSON malformado no corpo da requisição (erro do express.json())
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: "JSON inválido no corpo da requisição" } satisfies ErrorBody);
    return;
  }

  // Qualquer outro erro é inesperado: loga tudo, mas não vaza detalhes em produção
  req.log.error({ err }, "unhandled error");

  const body: ErrorBody = { error: "Erro interno do servidor" };
  if (env.NODE_ENV !== "production" && err instanceof Error) {
    body.details = { message: err.message, stack: err.stack };
  }
  res.status(500).json(body);
};
