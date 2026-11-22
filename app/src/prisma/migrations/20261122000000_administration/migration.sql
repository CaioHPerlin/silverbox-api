ALTER TABLE "silverbox_api"."users" ADD COLUMN "deletion_pending" BOOLEAN NOT NULL DEFAULT false;

-- Serialize session creation with account blocking or deletion.
CREATE FUNCTION "silverbox_api"."require_active_session_owner"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  active BOOLEAN;
BEGIN
  SELECT banned IS NOT TRUE AND NOT deletion_pending INTO active
  FROM "silverbox_api"."users"
  WHERE id = NEW.userid
  FOR KEY SHARE;
  IF active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Account unavailable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "session_owner_available"
BEFORE INSERT ON "silverbox_api"."session"
FOR EACH ROW EXECUTE FUNCTION "silverbox_api"."require_active_session_owner"();

ALTER TABLE "silverbox_api"."audit_logs"
  ADD COLUMN "request_id" VARCHAR,
  ADD COLUMN "actor_name" VARCHAR,
  ADD COLUMN "actor_email" VARCHAR,
  ADD COLUMN "bytes" BIGINT;

UPDATE "silverbox_api"."audit_logs" AS log
SET "actor_name" = account."name", "actor_email" = account."email"
FROM "silverbox_api"."users" AS account
WHERE account."id" = log."userid";

ALTER TABLE "silverbox_api"."audit_logs"
  DROP CONSTRAINT "userid",
  ALTER COLUMN "userid" DROP NOT NULL;
CREATE INDEX "audit_logs_createdat_id_idx" ON "silverbox_api"."audit_logs"("createdat", "id");
CREATE INDEX "audit_logs_userid_createdat_id_idx" ON "silverbox_api"."audit_logs"("userid", "createdat", "id");

CREATE TABLE "silverbox_api"."avatars" (
  "user_id" INTEGER NOT NULL,
  "content" BYTEA NOT NULL,
  "size_bytes" BIGINT NOT NULL,
  CONSTRAINT "avatars_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "avatars_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "silverbox_api"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
