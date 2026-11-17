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
| F6 | Poison mutation | `constructor` / `__proto__` resolve to prototype members of the mutator registry → 500 | `f06-proto-name.integration.spec.ts` | fixed |
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
| F17 | Determinism | `ticket.create` generates its id and timestamps inside the mutator | `f17-determinism.spec.ts` | fixed |
| F18 | Merge semantics | `ticket.update` overwrites title and description wholesale | `f18-field-merge.spec.ts` | fixed |
| F19 | Merge semantics | `ticket.delete` leaves the ticket's parts behind | `f19-orphan-parts.spec.ts` | fixed |
| F20 | Resource leak (server) | Stream subscribers never removed; no backpressure or heartbeat | `f20-stream-leak.integration.spec.ts` | open |
| F21 | Resource leak (client) | `dispose()` does not abort requests; no request timeout; web effect has no cleanup | `f21-dispose.spec.ts` | open |
| F22 | Resource / behaviour | Fixed 5 s retry without backoff or jitter; immediate re-push loop | `f22-backoff.spec.ts` | open |
| F23 | Input handling | Malformed cursor silently becomes a full-history pull | `f23-bad-cursor.integration.spec.ts` | fixed |
| F24 | Vacuous test | Assertion inside `catch`: passes when nothing throws | `mutators.spec.ts` (rewritten) | fixed — see below |
| F25 | Vacuous test | Mocked pool, SQL never inspected; passes with F9 present | replaced by `f09-read-access` | fixed — see below |
| F26 | Vacuous test | Fake DB ignores the query; encodes F8 | replaced by `f08-write-access` | fixed — see below |
| F27 | Vacuous test | `SELECT 1` "integration", `it.todo`, silent skip without `DATABASE_URL`, web not type-checked | replaced by the repro suites; tooling | fixed — see below |

### F6 — prototype names reach the mutator registry

**What.** Mutators lived in a plain object and were looked up with `MUTATORS[m.name]`. `constructor`,
`__proto__`, `toString` … are truthy properties of every object, so the lookup "found" a mutator, then
`def.reads` was not a function and the request died with a `TypeError` (500).

**Why it is dangerous.** The name is client-controlled. One such mutation at the head of a queue makes every
retry fail the same way, so a single bad (or malicious) client entry blocks that client's queue forever; the
generic 500 also hid the cause.

**Reproduce.** `apps/server/test/repro/f06-proto-name.integration.spec.ts` (both names; a following valid
mutation must apply).

**Fix.** Two independent layers. The wire schema validates `name` with `z.enum(MUTATOR_NAMES)`, so an unknown
name is a `400 BAD_REQUEST` before anything runs. The registry is a `ReadonlyMap` behind `getMutator(name)`,
which returns `undefined` for anything not registered (`test/mutators/registry.spec.ts` checks the prototype
names), and the server turns that into a `BAD_ARGS` rejection instead of a crash.

**Alternatives considered.** `Object.create(null)` or `hasOwnProperty` checks fix the lookup but keep the
"index a bag of functions with client input" pattern that caused it; a `switch` over names duplicates the
list the schema already owns.

### F17 — non-deterministic `ticket.create`

**What.** `ticket.create` called `crypto.randomUUID()` and `new Date()` inside the mutator.

**Why it is dangerous.** The client replays its queue on every `view()`, so each render produced a different
ticket id (React keys and `/tickets/:id` links changed per render), and the server created yet another id.
Every follow-up mutation that referenced the optimistic id was rejected, i.e. offline work on a new ticket was
lost.

**Reproduce.** `packages/sync-core/test/repro/f17-determinism.spec.ts`: two `view()` calls, five minutes of
fake time apart, must show the same id and `createdAt`.

**Fix.** Ids come from the arguments (the caller generates a UUID once); time comes from `ctx.now` — on the
client the mutation's `createdAt`, stamped once at enqueue time and reused on every replay; on the server the
transaction timestamp. An ESLint override bans `Date`, `Math.random`, `crypto` and `performance` inside
`packages/sync-core/src/mutators/**`, and `test/mutators/registry.spec.ts` checks that identical inputs give
identical rows.

**Alternatives considered.** Generating the id on the server and mapping temporary ids afterwards (the
classic "temp id" approach) needs an id-rewrite step for every queued mutation and every UI reference; with
UUIDs a client-chosen id is collision-safe, and the server rejects reuse with `ALREADY_EXISTS`.

### F18 — concurrent edits of different fields overwrite each other

**What.** `ticket.update` took `title` and `description` and wrote both; the edit form sent both from state
initialised once when the page opened.

**Why it is dangerous.** Two technicians editing different fields of the same ticket: whoever syncs last
silently restores the other field to the value it had when their form opened. Nothing is rejected, so nobody
notices the loss.

**Reproduce.** `packages/sync-core/test/repro/f18-field-merge.spec.ts`.

**Fix.** `ticket.update` takes `{ id, patch }` and writes only the keys present in the patch (`title`,
`description`, `assigneeId`; anything else, or an empty patch, is `BAD_ARGS`). Concurrent edits of different
fields both survive; edits of the same field resolve last-writer-wins in server order. The edit form sends
only the fields that differ from the ticket it was opened on.

**Alternatives considered.** Optimistic concurrency (send the version you edited, reject on mismatch) is
safer for same-field conflicts but turns every unrelated concurrent edit into a rejection the user must
resolve; a per-field CRDT/register is more machinery than one text field per ticket needs.

### F19 — deleting a ticket leaves its parts behind

**What.** `ticket.delete` removed the ticket row only.

**Why it is dangerous.** The parts stayed live forever: replicated to every client of the site, counted in any
inventory view, and pointing at a ticket that no longer exists.

**Reproduce.** `packages/sync-core/test/repro/f19-orphan-parts.spec.ts`.

**Fix.** Mutators can declare `scans()` — rows found by a secondary attribute (`part` by `ticketId`). The
server loads and locks them `FOR UPDATE` like `reads()` keys, the client scans its view, and `ticket.delete`
deletes every scanned part before the ticket. `ticket.move` uses the same scan to move the parts with the
ticket.

**Alternatives considered.** An `ON DELETE CASCADE` in Postgres would not reach the change log (clients would
never hear about the deleted parts) and would not run on the client; soft-hiding orphans in the UI leaves the
data and the replication cost in place.

### F23 — malformed cursor becomes a full-history pull

**What.** The pull endpoint parsed its cursor with `Number(cursor) || 0`, so `cursor=banana`, `cursor=` or a
truncated value all became cursor `0`.

**Why it is dangerous.** A client with a corrupted cursor silently re-downloads the whole history instead of
failing loudly; combined with F9 (no site filter on `cursor > 0`, but a filter on `0`) the outcome of a pull
depended on how the garbage happened to parse. It also made any client bug in cursor handling invisible.

**Reproduce.** `apps/server/test/repro/f23-bad-cursor.integration.spec.ts`: `GET /sync/pull?cursor=banana`
answered 200.

**Fix.** The cursor is now opaque: `base64url(JSON)` of `{ k: 'd', v, fp }` (`fp` identifies the site set it
was issued for). `decodeCursor` validates it with zod and anything else is `400 BAD_REQUEST`. All query
parameters go through `pullQuerySchema` (`limit` 1–500, `ackedMutationId` ≥ 0), so other garbage is a 400 as
well instead of being clamped or defaulted.

**Alternatives considered.** Keeping a numeric cursor and only validating it (`/^\d+$/`) fixes the parsing but
leaves the server unable to change what a cursor means (site fingerprint, snapshot paging) without another
protocol break; signing the cursor (HMAC) would stop clients from forging positions, but a forged cursor can
only point at data the caller may read anyway, so it buys nothing here.

## Changes to existing tests

Every starter test that was changed or removed, and why. None of these changes weakens a real assertion: each
removed test could not fail, and each is replaced by one that can.

**`packages/sync-core/test/mutators.spec.ts` — "rejects an invalid status transition" (F24).** The old test
called `ticket.setStatus` inside `try { … } catch (err) { expect(err)… }`. If the mutator did not throw, the
`catch` block never ran, no assertion executed, and Jest reported a pass. Verified: with `done → in_progress`
added to the transition table the old test still passed. It now asserts with `expect(act).toThrow(MutationRejected)`,
checks `code === 'INVALID_TRANSITION'`, and checks the ticket keeps its status; with the same sabotage it fails.

**`packages/sync-core/test/mutators.spec.ts` — every test (protocol v2).** The mutator API changed: the
registry is a `Map` (`getMutator(name)`), `apply` takes a `ctx`, `ticket.create` takes its `id`, `ticket.update`
takes a `patch`, and no mutator except `ticket.create`/`ticket.move` takes a `siteId`. The calls were updated
to the new shape; every assertion is unchanged. The new suites in `packages/sync-core/test/mutators/`
additionally pin the exact rejection code of every case, so a `BAD_ARGS` cannot stand in for the expected
rejection.

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
`packages/sync-core/test/repro/f15-two-tabs.spec.ts`, which assert exactly those behaviours. The two remaining
tests now pass an `id` to `ticket.create` (required since F17); their assertions are unchanged.

## Simulation

## Load results

## Not done / would do differently

## Your task

See `ЗАВДАННЯ.md`.
