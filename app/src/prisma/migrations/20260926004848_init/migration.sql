-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "silverbox_api";

-- CreateTable
CREATE TABLE "silverbox_api"."users" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(155) NOT NULL,
    "email" VARCHAR(155),
    "emailverified" BOOLEAN NOT NULL DEFAULT false,
    "image" VARCHAR,
    "user_role" VARCHAR NOT NULL,
    "quotalimitbytes" BIGINT NOT NULL,
    "createdat" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedat" TIMESTAMP,

    CONSTRAINT "pk_users" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "silverbox_api"."session" (
    "id" SERIAL NOT NULL,
    "userid" INTEGER NOT NULL,
    "token" VARCHAR NOT NULL,
    "expiresat" TIMESTAMP NOT NULL,
    "ipaddress" VARCHAR,
    "useragent" VARCHAR,
    "createdat" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedat" TIMESTAMP NOT NULL,

    CONSTRAINT "pk_tbl" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "silverbox_api"."account" (
    "id" SERIAL NOT NULL,
    "userid" INTEGER NOT NULL,
    "accountid" VARCHAR NOT NULL,
    "providerid" VARCHAR NOT NULL,
    "password" VARCHAR(255),
    "accesstoken" VARCHAR,
    "refreshtoken" VARCHAR,
    "idtoken" VARCHAR,
    "accesstokenexpiresat" TIMESTAMP,
    "refreshtokenexpiresat" TIMESTAMP,
    "createdat" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedat" TIMESTAMP NOT NULL,

    CONSTRAINT "pk_account" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "silverbox_api"."verification" (
    "id" SERIAL NOT NULL,
    "identifier" VARCHAR NOT NULL,
    "value" VARCHAR NOT NULL,
    "expiresat" TIMESTAMP NOT NULL,
    "createdat" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedat" TIMESTAMP NOT NULL,

    CONSTRAINT "pk_verification" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "silverbox_api"."folders" (
    "id" SERIAL NOT NULL,
    "userid" INTEGER NOT NULL,
    "parentfolderid" INTEGER,
    "name" VARCHAR NOT NULL,
    "createdat" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedat" TIMESTAMP NOT NULL,

    CONSTRAINT "pk_folders" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "silverbox_api"."files" (
    "id" SERIAL NOT NULL,
    "userid" INTEGER NOT NULL,
    "folderid" INTEGER NOT NULL,
    "originalname" VARCHAR NOT NULL,
    "storagekey" VARCHAR NOT NULL,
    "sizebytes" BIGINT NOT NULL,
    "mimetype" VARCHAR NOT NULL,
    "checksum" VARCHAR NOT NULL,
    "isdeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedat" TIMESTAMP,
    "createdat" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedat" TIMESTAMP NOT NULL,

    CONSTRAINT "pk_files" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "silverbox_api"."file_versions" (
    "id" SERIAL NOT NULL,
    "fileid" INTEGER NOT NULL,
    "storagekey" VARCHAR NOT NULL,
    "versionnumber" INTEGER NOT NULL,
    "sizebytes" BIGINT NOT NULL,
    "checksum" VARCHAR NOT NULL,
    "createdat" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_file_versions" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "silverbox_api"."shared_links" (
    "id" SERIAL NOT NULL,
    "fileid" INTEGER NOT NULL,
    "userid" INTEGER NOT NULL,
    "token" VARCHAR NOT NULL,
    "expiresat" TIMESTAMP NOT NULL,
    "createdat" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_shared_links" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "silverbox_api"."audit_logs" (
    "id" SERIAL NOT NULL,
    "userid" INTEGER NOT NULL,
    "action" VARCHAR NOT NULL,
    "ipaddress" VARCHAR NOT NULL,
    "details" VARCHAR,
    "createdat" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_audit_logs" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_unq" ON "silverbox_api"."users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "token_unq" ON "silverbox_api"."session"("token");

-- CreateIndex
CREATE UNIQUE INDEX "token_link_unq" ON "silverbox_api"."shared_links"("token");

-- AddForeignKey
ALTER TABLE "silverbox_api"."session" ADD CONSTRAINT "userid" FOREIGN KEY ("userid") REFERENCES "silverbox_api"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "silverbox_api"."account" ADD CONSTRAINT "userid" FOREIGN KEY ("userid") REFERENCES "silverbox_api"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "silverbox_api"."folders" ADD CONSTRAINT "userid" FOREIGN KEY ("userid") REFERENCES "silverbox_api"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "silverbox_api"."folders" ADD CONSTRAINT "fk_folders_folders" FOREIGN KEY ("parentfolderid") REFERENCES "silverbox_api"."folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "silverbox_api"."files" ADD CONSTRAINT "fk_files_users" FOREIGN KEY ("userid") REFERENCES "silverbox_api"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "silverbox_api"."files" ADD CONSTRAINT "fk_files_folders" FOREIGN KEY ("folderid") REFERENCES "silverbox_api"."folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "silverbox_api"."file_versions" ADD CONSTRAINT "fk_file_versions_files" FOREIGN KEY ("fileid") REFERENCES "silverbox_api"."files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "silverbox_api"."shared_links" ADD CONSTRAINT "fileid" FOREIGN KEY ("fileid") REFERENCES "silverbox_api"."files"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "silverbox_api"."shared_links" ADD CONSTRAINT "userid" FOREIGN KEY ("userid") REFERENCES "silverbox_api"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "silverbox_api"."audit_logs" ADD CONSTRAINT "userid" FOREIGN KEY ("userid") REFERENCES "silverbox_api"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
