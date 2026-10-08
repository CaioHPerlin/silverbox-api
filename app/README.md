# Silverbox API

Requires Node.js 24 and pnpm 11. Dependencies are pinned in `package.json` and `pnpm-lock.yaml`.

## Local development

From the repository root:

```sh
docker compose -f compose.db.yml up -d --wait
```

Then, from `app/`:

```sh
cp .env.example .env
# Replace BETTER_AUTH_SECRET with a unique random value of at least 32 characters.
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate
pnpm dev
```

The database is available on `127.0.0.1:5432`. The API listens on `http://localhost:8000`; Better Auth routes are under `/api/auth`. Google sign-in is enabled only when both Google credentials are set. `BETTER_AUTH_URL` must match the public API origin. In production, use an HTTPS URL and a private secret.

To stop the database without deleting data, run `docker compose -f compose.db.yml down` from the repository root.

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
