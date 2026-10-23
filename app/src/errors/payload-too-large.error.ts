import { AppError } from "./app.error.js";

export class PayloadTooLargeError extends AppError {
  constructor(message = "Arquivo muito grande", details?: unknown) {
    super(message, 413, details);
  }
}
