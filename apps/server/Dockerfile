FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/sync-core/package.json packages/sync-core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @fieldsync/sync-core --workspace @fieldsync/server --include-workspace-root

FROM deps AS build
COPY packages/sync-core packages/sync-core
COPY apps/server apps/server
RUN npm run build:core && npm run build -w @fieldsync/server

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/sync-core/package.json packages/sync-core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @fieldsync/sync-core --workspace @fieldsync/server && npm cache clean --force
COPY --from=build /app/packages/sync-core/dist packages/sync-core/dist
COPY --from=build /app/apps/server/dist apps/server/dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=5s --timeout=3s --retries=20 CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3001}/ready" || exit 1
CMD ["node", "apps/server/dist/main"]
