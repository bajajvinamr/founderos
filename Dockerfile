FROM node:lts-trixie-slim AS base
ARG USER_UID=1000
ARG USER_GID=1000
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu curl git wget ripgrep python3 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Modify the existing node user/group to have the specified UID/GID to match host user
RUN usermod -u $USER_UID --non-unique node \
  && groupmod -g $USER_GID --non-unique node \
  && usermod -g $USER_GID -d /founderos node

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/templates/package.json packages/templates/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY patches/ patches/

RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .

# Vite reads `import.meta.env.VITE_*` at build time and inlines the values into
# the JS bundle. These ARGs come from `fly deploy --build-arg ...` (see
# .github/workflows/deploy-prod.yml or the manual command in
# docs/runbooks/supabase-config.md). Setting them as ENV makes them visible to
# the `pnpm --filter @founderos/ui build` process spawned below.
#
# Why every VITE_ var is listed explicitly: ARG values are NOT inherited as ENV
# unless we assign them. If you add a new VITE_* env, add an ARG+ENV pair here
# AND wire it through the deploy command — otherwise it'll be empty in the
# bundle and the runtime guard in src/lib/supabase.ts will scream.
#
# `vite.config.ts` has a build-time guard that hard-fails the build if the
# Supabase ARGs are missing or look like the placeholder sentinel. So a
# Dockerfile build with no --build-arg won't silently ship a broken bundle —
# it'll exit non-zero with a clear error message.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_SENTRY_DSN
ARG VITE_SENTRY_TRACES_SAMPLE_RATE
ARG VITE_BUILD_GIT_SHA
ARG VITE_BUILD_TIME
ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL}
ENV VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY}
ENV VITE_SENTRY_DSN=${VITE_SENTRY_DSN}
ENV VITE_SENTRY_TRACES_SAMPLE_RATE=${VITE_SENTRY_TRACES_SAMPLE_RATE}
ENV VITE_BUILD_GIT_SHA=${VITE_BUILD_GIT_SHA}
ENV VITE_BUILD_TIME=${VITE_BUILD_TIME}

RUN pnpm --filter @founderos/ui build
RUN pnpm --filter @founderos/plugin-sdk build
RUN pnpm --filter @founderos/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
WORKDIR /app
COPY --chown=node:node --from=build /app /app
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai \
  && mkdir -p /founderos \
  && chown node:node /founderos

COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
  HOME=/founderos \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  FOUNDEROS_HOME=/founderos \
  FOUNDEROS_INSTANCE_ID=default \
  USER_UID=${USER_UID} \
  USER_GID=${USER_GID} \
  FOUNDEROS_CONFIG=/founderos/instances/default/config.json \
  FOUNDEROS_DEPLOYMENT_MODE=authenticated \
  FOUNDEROS_DEPLOYMENT_EXPOSURE=private \
  OPENCODE_ALLOW_ALL_MODELS=true

VOLUME ["/founderos"]
EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
