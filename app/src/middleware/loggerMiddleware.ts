import { randomUUID } from "node:crypto";
import { pinoHttp, stdSerializers } from "pino-http";
import type { Express, Request, Response, NextFunction } from "express";

const logLevel = process.env.LOG_LEVEL ?? "info";

export const loggerMiddleware = pinoHttp({
  level: logLevel,
  genReqId: () => randomUUID(),
  customProps: (req, res) => ({
    reqId: req.id,
  }),
  customLogLevel: (req, res, err) => {
    if (res.statusCode >= 500 || err) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage: (req, res) => "request completed",
  customErrorMessage: (req, res, err) => `request failed: ${err?.message ?? "unknown error"}`,
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      query: req.query,
      headers: {
        "user-agent": req.headers["user-agent"],
        "content-type": req.headers["content-type"],
      },
      remoteAddress: req.ip,
      remotePort: req.socket?.remotePort,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
    err: stdSerializers.err,
  },
  autoLogging: {
    ignore: (req) => req.url === "/health" || req.url === "/favicon.ico",
  },
});

const requestIdHeader = "x-request-id";

export const attachLogger = (app: Express) => {
  app.use(loggerMiddleware);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.id) {
      res.setHeader(requestIdHeader, String(req.id));
    }
    next();
  });
};