# syntax=docker/dockerfile:1

FROM oven/bun:1-alpine AS base
WORKDIR /app

# ---- all deps, needed to validate the command tree before shipping ----
FROM base AS deps
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache,id=bun-install-cache \
	bun install --frozen-lockfile

# ---- validate the command tree + type-check (no compiled output - bun runs .ts directly) ----
FROM base AS check
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
# check:commands (part of `bun run build`) imports @/config, which requires these env vars just to
# be imported - fake build-time values so validating the command tree doesn't need real secrets.
ENV BOT_TOKEN=build BOT_CLIENT_ID=build POSTGRES_DB=build POSTGRES_PASSWORD=build
RUN bun run build

# ---- production-only deps for the final image ----
FROM base AS prod-deps
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache,id=bun-install-cache \
	bun install --frozen-lockfile --production

# ---- runtime ----
FROM base
ENV NODE_ENV=production

# su-exec: lets the entrypoint start as root (needed to fix /app/logs ownership if it's a
# bind-mounted host directory), then drop to the unprivileged "bun" user to actually run the app.
RUN apk add --no-cache su-exec

COPY --from=prod-deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun package.json tsconfig.json ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Deliberately no USER here - the container starts as root so the entrypoint can chown
# /app/logs, then it execs the app as "bun" itself. Don't run application code as root.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "run", "src/index.ts"]
