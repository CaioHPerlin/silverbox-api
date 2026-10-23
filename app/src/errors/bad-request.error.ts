import { AppError } from "./app.error.js";

export class BadRequestError extends AppError {
  constructor(message = "Requisição inválida", details?: unknown) {
    super(message, 400, details);
  }
}
