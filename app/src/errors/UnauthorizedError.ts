import { AppError } from "./AppError.js";

export class UnauthorizedError extends AppError {
  constructor(message = "Não autorizado", details?: unknown) {
    super(message, 401, details);
  }
}
