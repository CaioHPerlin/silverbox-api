import { AppError } from "./AppError.js";

export class BadRequestError extends AppError {
  constructor(message = "Requisição inválida", details?: unknown) {
    super(message, 400, details);
  }
}
