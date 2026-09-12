import express, { type Application } from "express";
import { attachLogger } from "./middleware/loggerMiddleware.js";

export function createApp(): Application {
  const app = express();

  // Middleware
  attachLogger(app);
  app.disable("x-powered-by");
  app.use(express.json());

  // Routes
  app.get("/", (_, res) => {
    res.json({ message: "Hello, World" });
  });

  return app;
}
