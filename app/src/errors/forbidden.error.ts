import { AppError } from "./app.error.js";

export class ForbiddenError extends AppError {
  constructor(message = "Acesso negado", details?: unknown) {
    super(message, 403, details);
  }
}
