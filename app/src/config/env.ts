import { z } from "zod";

try {
  process.loadEnvFile();
} catch (error) {
  const isFileNotFound = (error as NodeJS.ErrnoException).code === "ENOENT";
  if (!isFileNotFound) {
    throw error;
  }
}

const envSchema = z.object({

  NODE_ENV: z
    .enum(["development", "production"])
    .default("development"),

  PORT: z.coerce.number().int().positive().default(8000),

  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (v) => v.startsWith("postgres://") || v.startsWith("postgresql://"),
      "DATABASE_URL must start with postgres:// or postgresql://",
    ),

  S3_ENDPOINT: z
    .string()
    .min(1, "S3_ENDPOINT is required")
    .refine(
      (v) => v.startsWith("http://") || v.startsWith("https://"),
      "S3_ENDPOINT must be an http:// or https:// URL",
    ),
  S3_ACCESS_KEY: z.string().min(1, "S3_ACCESS_KEY is required"),
  S3_SECRET_KEY: z.string().min(1, "S3_SECRET_KEY is required"),
  S3_BUCKET: z.string().min(1, "S3_BUCKET is required"),
  S3_REGION: z.string().min(1, "S3_REGION is required"),

  APP_SECRET: z.string().min(32, "APP_SECRET must be at least 32 characters long"),
  COTA_PADRAO_MB: z.coerce.number().int().positive().default(1024),
});

function loadEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error("Invalid or missing environment variables:\n");
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    console.error("\nCheck your .env file (see .env.example) and try again.");
    process.exit(1);
  }

  return result.data;
}

export const env = loadEnv();
export type Env = typeof env;