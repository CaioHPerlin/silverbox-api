BEGIN;

CREATE TYPE "silverbox_api"."SharePermission" AS ENUM ('view', 'download');

ALTER TABLE "silverbox_api"."shared_links"
  ADD COLUMN "permission" "silverbox_api"."SharePermission" NOT NULL DEFAULT 'download',
  ALTER COLUMN "expiresat" DROP NOT NULL;

CREATE INDEX "shared_links_userid_createdat_id_idx"
  ON "silverbox_api"."shared_links"("userid", "createdat", "id");

COMMIT;
