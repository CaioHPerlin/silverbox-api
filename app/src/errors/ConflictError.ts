import { AppError } from "./AppError.js";

export class ConflictError extends AppError {
  constructor(message = "Conflito com o estado atual do recurso", details?: unknown) {
    super(message, 409, details);
  }
}
