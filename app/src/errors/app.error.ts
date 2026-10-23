/**
 * Classe base para erros HTTP esperados da aplicação.
 * O status deve ser informado explicitamente por cada subclasse/uso.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(message: string, statusCode: number, details?: unknown, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.details = details;
  }
}
