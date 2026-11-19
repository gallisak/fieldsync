FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/sync-core/package.json packages/sync-core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @fieldsync/sync-core --workspace @fieldsync/web --include-workspace-root

FROM deps AS build
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY packages/sync-core packages/sync-core
COPY apps/web apps/web
RUN npm run build:core && npm run build -w @fieldsync/web

# The standalone output carries only the files the server needs, traced from the whole repository.
FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
