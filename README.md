# FieldSync

Offline-first field service: technicians edit tickets and parts without a network; changes sync to an
authoritative Postgres-backed server. Task: `ЗАВДАННЯ.md`.

## Run

    cp .env.example .env                 # one config for server, tests, web and compose; real env vars win
    docker compose up --build            # web :3000, api :3001, postgres :5432

Locally: `docker compose up -d postgres`, `npm install`, `npm run build:core`, then
`npm run build -w @fieldsync/server && npm start -w @fieldsync/server` and `npm run dev -w @fieldsync/web`.
Demo tokens: `admin-token` (all sites), `tech-a-token` (North Plant), `tech-b-token` (South Plant).

    npm run lint && npm run typecheck && npm test   # integration tests need DATABASE_URL (from .env); CI fails without it
    npm run sim                                     # simulation, see below
    LOAD_SEED=1 npm run load                        # load run against a running server, see below

### Manual acceptance (Chrome, containers; the offline shell needs the production build)

1. Sign in at http://localhost:3000 with `tech-a-token`. Badge: **All changes saved**.
2. DevTools → Network → **Offline**. Create a ticket, edit its title, add a part and press **+** twice, press
   **Start work**. Badge: **Offline · 6 saved on this device**.
3. Reload normally (not Shift-reload), still offline: everything is there.
4. Open a second tab, set it **Offline** too, create a ticket: both tabs list both tickets.
5. Both tabs back online: **Syncing…** → **All changes saved**. Close the second tab.
6. First tab offline again. In a private window sign in with `admin-token`, open the first ticket, **Cancel**.
7. In the technician tab press **Mark done** on it, go online: **1 change was rejected**, the inbox says
   **Status was changed by someone else. It is now cancelled.**
8. Revoke tech A's site; the technician's list empties (`-X POST` gives it back):

       curl -X DELETE -H 'authorization: Bearer admin-token' -H 'x-fieldsync-protocol: 2' \
         http://localhost:3001/admin/users/00000000-0000-4000-8000-000000000002/sites/00000000-0000-4000-8000-0000000000a1

## Architecture

- `packages/sync-core`: protocol, mutators (the business rules, run on both sides), sync client, storage, tab
  coordination, simulation kit. Knows nothing of React, Nest or Postgres.
- `apps/server`: NestJS + raw `pg`. Controller → service → repository. Push, pull, SSE pokes, admin access, GC,
  logs and `/metrics`.
- `apps/web`: Next.js 14, Feature-Sliced Design, shadcn/ui. Reads only the local view, writes only through
  `client.mutate`.

The client shows `view = base + queued mutations replayed`. Push sends the queue; pull brings changes into
`base`; a mutation leaves the queue only when the pull that carries its effect is committed.

```mermaid
sequenceDiagram
  participant UI
  participant C as SyncClient (leader tab)
  participant IDB as IndexedDB
  participant API as NestJS
  participant PG as Postgres
  participant O as Other clients
  UI->>C: mutate(name, args): validated, applied in memory
  C->>IDB: [IDB tx] next id + append to queue
  Note over C,IDB: crash before commit: the change is lost and was never shown as saved
  C->>API: POST /sync/push (≤100)
  Note over C,API: request or response lost: retried, deduplicated
  API->>PG: [tx per mutation] lock client row → dedup → SAVEPOINT → rows FOR UPDATE → authorize on stored site → mutator → lock sync_state, versions → change_log + entities (or rollback to savepoint + mutation_rejections) → last_mutation_id → COMMIT
  Note over API,PG: transient error: whole tx retried ×3, then 503, id not consumed
  API-->>O: SSE poke after commit (best effort; 30 s jittered poll covers a lost one)
  C->>API: GET /sync/pull?cursor
  API->>PG: [REPEATABLE READ READ ONLY] sites + fingerprint → floor check → delta or snapshot page → lastMutationId + rejections
  API-->>C: changes, cursor, lastMutationId (last page only)
  C->>IDB: [IDB tx] apply page, cursor, drop acknowledged, store rejections
  Note over C,IDB: commit guarded by the expected cursor: a stale or overlapping pull is dropped
  C-->>UI: subscribe() → re-render
```

Protocol v2: header `x-fieldsync-protocol: 2` on every request (else `426 UPGRADE_REQUIRED`). Cursor is opaque
`base64url(JSON)` with a site fingerprint; a malformed one is `400`. Pull answers `delta` or a paged `snapshot`
with `reason` (`initial`, `access_changed`, `cursor_expired`, `cursor_ahead`). Errors are `{ code, message, details? }`.

## Guarantee model

- **Order**: versions come from one counter row locked until commit, so version order is commit order and gap-free.
  A client that has seen version *n* has seen everything ≤ *n* of its sites.
- **Delivery**: at-least-once. Changes are full rows, so re-applying any suffix converges. Pokes are at-most-once;
  a 30 s jittered poll bounds staleness.
- **Mutation application**: effectively-once. The client resends until acknowledged; the server deduplicates on
  `(clientId, mutationId)` under the client row lock, in the same transaction as the effect. Holds while the
  `clients` row exists (`CLIENT_RETENTION_DAYS`, 90, longer than log retention).
- **Rejection**: consumes its id, is stored in `mutation_rejections`, returned in the push response and in every
  pull until acknowledged; a lost response cannot hide it.
- **Atomicity**: one mutation = one transaction (effect, log, counter, ack). A crash leaves all or nothing.

## Observability

- Logs: JSON (pino); every line carries `requestId`, `userId`, `clientId`, `mutationId`; one `mutation` line per
  mutation with status, code and duration. `Authorization`, cookies and URL tokens are redacted.
- `/metrics` (Prometheus, optional `METRICS_TOKEN`): `fieldsync_mutations_total{status}`,
  `fieldsync_mutations_rejected_total{code}`, `fieldsync_delivery_lag_seconds`, `fieldsync_active_streams`,
  `fieldsync_change_log_rows`, `fieldsync_full_resyncs_total{reason}`, push/pull durations, GC deletions.
- `/health` is liveness; `/ready` checks the database and the last migration.

## Decision records

**1. Protocol correctness.** *Options:* sequence versions (the starter, F1); an `xmin`/`pg_snapshot_xmin`
watermark; an advisory lock; one counter row. *Chosen:* `UPDATE sync_state … RETURNING`, the last lock of
every write. *Why:* commit order without tying cursors to transaction ids. Idempotency: client row `FOR UPDATE`
+ per-mutation transaction + `SAVEPOINT` + stored rejections (a unique constraint alone gives a 500, not
`duplicate`; serializable relies on retries). *Limits:* the tail of every write is serialised: fine at the
measured 62 mutations/s; batching or the watermark is the escape hatch.

**2. Deterministic simulation.** *Options:* property tests with fast-check; an own harness. *Chosen:* own
harness: virtual clock, seeded network model (loss, duplicates, reorder, delay, cut batches), crashes, tabs,
access changes, GC; a model server plus the same runs on Postgres with a differential check. *Why:* the bugs
need a clock and a network more than generic shrinking; step-count bisection gives short repros. *Limits:*
Postgres runs are serialised, so real races are covered by the concurrency integration tests instead.

**3. Offline-first client.** *Chosen:* transactional storage (IndexedDB via `idb`) that owns the queue and the
id counter; one leader tab by Web Lock with `BroadcastChannel`; full-jitter backoff; status as facts mapped to
one badge. Notifications: SSE over `fetch` with the `Authorization` header. *Options:* `SharedWorker` (missing on
Chrome for Android), per-tab client ids (more server clients, still racing storage); `EventSource` + URL ticket
(an extra endpoint and state), WebSocket (two-way protocol for one-way, payload-free pokes). *Limits:* without
IndexedDB the client falls back to memory with a visible warning.

**4. Partial replication and access.** *Chosen:* authorize every write on the sites stored with the loaded rows,
read inside the transaction; the cursor carries a fingerprint of the user's sites, and a different
fingerprint answers a snapshot that replaces the client's base. A move logs `del` (old site) + `put` (new).
*Options:* targeted "drop site / add site" deltas, per-user revocation tombstones, row-level security.
*Why:* one mechanism covers grant, revoke and new devices. *Limits:* an access change costs a full snapshot.

**5. Merge semantics.** *Chosen:* `ticket.update` takes a patch: per-field last-writer-wins in server order;
`part.adjust` sends deltas (commutative); a delta below zero is rejected `NEGATIVE_QUANTITY` rather than
clamped (clamping changes the sum depending on order); status follows a state machine and a stale `from` is
`STATUS_CONFLICT` with the current status, shown in the inbox with retry/dismiss. *Options:* optimistic
versions per ticket (every unrelated edit becomes a conflict), CRDT registers. *Limits:* two edits of the same
field: the later one wins silently.

**6. Change-log lifecycle.** *Chosen:* GC deletes log rows up to a cut and raises `min_retained_version`; a cursor
below it gets a `cursor_expired` snapshot. Snapshots are keyset-paged, pinned at the version of the first page,
then followed by a delta from it. *Options:* keep the log forever; one transaction or exported snapshot across
pages (holds back vacuum). *Limits:* the client stages snapshot pages in memory (fine for tens of thousands of rows).

**7. Schema evolution.** *Chosen:* protocol version on every request, `426` with `{ min, current }`; the client
blocks with its queue intact. IndexedDB migrations run in order inside the upgrade transaction, are additive,
may drop base only together with the cursor, and never touch the queue. *Options:* a start-up handshake (an app
open across a deploy keeps the old protocol). *Limits:* none beyond a header per request.

**Persistence.** Raw `pg`, not an ORM: correctness lives in explicit `FOR UPDATE`, savepoints, isolation levels
and lock order (client → ticket → parts → `sync_state`), which an ORM would hide.

## Found issues

Each is reproduced by a test committed as `it.failing` before the fix, then switched to `it`. Server tests are
in `apps/server/test/repro/`, client tests in `packages/sync-core/test/repro/`.

**F1 · ordering: versions visible out of commit order.** *What:* `bigserial` versions are taken at insert,
visible at commit; a pull between two commits moves the cursor past the later-committing one. *Risk:* silent
permanent divergence. *Reproduce:* `f01-commit-order` pauses push A in its transaction, B commits, a pull runs.
*Fix:* versions from the `sync_state` row (see record 1); migration `003`. *Alternatives:* `xmin` watermark,
logical-replication outbox.

**F2 · ordering: pull acknowledges before delivering.** *What:* changes and `lastMutationId` read in two
snapshots, the id sent on every page. *Risk:* the client drops a pending edit whose effect has not arrived; it
flickers or is lost. *Reproduce:* `f02-pull-snapshot`, 600 changes then a mutation, page 1 must not ack it.
*Fix:* one `REPEATABLE READ READ ONLY` transaction; ack only on the last page; a page never splits a mutation.
*Alternatives:* per-page "fully delivered" bookkeeping.

**F3 · ordering: a poke during a sync is lost.** *What:* `sync()` returned the running promise and forgot the
request. *Risk:* stale until an unrelated event. *Reproduce:* `f03-lost-poke`. *Fix:* single flight with a
`rerun` flag, one extra run. *Alternatives:* a run per poke, cancelling the running sync.

**F4 · duplicate push applied twice.** *What:* the dedup check ran outside the transaction without a lock.
*Risk:* retried `part.adjust` doubles stock. *Reproduce:* `f04-parallel-duplicate`, 10 identical pushes queued
on a lock: one `applied`, nine `duplicate`. *Fix:* lock the client row in the mutation's transaction.
*Alternatives:* unique constraint (500), serializable (retries).

**F5 · a rejection blocks the queue.** *What:* `MutationRejected` became a 500 and the counter stayed. *Risk:* one
stale edit freezes the device. *Reproduce:* `f05-poison`: applied, conflict, applied → `lastMutationId = 3`.
*Fix:* `SAVEPOINT`, store the reason, advance the counter; other errors as `INTERNAL`; transient ones retried
then `503`. *Alternatives:* reject the batch and let the client drop the head; reason only in the response.

**F6 · prototype names reach the registry.** *What:* `MUTATORS['constructor']` is truthy → `TypeError` → 500.
*Risk:* a client-controlled permanent block. *Reproduce:* `f06-proto-name`. *Fix:* `z.enum` names on the wire
and a `ReadonlyMap` registry. *Alternatives:* `Object.create(null)`, a `switch`.

**F7 · out-of-order id gets a retryable 400.** *What:* a generic 400 the client resends forever. *Risk:* an
unrecoverable loop after ids diverge. *Reproduce:* `f07-out-of-order`: id 5 on a fresh client →
`409 OUT_OF_ORDER, expected 1`. *Fix:* that 409; the client resends from `expected` or restarts under a new id.
*Alternatives:* skipping ahead (gaps, reordering).

**F8 · writes authorized by the client's `siteId`.** *What:* authorization trusted the argument, before rows were
loaded; deleted ids could be revived. *Risk:* anyone edits any site by knowing an id. *Reproduce:*
`f08-write-access`. *Fix:* authorize on the stored site of every loaded row (deleted ones too) and of every
written row; `NO_ACCESS` for unknown and forbidden alike. *Alternatives:* checks inside each mutator.

**F9 · incremental pulls return every site.** *What:* the site filter only applied at cursor 0. *Risk:* full
cross-tenant leak. *Reproduce:* `f09-read-access`. *Fix:* one delta query, always per accessible site.
*Alternatives:* row-level security.

**F10 · another user's `clientId` accepted.** *What:* `clients.user_id` never compared. *Risk:* burnt ids lose the
owner's mutations. *Reproduce:* `f10-client-ownership`. *Fix:* `403 CLIENT_MISMATCH` on push; pull hides the
foreign ack and rejections. *Alternatives:* server-derived client ids (no offline creation).

**F11 · token in the stream URL, tokens in plaintext.** *What:* the stream took `?token=`; `users.token` was
plain text. *Risk:* tokens in logs, history, dumps. *Reproduce:*
`f11-token-in-url`. *Fix:* header-only auth, stream over `fetch`; `sha256` token hashes (migration `004`); logs
redact. *Alternatives:* URL ticket, cookie (CSRF), bcrypt (pointless for random tokens).

**F12 · revoked access and moves never leave the client.** *What:* pull sent only log changes, and a revoke,
grant or move writes none for the affected client. *Risk:* revoked users keep data; new sites look empty.
*Reproduce:* `f12-revocation-move`, `access/admin.integration.spec.ts`. *Fix:* fingerprint snapshot, `del` +
`put` on a move, admin endpoints poke the user's streams (record 4). *Alternatives:* per-row `del` on revoke.

**F13 · GC leaves new and stale clients incomplete.** *What:* age-based GC with no floor; new clients replayed
the log. *Risk:* devices silently miss data. *Reproduce:* `f13-gc`: 2 000 entities, empty log → a new client
must get all 2 000; stale and new clients equal the server after GC. *Fix:* paged snapshot + retained floor
(record 6); rejections and clients kept 90 days. *Alternatives:* tombstones forever, held transactions.

**F14 · reload loses offline work and reuses ids.** *What:* queue only in memory, counter saved after pull.
*Risk:* lost work; new work answered `duplicate`. *Reproduce:* `f14-reload`. *Fix:* transactional storage that
allocates the id and stores the mutation in one step. *Alternatives:* save-after-change (same race),
timestamp ids (break dedup).

**F15 · tabs hand out the same ids.** *What:* one `clientId`, one blob, a counter per tab. *Risk:* second tab's
work dropped as duplicate. *Reproduce:* `f15-two-tabs`. *Fix:* ids from the storage transaction; one leader tab.
*Alternatives:* `SharedWorker`, per-tab client ids.

**F16 · acknowledged change disappears until pulled.** *What:* the queue dropped a mutation on push ack. *Risk:*
flicker; lost on a crash in between. *Reproduce:* `f16-ack-flicker`. *Fix:* drop only in the pull commit that
carries the effect; failures classified by `TransportError`. *Alternatives:* an "applied, not pulled" list.

**F17 · non-deterministic `ticket.create`.** *What:* `randomUUID()` and `new Date()` inside the mutator.
*Risk:* a new id per render; follow-ups rejected. *Reproduce:* `f17-determinism`. *Fix:* id in args, time from
`ctx.now`; ESLint bans clocks and randomness in mutators. *Alternatives:* server ids with temp-id remapping.

**F18 · different-field edits overwrite each other.** *What:* `ticket.update` wrote title and description from a
form filled once. *Risk:* the later sync silently restores the other field. *Reproduce:* `f18-field-merge`.
*Fix:* patch semantics, the form sends only changed fields (record 5). *Alternatives:* optimistic versions, CRDT.

**F19 · deleting a ticket leaves parts.** *What:* only the ticket row was deleted. *Risk:* orphan parts
replicated forever. *Reproduce:* `f19-orphan-parts`. *Fix:* mutators declare `scans()`;
delete and move cover the parts. *Alternatives:* `ON DELETE CASCADE` (never reaches the log or the client).

**F20 · stream subscribers never released.** *What:* no removal on close, no backpressure, no heartbeat. *Risk:*
unbounded memory, writes to dead sockets. *Reproduce:* `f20-stream-leak` (500 cycles → gauge 0; 200 000 pokes to
a non-reader). *Fix:* remove on `close`, coalesce while `writableNeedDrain`, shared heartbeat, per-user cap
(429), close on shutdown. *Alternatives:* `once('drain')` per write, dropping slow clients.

**F21 · dispose leaves requests and timers.** *What:* `dispose()` cleared only the retry timer, requests had no
timeout, the web effect no cleanup. *Risk:* leaked clients; a hung request blocks syncing forever.
*Reproduce:* `f21-dispose`. *Fix:* one `AbortController`, 20 s timeout per request, cleanup on dispose and in
the web effect. *Alternatives:* `AbortSignal.timeout` (timer outlives the request).

**F22 · fixed 5 s retry, re-push loop.** *What:* every failure retried after exactly 5 s, and a new sync started
at once while anything was queued. *Risk:* thundering herd; hot loop on an empty 200. *Reproduce:*
`f22-backoff`. *Fix:* full-jitter backoff capped at 60 s; a push without results is a failure.
*Alternatives:* equal or decorrelated jitter.

**F23 · malformed cursor means full history.** *What:* `Number(cursor) || 0`. *Risk:* a corrupted cursor
silently re-downloads everything and hides client bugs. *Reproduce:* `f23-bad-cursor`.
*Fix:* opaque validated cursor, `400` otherwise. *Alternatives:* numeric validation only; HMAC (nothing to protect).

**F24 · vacuous test: assertion inside `catch`.** *What:* `mutators.spec.ts` passed when nothing threw. *Risk:*
a broken state machine stays green. *Reproduce:* allowing `done → in_progress` left it green. *Fix:*
`expect(…).toThrow` plus code and unchanged status. *Alternatives:* `expect.assertions(n)`.

**F25 · vacuous test: mocked pull.** *What:* `pull.spec.ts` mocked the pool to return `[]` for any SQL. *Risk:* it
passed with F9 leaking every site. *Reproduce:* green on the starter. *Fix:* replaced by `f09-read-access` on
real Postgres. *Alternatives:* asserting SQL text in the mock (brittle, still not behaviour).

**F26 · vacuous test: fake access DB.** *What:* `access.spec.ts` ignored the query and sent `siteId` in the args.
*Risk:* it encoded F8 as correct. *Reproduce:* green on the starter. *Fix:* replaced by `f08-write-access`.
*Alternatives:* a better fake (still not the real query).

**F27 · vacuous suite and CI.** *What:* a `SELECT 1` "integration" test, two `it.todo`, integration tests skipped
silently without `DATABASE_URL`, the web app never type-checked. *Risk:* CI green while nothing is checked.
*Reproduce:* CI without `DATABASE_URL` passed. *Fix:* real integration suites, `requireDatabaseUrl()` fails in
CI, `typecheck` covers the web app, the todos became `f14-reload` and `f15-two-tabs`. *Alternatives:* a skip
warning (still green).

**F28 · a dropped DB connection crashes the server** (found in P2.7). *What:* no `'error'` listener on the pool
or checked-out clients. *Risk:* any Postgres restart kills every instance. *Reproduce:* `f28-connection-loss`
runs the server as a process and terminates its connections. *Fix:* listeners log; the transaction is retried,
then `503`. *Alternatives:* `uncaughtException` handler (hides bugs).

**F29 · a page in the back/forward cache keeps tab leadership** (found in P8.8). *What:* a frozen page holds its
Web Lock. *Risk:* nothing syncs for minutes. *Reproduce:* `f29-bfcache-leader`; in Chrome, navigate in an
offline leader tab. *Fix:* step down on `pagehide`, ask again on `pageshow` with `persisted`.
*Alternatives:* dispose on `pagehide`, `unload` (disables the cache).

## Changes to existing tests

None weakens a real assertion: each removed test could not fail and has a replacement that can.

- `sync-core/test/mutators.spec.ts` (F24): the assertion sat in `catch`, so it passed when nothing threw (checked
  by allowing `done → in_progress`). Now `expect(…).toThrow` plus code and unchanged status. All its calls were
  updated to the v2 mutator arguments with assertions unchanged.
- `server/test/pull.spec.ts` (F25): a mock returning `[]` for any SQL; passed with F9. Removed for
  `f09-read-access` on real Postgres.
- `server/test/access.spec.ts` (F26): the fake DB ignored the query and the test encoded F8. Removed for
  `f08-write-access`.
- `server/test/sync.integration.spec.ts` (F27): only `SELECT 1`. Removed; integration suites now fail in CI
  without `DATABASE_URL`, and `npm run typecheck` covers the web app.
- `sync-core/test/client.spec.ts` (F27): two `it.todo` replaced by `f14-reload` and `f15-two-tabs`; `ticket.create`
  calls pass an `id` (F17).

## Indexes

Migration `005_indexes.sql`; `entities_site_idx` is dropped as superseded.

| Index | Serves |
|---|---|
| `change_log (site_id, version)` | delta pull: one index range per accessible site (`CROSS JOIN LATERAL`), merged by version |
| `entities (site_id, entity, id) WHERE NOT deleted` | snapshot page: keyset per site, merged by `(entity, id)` |
| `entities ((data->>'ticketId')) WHERE entity = 'part' AND NOT deleted` | part scan of `ticket.delete` / `ticket.move` |
| `entities (version) WHERE deleted` | GC of tombstones |
| `user_sites` primary key `(user_id, site_id)` | access check |

Evidence: `apps/server/test/explain.integration.spec.ts` seeds 200k log rows over 50 sites, 40k entities and
1 000 users, runs real pulls, a push and GC through a client that runs `EXPLAIN (FORMAT JSON)` before each
statement, and asserts the named index with no `Seq Scan` on `change_log` or `entities`. Before `005` four of
five failed; the snapshot query walked the primary key across all sites until it was rewritten per site.

## Simulation

`packages/sync-core/src/testing/`: real `SyncClient`s against `ModelServer` (same mutators and decision order as
the server) in virtual time with one seeded generator, so a seed replays exactly. Steps: mutations, time,
partitions, crash and restart on the same storage, a second tab, grant/revoke, ticket moves, GC and long
offline. The network loses, duplicates, cuts and delays (≤ 400 ms) requests and responses; pages are 3 rows.

Invariants. After every step: (1) no client holds a row outside its user's sites; (2) no mutation applied
twice; (3) a cursor never goes back except through a snapshot. At the end, after healing: (4) every tab's
base equals the server's rows for its user; (5) nothing pending, view = base; (6) every mutation applied
xor rejected with a reason the client knows; (7) part quantity = initial + applied deltas.

    npm run sim                              # regression seeds, then seeds 1–500 × 400 steps (~45 s)
    SIM_SEED=1234 SIM_STEPS=57 npm run sim   # one seed, optionally shortened; SIM_SEEDS=50 for seeds 1–50

A failure is bisected to the shortest failing step count and printed as a command with the last 30 steps. The
same runs go against real Postgres (`apps/server/test/sim/`, 50 seeds × 200 steps) plus a differential test that
requires identical steps and final state against the model.

Regression seeds (`packages/sync-core/test/sim/regression-seeds.ts`), each the shortest failure with one fix reverted:

| Seed | Steps | Flags | Failing of 1–100 | Fix reverted |
|---|---|---|---|---|
| 30 | 1 | crash, tabs | 100 | F4 dedup: a retry applies twice |
| 47 | 3 | crash, tabs | 100 | F5: a rejection blocks the queue |
| 91 | 2 | crash, tabs | 69 | F15: a follower ignores `state-changed` |
| 91 | 45 | crash, tabs | 56 | F15: the leader ignores `queue-changed` |
| 69 | 6 | + access | 97 | F12: no snapshot on an access change |
| 10 | 11 | + access, gc | 71 | F13: GC without a retained floor |

## Load results

`apps/server/test/load/`: 200 real `SyncClient`s in one Node process against a running server (real HTTP
transport and stream, `MemoryStorage`), one technician each, over 10 new sites. Each issues a random mutation
every 1–5 s; each has its own network that drops for 5–60 s windows about 20% of the time, cutting requests in
flight. After 10 minutes all go online and invariants 4–5 are checked against Postgres. Seeded per client
(`LOAD_SEED`); real time decides the interleaving.

    docker compose up -d --build server && LOAD_SEED=1 npm run load   # LOAD_CLIENTS, LOAD_SITES, LOAD_DURATION_S

Run of 2026-11-19 on an Apple M1 (8 cores, 16 GiB, macOS 26.5); server and Postgres 16 in Docker Desktop on the
same machine.

| | |
|---|---|
| Offline time (measured) | 18.8% |
| Mutations | 37 291 (~62/s): applied 36 374, rejected 917, duplicate retries 53 |
| Rejections by code | `STATUS_CONFLICT` 591, `NO_ACCESS` 307, `NEGATIVE_QUANTITY` 19; clients hold the same 917 |
| Delivery lag, push → another client, p50 / p95 / p99 | 0.30 / 0.68 / 1.04 s |
| Delivery lag, `mutate()` → another client (includes author offline) | 0.44 / 28.1 / 46.4 s |
| Snapshots | 200 `initial` |
| `change_log` rows written | 37 545 |
| Convergence after healing | 2.8 s, every base and view equals the server |

The load process itself was busy (event-loop delay p99 462 ms), so the lags are an upper bound; push p95 stayed
≤ 0.25 s, so the `sync_state` lock was not the limit.

## Not done / would do differently

- An access change costs a full snapshot; targeted "drop site / add site" deltas would be cheaper.
- Pokes are in-process, so one server instance; `LISTEN/NOTIFY` is the drop-in for several.
- The token sits in `localStorage` (readable by XSS) and there is no CSP; no SSO (out of scope).
- Snapshot pages are staged in client memory, and a snapshot page reads up to a page per site, which grows with
  the number of sites (admins).
- Deduplication ends with the 90-day `clients` row: a mutation applied just before expiry with a lost ack could
  apply twice.
- Same-field edits are last-writer-wins without telling the loser.
- The ticket table is not virtualised (needed above ~1 000 tickets per site).
- The load run used one machine and one generator process; a distributed run would measure the server alone.
