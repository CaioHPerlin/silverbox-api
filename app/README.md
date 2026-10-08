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
