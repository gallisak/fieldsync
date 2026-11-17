FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/sync-core packages/sync-core
COPY apps/server apps/server
RUN npm install --workspace @fieldsync/sync-core --workspace @fieldsync/server --include-workspace-root \
 && npm run build:core && npm run build -w @fieldsync/server
CMD ["node", "apps/server/dist/main"]
