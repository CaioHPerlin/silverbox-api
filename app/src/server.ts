import { createApp } from "./app.js";

// @TODO: Load environment variables from .env file
const env = {
  PORT: 3000,
};

async function bootstrap(): Promise<void> {
  const app = createApp();

  const server = app.listen(env.PORT, () => {
    console.info(`[SERVER] Listening on http://localhost:${env.PORT}`);
  });

  function shutdown(signal: NodeJS.Signals): void {
    console.info(`[SERVER] Received ${signal}. Shutting down...`);

    server.close((error) => {
      if (error) {
        console.error("[SERVER] Shutdown failed:", error);
        process.exit(1);
      }

      process.exit(0);
    });
  }

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

void bootstrap().catch((error: unknown) => {
  console.error("[SERVER] Startup failed:", error);
  process.exit(1);
});
