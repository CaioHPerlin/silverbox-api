CREATE TYPE "silverbox_api"."BillingPlanCode" AS ENUM ('pro', 'team', 'business');
CREATE TYPE "silverbox_api"."BillingCycle" AS ENUM ('month', 'year');
CREATE TYPE "silverbox_api"."BillingMethod" AS ENUM ('credit_card', 'pix', 'boleto');
CREATE TYPE "silverbox_api"."BillingPurchaseStatus" AS ENUM (
  'preparing', 'pending', 'processing', 'overdue', 'paid', 'expired', 'cancelled', 'refunded', 'disputed', 'review', 'failed'
);

CREATE TABLE "silverbox_api"."billing_customers" (
  "id" UUID NOT NULL,
  "userId" INTEGER NOT NULL,
  "provider" VARCHAR(16) NOT NULL,
  "environment" VARCHAR(16) NOT NULL,
  "providerCustomerId" VARCHAR(128),
  "submittedAt" TIMESTAMPTZ(3),
  CONSTRAINT "billing_customers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_customers_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "silverbox_api"."users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "silverbox_api"."billing_purchases" (
  "id" UUID NOT NULL,
  "userId" INTEGER NOT NULL,
  "provider" VARCHAR(16) NOT NULL,
  "environment" VARCHAR(16) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "planCode" "silverbox_api"."BillingPlanCode" NOT NULL,
  "cycle" "silverbox_api"."BillingCycle" NOT NULL,
  "seats" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'BRL',
  "unitAmountCents" INTEGER NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "benefits" JSONB NOT NULL,
  "method" "silverbox_api"."BillingMethod" NOT NULL,
  "status" "silverbox_api"."BillingPurchaseStatus" NOT NULL DEFAULT 'preparing',
  "providerCustomerId" VARCHAR(128),
  "providerCheckoutId" VARCHAR(128),
  "providerPaymentId" VARCHAR(128),
  "instructions" JSONB,
  "instructionsUntil" TIMESTAMPTZ(3),
  "submittedAt" TIMESTAMPTZ(3),
  "nextSyncAt" TIMESTAMPTZ(3),
  "confirmedAt" TIMESTAMPTZ(3),
  "lastError" VARCHAR(64),
  "revision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "billing_purchases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_purchases_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "silverbox_api"."users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "billing_purchases_price_check" CHECK (
    "currency" = 'BRL' AND "unitAmountCents" > 0 AND "amountCents"::BIGINT = "unitAmountCents"::BIGINT * "seats"
    AND (("planCode" = 'pro' AND "seats" = 1) OR ("planCode" = 'team' AND "seats" BETWEEN 3 AND 100)
      OR ("planCode" = 'business' AND "seats" BETWEEN 5 AND 100))
  )
);

CREATE TABLE "silverbox_api"."billing_grants" (
  "purchaseId" UUID NOT NULL,
  "userId" INTEGER NOT NULL,
  "storageBytes" BIGINT NOT NULL,
  "startsAt" TIMESTAMPTZ(3) NOT NULL,
  "endsAt" TIMESTAMPTZ(3) NOT NULL,
  "revokedAt" TIMESTAMPTZ(3),
  CONSTRAINT "billing_grants_pkey" PRIMARY KEY ("purchaseId"),
  CONSTRAINT "billing_grants_purchaseId_fkey" FOREIGN KEY ("purchaseId")
    REFERENCES "silverbox_api"."billing_purchases" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "billing_grants_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "silverbox_api"."users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "billing_grants_period_check" CHECK ("startsAt" < "endsAt" AND "storageBytes" > 0)
);

CREATE TABLE "silverbox_api"."billing_webhook_events" (
  "provider" VARCHAR(16) NOT NULL,
  "environment" VARCHAR(16) NOT NULL,
  "id" VARCHAR(160) NOT NULL,
  "type" VARCHAR(64) NOT NULL,
  "resourceId" VARCHAR(128),
  "evidence" JSONB NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" VARCHAR(64),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMPTZ(3),
  CONSTRAINT "billing_webhook_events_pkey" PRIMARY KEY ("provider", "environment", "id")
);

CREATE UNIQUE INDEX "billing_customers_userId_provider_environment_key"
  ON "silverbox_api"."billing_customers" ("userId", "provider", "environment");
CREATE UNIQUE INDEX "billing_customers_provider_environment_providerCustomerId_key"
  ON "silverbox_api"."billing_customers" ("provider", "environment", "providerCustomerId");
CREATE UNIQUE INDEX "billing_purchases_userId_provider_environment_idempotencyKe_key"
  ON "silverbox_api"."billing_purchases" ("userId", "provider", "environment", "idempotencyKey");
CREATE UNIQUE INDEX "billing_purchases_provider_environment_providerCheckoutId_key"
  ON "silverbox_api"."billing_purchases" ("provider", "environment", "providerCheckoutId");
CREATE UNIQUE INDEX "billing_purchases_provider_environment_providerPaymentId_key"
  ON "silverbox_api"."billing_purchases" ("provider", "environment", "providerPaymentId");
CREATE INDEX "billing_purchases_nextSyncAt_idx" ON "silverbox_api"."billing_purchases" ("nextSyncAt");
CREATE INDEX "billing_grants_userId_endsAt_idx" ON "silverbox_api"."billing_grants" ("userId", "endsAt");
CREATE INDEX "billing_webhook_events_processedAt_nextAttemptAt_idx"
  ON "silverbox_api"."billing_webhook_events" ("processedAt", "nextAttemptAt");
