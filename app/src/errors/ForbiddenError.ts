import { AppError } from "./AppError.js";

export class ForbiddenError extends AppError {
  constructor(message = "Acesso negado", details?: unknown) {
    super(message, 403, details);
  }
}
