import express, { type Application } from "express";

export function createApp(): Application {
  const app = express();

  // Middleware
  app.disable("x-powered-by");
  app.use(express.json());

  // Routes
  app.get("/", (_, res) => {
    res.json({ message: "Hello, World" });
  });

  return app;
}
