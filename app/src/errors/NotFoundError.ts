import { AppError } from "./AppError.js";

export class NotFoundError extends AppError {
  constructor(message = "Recurso não encontrado", details?: unknown) {
    super(message, 404, details);
  }
}
