import { AppError } from "./app.error.js";

/** Erro interno com mensagem pública fixa; a causa fica disponível para logs. */
export class InternalServerError extends AppError {
  constructor(cause?: unknown) {
    super("Erro interno do servidor", 500, undefined, { cause });
  }
}
