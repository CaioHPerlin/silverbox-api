/**
 * Classe base para erros "esperados" da aplicação.
 * Tudo que herda daqui é convertido pelo error-handler em uma resposta
 * HTTP com o statusCode e a mensagem definidos.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(message: string, statusCode = 500, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.details = details;
  }
}
