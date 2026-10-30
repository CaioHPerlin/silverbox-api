FROM node:24-bookworm-slim AS base
ENV COREPACK_HOME=/opt/corepack COREPACK_DEFAULT_TO_LATEST=0 CHECKPOINT_DISABLE=1
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack install --global pnpm@11.24.0
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json prisma.config.ts ./
COPY src ./src
RUN DATABASE_URL=postgresql://build:build@localhost/build pnpm db:generate && pnpm build

FROM base AS runtime
ENV NODE_ENV=production PORT=8000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/prisma ./src/prisma
COPY --from=build /app/package.json /app/prisma.config.ts ./
RUN mkdir -p /var/lib/silverbox/files && chown node:node /var/lib/silverbox/files && chmod 700 /var/lib/silverbox/files
USER node
EXPOSE 8000
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && exec node dist/server.js"]
