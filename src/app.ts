import express from 'express';
import swaggerUi from 'swagger-ui-express';

import { swaggerSpec } from './config/swagger';

export const app = express();

app.use(express.json());

app.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec)
);

app.get('/docs.json', (_req, res) => {
  res.json(swaggerSpec);
});