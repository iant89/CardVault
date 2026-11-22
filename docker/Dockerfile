# syntax=docker/dockerfile:1.7
# One multi-stage build for the whole monorepo; targets: api, worker, web.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY migrations ./migrations
# developer tools (Developer menu → TCGdex Harvester); no dependencies to install
COPY tools ./tools
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm -r run build
# Drop dev dependencies for the runtime images. (`pnpm prune` drops workspace
# links in a monorepo, so do a clean production-only reinstall instead.)
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && pnpm install --prod --frozen-lockfile

FROM base AS node-runtime
ENV NODE_ENV=production STORAGE_DIR=/data/storage
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data/storage && chown -R node:node /data
COPY --from=build --chown=node:node /app /app
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]

FROM node-runtime AS api
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/index.js"]

FROM node-runtime AS worker
CMD ["node", "apps/worker/dist/index.js"]

FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
