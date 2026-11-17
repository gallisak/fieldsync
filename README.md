# FieldSync

An offline-first field-service platform: technicians open and update service tickets (and the
parts used) without connectivity; changes sync to an authoritative Postgres-backed server.

## Layout

- `packages/sync-core` – protocol types, shared mutators, sync client (runs in Node and the browser)
- `apps/server` – NestJS API (`pg`, raw SQL): push, pull, SSE stream, change-log GC
- `apps/web` – Next.js (App Router) UI

## Run

    docker compose up --build        # web :3000, api :3001, postgres :5432

or locally:

    npm install
    npm run build:core
    DATABASE_URL=postgres://... SEED_DEMO=true npm run build -w @fieldsync/server && npm start -w @fieldsync/server
    npm run dev -w @fieldsync/web

Demo tokens (with `SEED_DEMO=true`): `admin-token` (all sites), `tech-a-token` (North Plant),
`tech-b-token` (South Plant).

## Protocol in brief

1. The client queues named mutations with a per-client monotonic id and applies them optimistically.
2. `POST /sync/push` sends the queue; the server applies each mutation in a transaction.
3. `GET /sync/pull?cursor=N&clientId=…` returns changes with `version > N` for accessible sites.
4. `GET /sync/stream` emits `poke` events so clients pull promptly.

## Checks

    npm run lint && npm run typecheck && npm test

Integration tests need `DATABASE_URL`; without it they are skipped.

## Your task

See `ЗАВДАННЯ.md`.
