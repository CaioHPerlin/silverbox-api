# Silverbox API

Requires Node.js 24 and either pnpm 11 or npm 11. Dependencies are pinned in `package.json`, `pnpm-lock.yaml`, and `package-lock.json`.

## Local development

From `app/`:

```sh
docker compose up -d --wait
```

In the same directory:

```sh
cp .env.example .env
# Replace BETTER_AUTH_SECRET with a unique random value of at least 32 characters.
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate
pnpm dev
```

With npm, use `npm ci`, `npm run db:generate`, `npm run db:migrate`, and `npm run dev` instead.

The database is available on `127.0.0.1:5432`. The API listens on `http://localhost:8000`. The minimum API routes are `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, and `GET /users/me`. The full Better Auth API remains available under `/api/auth`.

## Local file storage

The API stores file bytes in the private `app/.data/` directory by default and metadata in PostgreSQL. The directory is ignored by Git and is never served statically. Set `STORAGE_ROOT` to an absolute path to place files on a persistent volume. `MAX_UPLOAD_BYTES` defaults to 1073741824 (1 GiB) and cannot be configured above that value. The API verifies exact file size and SHA-256 while streaming uploads. Every retained version, including files in trash, counts against the user's quota.

Upload a file as `application/octet-stream` with a URI-encoded `X-File-Name` (use `encodeURIComponent` in a browser) and the exact byte count in `X-File-Size`; optionally set `X-File-Mime` and `X-Folder-Id`. For example:

```sh
curl -b cookies.txt -H 'Origin: http://localhost:8000' \
  -H 'Content-Type: application/octet-stream' \
  -H 'X-File-Name: note.txt' -H 'X-File-Mime: text/plain' \
  -H 'X-File-Size: 5' --data-binary 'hello' \
  http://localhost:8000/files
```

See [`../dados/arquivos.md`](../dados/arquivos.md) for every endpoint, request body, response and the integration results. Swagger is available at `/docs` and `/docs.json`.

Back up PostgreSQL and `STORAGE_ROOT` together while file writes are stopped. Restore both from the same backup set before starting the API again. A database-only backup loses file bytes; a storage-only backup loses ownership, versions and share metadata. The API reconciles expired upload reservations and pending deletions on startup and periodically.

For the default storage path, run these commands from `app/` after stopping the API and setting `DATABASE_URL` to the same database used by the app:

```sh
pg_dump "$DATABASE_URL" -Fc -f silverbox-db.dump
tar -czf silverbox-files.tar.gz .data
# On restore, with the API stopped and an empty target database/storage directory:
pg_restore --clean --if-exists -d "$DATABASE_URL" silverbox-db.dump
tar -xzf silverbox-files.tar.gz
```

For a custom `STORAGE_ROOT`, archive and restore that directory at the same absolute path. Keep both backup files private, restart the API, then check `/storage/usage` and download a sample file.

Google sign-in is enabled when both Google credentials are set; start it with `GET /auth/google`. In Google Cloud Console, register this authorized redirect URI: `http://localhost:8000/api/auth/callback/google`. For deployment, register `${BETTER_AUTH_URL}/api/auth/callback/google` using the production HTTPS URL. `BETTER_AUTH_URL` must match the public API origin. In production, use a private secret.

To stop the database without deleting data, run `docker compose down` from `app/`.

## Auth smoke check

```sh
curl -i -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"name":"Test User","email":"test@example.com","password":"a-long-test-password"}' \
  http://localhost:8000/api/auth/sign-up/email
curl -i -b cookies.txt http://localhost:8000/api/auth/get-session
curl -i -b cookies.txt -H 'Origin: http://localhost:8000' \
  -H 'Content-Type: application/json' -d '{}' \
  http://localhost:8000/api/auth/sign-out
```

Better Auth uses an HTTP-only session cookie. The `Origin` header is required for state-changing session operations such as sign-out.
