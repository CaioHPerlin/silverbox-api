-- AlterTable
ALTER TABLE "silverbox_api"."users" ADD COLUMN     "banned" BOOLEAN DEFAULT false,
ADD COLUMN     "banreason" VARCHAR,
ADD COLUMN     "banexpires" TIMESTAMP;

-- AlterTable
ALTER TABLE "silverbox_api"."session" ADD COLUMN     "impersonatedby" VARCHAR;
