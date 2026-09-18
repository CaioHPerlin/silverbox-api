import express, { type Application } from "express";
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger';

export function createApp(): Application {
  const app = express();

  // Middleware
  app.disable("x-powered-by");
  app.use(express.json());

  app.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec)
 );
 
  // Routes
  app.get("/", (_, res) => {
    res.json({ message: "Hello, World" });
  });

  app.get('/docs.json', (_req, res) => {
    res.json(swaggerSpec);
  });

  return app;
}
