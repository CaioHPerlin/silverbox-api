import { AppError } from "./app.error.js";

export class NotFoundError extends AppError {
  constructor(message = "Recurso não encontrado", details?: unknown) {
    super(message, 404, details);
  }
}
