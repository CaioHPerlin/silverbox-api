import { AppError } from "./app.error.js";

export class ConflictError extends AppError {
  constructor(message = "Conflito com o estado atual do recurso", details?: unknown) {
    super(message, 409, details);
  }
}
