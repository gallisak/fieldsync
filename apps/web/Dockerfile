FROM node:20-alpine AS deps
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

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/sync-core/package.json packages/sync-core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @fieldsync/sync-core --workspace @fieldsync/web && npm cache clean --force
COPY --from=build /app/packages/sync-core/dist packages/sync-core/dist
COPY --from=build /app/apps/web/next.config.js /app/apps/web/sw.template.js apps/web/
COPY --from=build /app/apps/web/public apps/web/public
COPY --from=build --chown=node:node /app/apps/web/.next apps/web/.next
USER node
EXPOSE 3000
CMD ["npm", "start", "-w", "@fieldsync/web"]
