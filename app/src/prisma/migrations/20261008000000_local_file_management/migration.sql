ALTER TABLE "silverbox_api"."files" ALTER COLUMN "folderid" DROP NOT NULL;
ALTER TABLE "silverbox_api"."files" ADD COLUMN "status" VARCHAR(16) NOT NULL DEFAULT 'ready';
ALTER TABLE "silverbox_api"."shared_links" ADD COLUMN "revokedAt" TIMESTAMP(3);
ALTER TABLE "silverbox_api"."file_versions" ADD COLUMN "mimetype" VARCHAR NOT NULL DEFAULT 'application/octet-stream';

ALTER TABLE "silverbox_api"."folders" DROP CONSTRAINT "fk_folders_folders";
ALTER TABLE "silverbox_api"."folders" ADD CONSTRAINT "fk_folders_folders" FOREIGN KEY ("parentfolderid") REFERENCES "silverbox_api"."folders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "silverbox_api"."files" DROP CONSTRAINT "fk_files_folders";
ALTER TABLE "silverbox_api"."files" ADD CONSTRAINT "fk_files_folders" FOREIGN KEY ("folderid") REFERENCES "silverbox_api"."folders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "silverbox_api"."shared_links" DROP CONSTRAINT "fileid";
ALTER TABLE "silverbox_api"."shared_links" ADD CONSTRAINT "fileid" FOREIGN KEY ("fileid") REFERENCES "silverbox_api"."files"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE TABLE "silverbox_api"."upload_reservations" (
    "id" UUID NOT NULL,
    "userid" INTEGER NOT NULL,
    "storagekey" VARCHAR NOT NULL,
    "sizebytes" BIGINT NOT NULL,
    "createdat" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresat" TIMESTAMP NOT NULL,
    CONSTRAINT "upload_reservations_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "silverbox_api"."upload_reservations" ADD CONSTRAINT "upload_reservations_userid_fkey" FOREIGN KEY ("userid") REFERENCES "silverbox_api"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "upload_reservations_storagekey_key" ON "silverbox_api"."upload_reservations"("storagekey");
CREATE INDEX "upload_reservations_userid_idx" ON "silverbox_api"."upload_reservations"("userid");
CREATE INDEX "upload_reservations_expiresAt_idx" ON "silverbox_api"."upload_reservations"("expiresat");
CREATE INDEX "folders_userid_parentfolderid_idx" ON "silverbox_api"."folders"("userid", "parentfolderid");
CREATE INDEX "files_userid_folderid_isdeleted_createdat_idx" ON "silverbox_api"."files"("userid", "folderid", "isdeleted", "createdat");
CREATE INDEX "files_userid_isdeleted_status_idx" ON "silverbox_api"."files"("userid", "isdeleted", "status");
CREATE UNIQUE INDEX "files_storagekey_key" ON "silverbox_api"."files"("storagekey");
CREATE UNIQUE INDEX "file_versions_fileid_versionnumber_key" ON "silverbox_api"."file_versions"("fileid", "versionnumber");
CREATE UNIQUE INDEX "file_versions_storagekey_key" ON "silverbox_api"."file_versions"("storagekey");
CREATE INDEX "file_versions_fileid_createdat_idx" ON "silverbox_api"."file_versions"("fileid", "createdat");
