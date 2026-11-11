# syntax=docker/dockerfile:1
# Build context: the repository root (the server bundles ../windows/src/shared/sync-types.ts).
#   docker build -f server/Dockerfile .
# Stages: web (optional dashboard) → build (typecheck + esbuild) → test (npm test) → runtime (default).

FROM node:24-slim AS web
WORKDIR /src/server
COPY windows/src/shared/sync-types.ts /src/windows/src/shared/sync-types.ts
COPY windows/src/shared/detailed.ts /src/windows/src/shared/detailed.ts
COPY server/ ./
# The dashboard lives in server/web and is built only when server/web/package.json exists.
# WEB_BUILD_STRICT=1 fails the image build when the dashboard build fails; default: ship without it.
ARG WEB_BUILD_STRICT=0
RUN mkdir -p /out \
 && if [ -f web/package.json ]; then \
      ( cd web && npm ci --no-audit --no-fund && npm run build && cp -r dist/. /out/ ) \
      || { echo "WARNING: dashboard build failed"; [ "$WEB_BUILD_STRICT" != "1" ]; }; \
    else echo "no server/web/package.json: image ships without the dashboard"; fi

FROM node:24-slim AS build
WORKDIR /src/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY windows/src/shared/sync-types.ts /src/windows/src/shared/sync-types.ts
COPY server/ ./
RUN npm run typecheck && npm run build

FROM build AS test
ENV NODE_ENV=test
CMD ["npm", "test"]

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /src/server/dist ./dist
COPY --from=web /out ./web/dist
USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8790/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/index.js"]
