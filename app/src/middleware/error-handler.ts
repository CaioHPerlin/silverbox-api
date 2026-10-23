import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { env } from "../config/env.js";
import { AppError, NotFoundError, PayloadTooLargeError } from "../errors/index.js";

/** Formato padrão das respostas de erro (ver ErrorResponse no Swagger). */
type ErrorBody = {
  error: string;
  details?: unknown;
};

/**
 * Erros gerados pelo parser do Express/body-parser contêm status HTTP,
 * `type` e `expose`. Nunca repassamos sua mensagem original ao cliente:
 * ela pode incluir dados do corpo enviado.
 */
function parseBodyError(err: unknown): AppError | undefined {
  if (!(err instanceof Error)) return undefined;

  const httpError = err as Error & {
    status?: unknown;
    statusCode?: unknown;
    type?: unknown;
    expose?: unknown;
  };
  const status = httpError.status ?? httpError.statusCode;

  if (
    typeof httpError.type !== "string" ||
    httpError.expose !== true ||
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 400 ||
    status >= 500
  ) {
    return undefined;
  }

  if (status === 413) {
    return new PayloadTooLargeError("Corpo da requisição muito grande");
  }
  if (status === 400 && httpError.type === "entity.parse.failed") {
    return new AppError("JSON inválido no corpo da requisição", 400);
  }
  if (status === 415) {
    return new AppError("Formato ou codificação do corpo não suportado", 415);
  }
  if (status === 403) {
    return new AppError("Corpo da requisição não permitido", 403);
  }

  return new AppError("Requisição inválida", status);
}

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

  const appError = err instanceof AppError ? err : parseBodyError(err);
  if (appError) {
    const isServerError = appError.statusCode >= 500;
    if (isServerError) {
      // Preserva o erro original (e sua causa) apenas no log interno.
      req.log.error({ err: err, cause: appError.cause }, "server error");
    }

    const hideDetails = isServerError && env.NODE_ENV === "production";
    const body: ErrorBody = {
      error: hideDetails ? "Erro interno do servidor" : appError.message,
    };
    if (!hideDetails && appError.details !== undefined) {
      body.details = appError.details;
    }
    res.status(appError.statusCode).json(body);
    return;
  }

  // Compatibilidade com erros de sintaxe que trazem o campo `body`.
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: "JSON inválido no corpo da requisição" } satisfies ErrorBody);
    return;
  }

  // Erros inesperados: logamos o erro, mas não expomos dados sensíveis em produção.
  req.log.error({ err }, "unhandled error");

  const body: ErrorBody = { error: "Erro interno do servidor" };
  if (env.NODE_ENV !== "production" && err instanceof Error) {
    body.details = { message: err.message, stack: err.stack };
  }
  res.status(500).json(body);
};
