# FieldSync

An offline-first field-service platform: technicians open and update service tickets (and the
parts used) without connectivity; changes sync to an authoritative Postgres-backed server.

## Run

    docker compose up --build        # web :3000, api :3001, postgres :5432

or locally:

    npm install
    npm run build:core
    DATABASE_URL=postgres://... SEED_DEMO=true npm run build -w @fieldsync/server && npm start -w @fieldsync/server
    npm run dev -w @fieldsync/web

Server configuration: `apps/server/.env.example`. Demo tokens (with `SEED_DEMO=true`): `admin-token` (all
sites), `tech-a-token` (North Plant), `tech-b-token` (South Plant).

### Checks

    docker compose up -d postgres
    export DATABASE_URL=postgres://fieldsync:fieldsync@localhost:5432/fieldsync
    npm run lint && npm run typecheck && npm test

Integration tests need `DATABASE_URL`. Without it they are skipped locally; in CI (`CI` set) a missing
`DATABASE_URL` fails the run.

## Architecture

- `packages/sync-core` – protocol types, shared mutators, sync client (runs in Node and the browser)
- `apps/server` – NestJS API (`pg`, raw SQL): push, pull, SSE stream, change-log GC
- `apps/web` – Next.js (App Router) UI

### Protocol in brief

1. The client queues named mutations with a per-client monotonic id and applies them optimistically.
2. `POST /sync/push` sends the queue; the server applies each mutation in a transaction.
3. `GET /sync/pull?cursor=N&clientId=…` returns changes with `version > N` for accessible sites.
4. `GET /sync/stream` emits `poke` events so clients pull promptly.

## Guarantee model

## Decision records

### 1. Protocol correctness

### 2. Deterministic simulation

### 3. Offline-first client

### 4. Partial replication and access

### 5. Merge semantics

### 6. Change-log lifecycle

### 7. Schema evolution

## Found issues

Each issue is reproduced by an automated test that is committed as `it.failing` before the fix (red against
the starter) and switched to `it` with the fix. Server tests live in `apps/server/test/repro/`, client tests
in `packages/sync-core/test/repro/`.

| # | Category | Defect | Reproduced by | Status |
|---|---|---|---|---|
| F1 | Ordering | Log versions come from a sequence: allocated at insert, visible at commit, so a late commit is skipped by readers | `f01-commit-order.integration.spec.ts` | open |
| F2 | Ordering | Pull reads changes and `lastMutationId` in separate snapshots and reports it on non-final pages | `f02-pull-snapshot.integration.spec.ts` | open |
| F3 | Ordering | A poke during an in-flight sync is dropped | `f03-lost-poke.spec.ts` | open |
| F4 | Duplicate push | Dedup check runs outside the transaction without a lock; parallel duplicates all apply | `f04-parallel-duplicate.integration.spec.ts` | open |
| F5 | Poison mutation | A rejected mutation fails the whole push with 500 and blocks the queue forever | `f05-poison.integration.spec.ts` | open |
| F6 | Poison mutation | `constructor` / `__proto__` resolve to prototype members of the mutator registry → 500 | `f06-proto-name.integration.spec.ts` | open |
| F7 | Poison mutation | Out-of-order id answered with a generic 400 the client retries unchanged | `f07-out-of-order.integration.spec.ts` | open |
| F8 | Write access | Authorization trusts the client-supplied `siteId` | `f08-write-access.integration.spec.ts` | open |
| F9 | Read access | Site filter applied only when `cursor = 0` | `f09-read-access.integration.spec.ts` | open |
| F10 | Authenticity | `clientId` ownership never checked on push or pull | `f10-client-ownership.integration.spec.ts` | open |
| F11 | Authenticity | Bearer token accepted in the SSE query string; tokens stored in plaintext | `f11-token-in-url.integration.spec.ts` | open |
| F12 | Access lifecycle | Revoked access and site moves never remove data from clients | `f12-revocation-move.integration.spec.ts` | open |
| F13 | Log lifecycle | GC by age with no floor or reload signal; new clients replay a truncated log | `f13-gc.integration.spec.ts` | open |
| F14 | Client data loss | Pending queue not persisted; `lastMutationId` persisted only after pull | `f14-reload.spec.ts` | open |
| F15 | Client data loss | Tabs share one `clientId` and storage blob with separate id counters | `f15-two-tabs.spec.ts` | open |
| F16 | Client data loss | Pending mutations dropped on push ack, before the pull delivers their effects | `f16-ack-flicker.spec.ts` | open |
| F17 | Determinism | `ticket.create` generates its id and timestamps inside the mutator | `f17-determinism.spec.ts` | open |
| F18 | Merge semantics | `ticket.update` overwrites title and description wholesale | `f18-field-merge.spec.ts` | open |
| F19 | Merge semantics | `ticket.delete` leaves the ticket's parts behind | `f19-orphan-parts.spec.ts` | open |
| F20 | Resource leak (server) | Stream subscribers never removed; no backpressure or heartbeat | `f20-stream-leak.integration.spec.ts` | open |
| F21 | Resource leak (client) | `dispose()` does not abort requests; no request timeout; web effect has no cleanup | `f21-dispose.spec.ts` | open |
| F22 | Resource / behaviour | Fixed 5 s retry without backoff or jitter; immediate re-push loop | `f22-backoff.spec.ts` | open |
| F23 | Input handling | Malformed cursor silently becomes a full-history pull | `f23-bad-cursor.integration.spec.ts` | open |
| F24 | Vacuous test | Assertion inside `catch`: passes when nothing throws | `mutators.spec.ts` (rewritten) | fixed — see below |
| F25 | Vacuous test | Mocked pool, SQL never inspected; passes with F9 present | replaced by `f09-read-access` | fixed — see below |
| F26 | Vacuous test | Fake DB ignores the query; encodes F8 | replaced by `f08-write-access` | fixed — see below |
| F27 | Vacuous test | `SELECT 1` "integration", `it.todo`, silent skip without `DATABASE_URL`, web not type-checked | replaced by the repro suites; tooling | fixed — see below |

## Changes to existing tests

Every starter test that was changed or removed, and why. None of these changes weakens a real assertion: each
removed test could not fail, and each is replaced by one that can.

**`packages/sync-core/test/mutators.spec.ts` — "rejects an invalid status transition" (F24).** The old test
called `ticket.setStatus` inside `try { … } catch (err) { expect(err)… }`. If the mutator did not throw, the
`catch` block never ran, no assertion executed, and Jest reported a pass. Verified: with `done → in_progress`
added to the transition table the old test still passed. It now asserts with `expect(act).toThrow(MutationRejected)`,
checks `code === 'INVALID_TRANSITION'`, and checks the ticket keeps its status; with the same sabotage it fails.

**`apps/server/test/pull.spec.ts` — "only returns changes for sites the user can access" (F25).** The mocked
pool returned `{ rows: [] }` for every query and the test asserted `changes` was empty, so it passed for any SQL
and any parameters — including the starter's, which drops the site filter whenever `cursor > 0` (F9). Removed.
Replaced by `apps/server/test/repro/f09-read-access.integration.spec.ts` (Phase 1), which pulls through HTTP
against real Postgres and checks that no other site's change is returned on either the initial or the
incremental path.

**`apps/server/test/access.spec.ts` — `authorize` allows/rejects by site (F26).** The fake DB ignored the query
and the test passed `siteId` in the mutation args, so it encoded the defect itself: authorization trusting a
client-supplied `siteId` (F8). Removed. Replaced by
`apps/server/test/repro/f08-write-access.integration.spec.ts` (Phase 1), which has a technician target another
site's ticket while sending their own `siteId` and asserts the write is rejected and the row is unchanged.

**`apps/server/test/sync.integration.spec.ts` — "connects to the database" (F27).** The only "integration" test
was `SELECT 1`; it exercised no application code. Removed; the server's integration coverage is the
`*.integration.spec.ts` suites built on `test/support/pg.ts` (a full Nest app per private schema). The rest of
F27 is fixed in the tooling: integration suites now fail instead of silently skipping when `DATABASE_URL` is
missing in CI (`requireDatabaseUrl()`), and `npm run typecheck` now type-checks `apps/web`. The server's
`test:unit` script carries `--passWithNoTests` because the server has no unit tests yet.

**`packages/sync-core/test/client.spec.ts` — two `it.todo` (F27).** "keeps unsynced mutations across a
reload" and "does not lose mutations when two tabs share one clientId" were placeholders that always report
as todo. Removed; replaced by `packages/sync-core/test/repro/f14-reload.spec.ts` and
`packages/sync-core/test/repro/f15-two-tabs.spec.ts`, which assert exactly those behaviours.

## Simulation

## Load results

## Not done / would do differently

## Your task

See `ЗАВДАННЯ.md`.
