FROM node:20-alpine
WORKDIR /app
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/sync-core packages/sync-core
COPY apps/web apps/web
RUN npm install --workspace @fieldsync/sync-core --workspace @fieldsync/web --include-workspace-root \
 && npm run build:core && npm run build -w @fieldsync/web
CMD ["npm", "start", "-w", "@fieldsync/web"]
