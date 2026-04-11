# Multi-stage build for the skybase server + bundled web client.
#
# Stage 1: install workspace deps + build web bundle.
# Stage 2: build server TypeScript -> dist.
# Stage 3: copy only what's needed for runtime, plus openssh-client for the
#          outgoing ssh -tt user@host calls.

# ── Stage 1: web build ──────────────────────────────────────────────────
FROM node:22-bookworm-slim AS web-builder

RUN corepack enable
WORKDIR /app

# Workspace manifests + lockfile first for layer caching.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @skybase/web build

# ── Stage 2: server build ───────────────────────────────────────────────
FROM node:22-bookworm-slim AS server-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/server apps/server

# tsx is fine for production for a personal tool, but compile so cold-start
# is fast and there's no transpile overhead.
RUN pnpm --filter @skybase/server build

# ── Stage 3: runtime ────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# openssh-client for outgoing connections to remote hosts; tini as PID 1
# so the server gets a clean SIGTERM and forwards it to its children.
RUN apt-get update && apt-get install -y --no-install-recommends \
        openssh-client tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1500 skybase \
    && useradd  -u 1500 -g 1500 -m -s /bin/bash skybase

WORKDIR /app

# Copy compiled server, its node_modules (with native node-pty binary), and
# the built web bundle. Keep packages/shared because the .js refers to it.
COPY --from=server-builder /app/node_modules ./node_modules
COPY --from=server-builder /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=server-builder /app/apps/server/dist ./apps/server/dist
COPY --from=server-builder /app/apps/server/package.json ./apps/server/package.json
COPY --from=server-builder /app/packages/shared ./packages/shared
COPY --from=web-builder    /app/apps/web/dist  ./apps/web/dist

# Persistent disk goes here in production (subscriptions JSON, etc.).
RUN mkdir -p /var/lib/skybase && chown skybase:skybase /var/lib/skybase

USER skybase
WORKDIR /app/apps/server

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    SKYBASE_HOSTS_CONFIG=/etc/skybase/hosts.yaml \
    SKYBASE_SSH_KEY=/run/skybase/id_rsa \
    SKYBASE_KNOWN_HOSTS=/run/skybase/known_hosts \
    SKYBASE_VAPID_FILE=/run/skybase/vapid.json \
    SKYBASE_SUBSCRIPTIONS=/var/lib/skybase/subscriptions.json \
    SKYBASE_TRUST_IAP=1

EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
