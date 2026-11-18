# FieldSync

An offline-first field-service platform: technicians open and update service tickets (and the
parts used) without connectivity; changes sync to an authoritative Postgres-backed server.

## Run

    cp .env.example .env             # local configuration, git-ignored
    docker compose up --build        # web :3000, api :3001, postgres :5432

or locally:

    cp .env.example .env
    docker compose up -d postgres
    npm install
    npm run build:core
    npm run build -w @fieldsync/server && npm start -w @fieldsync/server
    npm run dev -w @fieldsync/web

Configuration lives in one `.env` at the repository root; `.env.example` lists every variable with its meaning.
The server, its integration tests, the web app and docker compose all read it, and a variable that is set in the
real environment wins over the file (that is how CI and the containers are configured). Docker images never
contain a `.env`. Demo tokens (with `SEED_DEMO=true`): `admin-token` (all sites), `tech-a-token` (North Plant),
`tech-b-token` (South Plant).

### Checks

    docker compose up -d postgres
    npm run lint && npm run typecheck && npm test

Integration tests take `DATABASE_URL` from `.env` (or the environment). Without it they are skipped locally; in
CI (`CI` set) a missing `DATABASE_URL` fails the run.

## Architecture

- `packages/sync-core` – protocol types, shared mutators, sync client (runs in Node and the browser)
- `apps/server` – NestJS API (`pg`, raw SQL): push, pull, SSE stream, change-log GC
- `apps/web` – Next.js (App Router) UI

### Protocol in brief

1. The client queues named mutations with a per-client monotonic id and applies them optimistically.
2. `POST /sync/push` sends the queue; the server applies each mutation in a transaction.
3. `GET /sync/pull?cursor=N&clientId=…` returns changes with `version > N` for accessible sites.
4. `GET /sync/stream` emits `poke` events so clients pull promptly. The client reads it with `fetch` (the token goes
   in the `Authorization` header, never in the URL), reconnects with backoff and syncs after every reconnect.

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
| F1 | Ordering | Log versions come from a sequence: allocated at insert, visible at commit, so a late commit is skipped by readers | `f01-commit-order.integration.spec.ts` | fixed |
| F2 | Ordering | Pull reads changes and `lastMutationId` in separate snapshots and reports it on non-final pages | `f02-pull-snapshot.integration.spec.ts` | fixed |
| F3 | Ordering | A poke during an in-flight sync is dropped | `f03-lost-poke.spec.ts` | fixed |
| F4 | Duplicate push | Dedup check runs outside the transaction without a lock; parallel duplicates all apply | `f04-parallel-duplicate.integration.spec.ts` | fixed |
| F5 | Poison mutation | A rejected mutation fails the whole push with 500 and blocks the queue forever | `f05-poison.integration.spec.ts` | fixed |
| F6 | Poison mutation | `constructor` / `__proto__` resolve to prototype members of the mutator registry → 500 | `f06-proto-name.integration.spec.ts` | fixed |
| F7 | Poison mutation | Out-of-order id answered with a generic 400 the client retries unchanged | `f07-out-of-order.integration.spec.ts` | fixed |
| F8 | Write access | Authorization trusts the client-supplied `siteId` | `f08-write-access.integration.spec.ts` | fixed |
| F9 | Read access | Site filter applied only when `cursor = 0` | `f09-read-access.integration.spec.ts` | fixed |
| F10 | Authenticity | `clientId` ownership never checked on push or pull | `f10-client-ownership.integration.spec.ts` | fixed |
| F11 | Authenticity | Bearer token accepted in the SSE query string; tokens stored in plaintext | `f11-token-in-url.integration.spec.ts` | fixed |
| F12 | Access lifecycle | Revoked access and site moves never remove data from clients | `f12-revocation-move.integration.spec.ts` | fixed |
| F13 | Log lifecycle | GC by age with no floor or reload signal; new clients replay a truncated log | `f13-gc.integration.spec.ts` | open |
| F14 | Client data loss | Pending queue not persisted; `lastMutationId` persisted only after pull | `f14-reload.spec.ts` | fixed |
| F15 | Client data loss | Tabs share one `clientId` and storage blob with separate id counters | `f15-two-tabs.spec.ts` | fixed |
| F16 | Client data loss | Pending mutations dropped on push ack, before the pull delivers their effects | `f16-ack-flicker.spec.ts` | fixed |
| F17 | Determinism | `ticket.create` generates its id and timestamps inside the mutator | `f17-determinism.spec.ts` | fixed |
| F18 | Merge semantics | `ticket.update` overwrites title and description wholesale | `f18-field-merge.spec.ts` | fixed |
| F19 | Merge semantics | `ticket.delete` leaves the ticket's parts behind | `f19-orphan-parts.spec.ts` | fixed |
| F20 | Resource leak (server) | Stream subscribers never removed; no backpressure or heartbeat | `f20-stream-leak.integration.spec.ts` | open |
| F21 | Resource leak (client) | `dispose()` does not abort requests; no request timeout; web effect has no cleanup | `f21-dispose.spec.ts` | fixed |
| F22 | Resource / behaviour | Fixed 5 s retry without backoff or jitter; immediate re-push loop | `f22-backoff.spec.ts` | fixed |
| F23 | Input handling | Malformed cursor silently becomes a full-history pull | `f23-bad-cursor.integration.spec.ts` | fixed |
| F24 | Vacuous test | Assertion inside `catch`: passes when nothing throws | `mutators.spec.ts` (rewritten) | fixed — see below |
| F25 | Vacuous test | Mocked pool, SQL never inspected; passes with F9 present | replaced by `f09-read-access` | fixed — see below |
| F26 | Vacuous test | Fake DB ignores the query; encodes F8 | replaced by `f08-write-access` | fixed — see below |
| F27 | Vacuous test | `SELECT 1` "integration", `it.todo`, silent skip without `DATABASE_URL`, web not type-checked | replaced by the repro suites; tooling | fixed — see below |
| F28 | Resilience (server) | A dropped database connection raises an unhandled `'error'` event and crashes the server process | `f28-connection-loss.integration.spec.ts` | fixed |

### F1 — change versions visible out of commit order

**What.** `change_log.version` was a `bigserial`: the number is taken at `INSERT`, but the row becomes visible
at `COMMIT`. Transaction A takes version 10, transaction B takes 11 and commits first; a pull between the two
commits returns 11 and moves the client's cursor past 10. When A commits, its row is never delivered.

**Why it is dangerous.** Silent, permanent divergence under perfectly normal concurrent writes: nothing errors,
the client just never sees one change (and every later change to that row is applied on a stale base).

**Reproduce.** `apps/server/test/repro/f01-commit-order.integration.spec.ts`: push A is paused inside its
transaction (a test hook in `MutationExecutor` blocks on an advisory lock after A's writes), push B runs, an
admin pull happens, then A is released; the next pull from the returned cursor must contain A's change.

**Fix.** Versions come from a single `sync_state` row:
`UPDATE sync_state SET last_version = last_version + n RETURNING last_version`, run after the mutator and
after every entity row lock, as the last lock of the transaction. The row lock is held until `COMMIT`, so a
transaction holding version 10 always commits before any other transaction can even obtain 11 — version
order equals commit order and the log is gap-free. All rows of one mutation share a `tx_seq` (its first
version) and carry `client_id`/`mutation_id`. Migration `003_version_allocation.sql` re-syncs the counter
with `max(version)` and drops the sequence. Write rules: a `put` that changes a row's site logs a `del` under
the old site before the `put` under the new one (this is how a moved ticket leaves the old site's clients);
deleting a row that does not exist logs nothing.

**Alternatives considered.** Reading only below the oldest in-flight transaction (`pg_snapshot_xmin` /
`txid_current_snapshot()`, as several sync engines do) keeps writes fully parallel but couples the cursor to
Postgres transaction ids and still needs care around wraparound and replicas; a logical-replication / outbox
consumer that assigns versions after commit adds a moving part and a lag. The single counter row serialises
only the short tail of each write transaction (allocation → commit), which is far below this system's write
rate.

### F2 — pull acknowledges a mutation before delivering its changes

**What.** Pull read the change page, then `clients.last_mutation_id`, in separate statements on the pool (two
snapshots), and returned `lastMutationId` on every page. With more than one page of changes, page 1 already
said "your mutation 1 is applied" while the change it produced was on page 2 — or had committed between the two
reads and was on no page yet.

**Why it is dangerous.** The client drops a pending mutation once it is acknowledged and shows `base` instead.
Between the two pages the user's own edit disappears from the screen; if the next page fails, it stays gone
until a later sync.

**Reproduce.** `apps/server/test/repro/f02-pull-snapshot.integration.spec.ts`: 600 changes are seeded, then
mutation 1 creates a ticket (version 601); page 1 (limit 500) must not contain it and must not acknowledge
mutation 1.

**Fix.** Pull is one `REPEATABLE READ READ ONLY` transaction: accessible sites, `sync_state`, the changes, the
client row and its rejections all come from the same snapshot. `lastMutationId` is `null` on every page with
`hasMore` and is reported only on the last page, where every change up to that snapshot has been delivered.
A page never splits one mutation: if the page boundary falls inside a transaction (`tx_seq`), the rest of that
transaction is appended. On the last page the cursor jumps to `sync_state.last_version`, so a user whose sites
had no new changes does not re-scan the same range on every pull. Rejections stored by push (F5) are returned
on the last page for mutation ids above `ackedMutationId`.

**Alternatives considered.** Returning `lastMutationId` as "the highest mutation whose changes are all on this
page" needs per-page bookkeeping of which client wrote which row, and still breaks when a mutation writes to a
site the reader cannot see; deferring the acknowledgement to the end of paging is simpler and exact.

### F3 — a poke during a sync is lost

**What.** `sync()` returned the running promise when a sync was already in flight and then forgot the request.
Afterwards it ran again only if local mutations were pending.

**Why it is dangerous.** The stream pokes exactly when another device changed something. If that happens while
this client is mid-pull (whose snapshot predates the change), the change stays invisible until some unrelated
event triggers the next sync — possibly minutes, possibly never on a quiet device.

**Reproduce.** `packages/sync-core/test/repro/f03-lost-poke.spec.ts`: a pull is held, `sync()` is called again,
the pull is released; a second pull must follow.

**Fix.** Single flight with a remembered request: a `sync()` during a run sets `rerun` and returns the running
promise; when the run settles, `rerun` starts exactly one more. Every trigger goes through it: a stored
mutation, a stream poke, `start()`, the browser's `online` and `visibilitychange` events and a background poll
every 30 s × (0.5 + random), all injectable (`env`, `clock`, `random`) so tests need no DOM.

**Alternatives considered.** Queuing every request would run one sync per poke during a burst; cancelling the
running sync for a new one throws away a nearly finished pull. One extra run covers any number of requests
that arrived during the current one.

### F4 — parallel duplicate pushes all apply

**What.** The "already applied?" check read `clients.last_mutation_id` with a plain `SELECT` outside the
mutation's transaction and without a lock, then the transaction applied the mutation and upserted the counter.
Two identical requests in flight (a client retrying a push whose response was lost, while the original is still
running) both saw the old counter and both applied. The upsert could also move the counter backwards.

**Why it is dangerous.** Non-idempotent mutations run twice: a `part.adjust` doubles the stock change. Retries
after timeouts are the normal case on a mobile network, so this is not a rare race.

**Reproduce.** `apps/server/test/repro/f04-parallel-duplicate.integration.spec.ts`: the test holds the part's
row lock, sends 10 identical `part.adjust` requests, waits until all 10 are queued inside Postgres, then
releases. Exactly one must apply, nine must be `duplicate`, and the quantity must change once.

**Fix.** Each mutation runs in one transaction that first creates (if needed) and locks the client's row
(`INSERT … ON CONFLICT DO NOTHING`, then `SELECT … FOR UPDATE`). Every push of one client queues on that lock, so
the duplicate check, the mutation and `last_mutation_id = id` happen atomically and in order. The counter is
set with a plain `UPDATE` under the lock after `id = last + 1` was checked, so it can only move forward.

**Alternatives considered.** A unique `(client_id, mutation_id)` constraint on the log alone would turn the
second apply into a constraint error (a 500), not a `duplicate` answer, and does not cover mutations that write
no log row. Serializable isolation would abort one of the racers and rely on retries for correctness.

### F5 — one rejected mutation blocks the client's queue forever

**What.** A mutator's `MutationRejected` (a business rule, e.g. a status conflict) was never caught: the
transaction rolled back, the request ended with HTTP 500, and `last_mutation_id` stayed where it was.

**Why it is dangerous.** The client cannot tell a rejection from an outage, so it retries the same queue head
every few seconds forever, and nothing queued behind it ever reaches the server. One stale edit silently
freezes a technician's device.

**Reproduce.** `apps/server/test/repro/f05-poison.integration.spec.ts`: a batch of `applied`, a status
conflict and another valid mutation must answer `applied, rejected (STATUS_CONFLICT), applied` with
`lastMutationId = 3`.

**Fix.** The mutation runs under `SAVEPOINT m`. On a rejection the savepoint is rolled back (no partial write
survives), the reason is stored in `mutation_rejections`, and `last_mutation_id` advances anyway — a rejected
mutation is consumed exactly like an applied one. The result is `rejected` with `code`, `message` and
`details`; a retry of the same id answers `duplicate` with the stored reason, so it survives a lost response
(the last pull page reports it as well). Any other non-transient error takes the same path as `INTERNAL` (stack
logged, generic message to the client). Transient database errors (serialization failure, deadlock,
connection loss) are not rejections: the whole transaction is retried up to three times and then the request
ends with `503 UNAVAILABLE`; the id is not consumed.

**Alternatives considered.** Rejecting the whole batch and asking the client to drop the head moves the
decision to the client, which cannot distinguish "rejected" from "failed" reliably; storing nothing and
returning the reason only in the response loses it when the response is lost.

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

### F7 — out-of-order mutation id answered with a retryable 400

**What.** A mutation id greater than `last + 1` was answered with `400 Bad Request` and a free-text message.
The client treats any failed push as "offline" and retries the same request unchanged.

**Why it is dangerous.** Once client and server disagree about the next id (reloads, two tabs — F14/F15), the
client loops forever and nothing new reaches the server; the response gives it nothing to recover with.

**Reproduce.** `apps/server/test/repro/f07-out-of-order.integration.spec.ts`: a fresh client sending id 5 must
get `409 OUT_OF_ORDER` with `details.expected = 1`.

**Fix.** The check runs inside the transaction under the client row lock and throws
`409 { code: 'OUT_OF_ORDER', details: { expected } }`. The rest of the batch is not attempted; mutations
committed earlier in the same request stay committed and are reported by the next pull. The client's recovery
(renumbering from `expected`) is part of the client work in Phase 3.

**Alternatives considered.** Silently skipping ahead would accept a gap and could reorder a client's own
mutations; applying out-of-order ids would break the "one id, applied at most once" rule the dedup relies on.

### F8 — writes authorized against the site the client names

**What.** The starter authorized a mutation by the `siteId` in its arguments, before any row was loaded. A
site-A technician could update, extend or delete a site-B ticket by sending `siteId: A`. Once that was fixed
for live rows, a deleted row was still skipped. `ticket.create` with the id of a deleted site-B ticket revived
it in site A, and the id of one's own deleted ticket revived it as well.

**Why it is dangerous.** Any technician can rewrite or destroy any site's data just by knowing an id. A revived
id hands an old ticket's identity, its parts' `ticketId` and the clients' memory of it, to unrelated content.

**Reproduce.** `apps/server/test/repro/f08-write-access.integration.spec.ts`:
- update, part.add and delete of a site-B ticket with `siteId: A` must all be `NO_ACCESS`, with the row
  unchanged;
- `ticket.create` with the id of a site-B ticket, live or deleted, must be `NO_ACCESS`;
- `ticket.create` with the id of one's own deleted ticket must be `ALREADY_EXISTS`;
- creating in, or moving to, a site the user cannot see must be `NO_ACCESS`.

**Fix.** `AccessService` reads the user's sites once per mutation, inside its transaction and after the row
locks, so a revocation committed earlier is always seen. Before the mutator runs, every loaded row that
exists must be in those sites, deleted rows included: the site is the one stored with the row, never one from
the arguments. After it runs, every row it writes must be in them; that covers the target site of a create
or a move. The executor gives the mutator `undefined` for a deleted row, but `MutatorTx.exists()` still
reports the id as taken, and `ticket.create` refuses any id that exists in any state. Every refusal is
`NO_ACCESS` with the same message as "not found", so ids of other sites cannot be probed. The same rules are in
the simulation's `ModelServer`. `AccessService.fingerprint()` replaces the cursor module's copy, so there is
one format.

**Alternatives considered.** Checking access in each mutator would repeat it seven times and could not see
deleted rows. Allowing a revived id would need a new identity in the log (a `del` and a `put` of unrelated
content) that clients cannot tell apart from an edit.

### F9 — incremental pulls return every site

**What.** The site filter was `cursor = 0 ? sites : null`: only the very first pull was restricted to the
user's sites; every pull with a cursor returned all sites' changes.

**Why it is dangerous.** Every technician's device receives every other site's tickets after its first sync —
a data leak that looks correct in a quick test, because the initial load is filtered.

**Reproduce.** `apps/server/test/repro/f09-read-access.integration.spec.ts`: a site-A technician pulls, a
site-B ticket is created, the incremental pull must not contain site B. A technician with no sites gets an
empty last page without the log being read.

**Fix.** There is one delta query and it always takes the site list: a `LATERAL` per accessible site
(`site_id = s AND version > cursor ORDER BY version LIMIT n`), merged by version. A user with no sites gets an
empty page without querying the log. The cursor carries a fingerprint of the site set it was issued for, which
P5/P6 use to detect access changes.

**Alternatives considered.** Row-level security in Postgres would make the filter impossible to forget but
moves authorization out of the code that is tested here and complicates pooling with a per-request role.

### F10 — another user's `clientId` is accepted

**What.** `clients.user_id` was written but never compared with the caller. Any user could push under another
user's `clientId` and pull with it.

**Why it is dangerous.** Pushing under a foreign `clientId` burns that client's mutation ids, so the owner's
real mutations are later answered `duplicate` and silently lost; pulling with it leaked the owner's
`lastMutationId`.

**Reproduce.** `apps/server/test/repro/f10-client-ownership.integration.spec.ts`: another user pushing under a
technician's `clientId` gets `403 CLIENT_MISMATCH`. Pulling with it shows neither the owner's `lastMutationId`
nor the owner's rejections.

**Fix.** Push locks the client row and answers `403 CLIENT_MISMATCH` when it belongs to another user, before
anything else. Pull reports `lastMutationId` and rejections only for the caller's own client (`0` and `[]`
otherwise), and the push response's `lastMutationId` is read with the same condition.

**Alternatives considered.** Deriving the client id on the server (e.g. `userId + device`) would remove the
check but breaks the client's ability to create its id offline before it has ever talked to the server.

### F11 — the stream token in the URL, every token in plaintext

**What.** `/sync/stream` accepted the bearer token as `?token=`, because `EventSource` cannot send headers.
`users.token` held every token as plain text.

**Why it is dangerous.** A token in a URL is written to access logs and proxy logs, kept in browser history
and sent on as `Referer`. With plaintext storage, a database dump, a backup or a read-only SQL login hands out
every account.

**Reproduce.** `apps/server/test/repro/f11-token-in-url.integration.spec.ts`:
- a stream opened with `?token=` must get `401`;
- no `users` row may contain a token;
- the app's log output during a push and a stream connect must contain no token.

**Fix.** `AuthGuard` (`src/auth/`) reads the token only from `Authorization: Bearer`, and the query-string branch
is gone. Users are looked up by `sha256(token)`. Migration `004_token_hash.sql` hashes the existing tokens in
place and drops the plaintext column; checked on a database that had plaintext users. The demo seed stores
hashes too. CORS allows exactly the headers the clients send: `authorization`, `content-type`,
`x-fieldsync-protocol` and `x-request-id`. The web client has opened its stream with `fetch` and the header
since the poke-stream work. A headless-Chrome run against the rebuilt containers shows the stream request with
the header and no token in the URL, a poke arriving in under 200 ms, and no CORS errors. Controllers take the
user from `@CurrentUser()`.

**Alternatives considered.** A short-lived, single-use stream ticket in the URL would keep `EventSource` but adds
an endpoint and server state. A cookie would bring CSRF and cross-site `SameSite` concerns. A slow password
hash (bcrypt, argon2) protects low-entropy secrets; the tokens are random, so a fast hash is enough and costs
nothing per request. The demo tokens are guessable on purpose.

### F12 — revoked access and site moves never leave the client

**What.** Pull only ever sent changes from the log. When a technician lost a site, no change said so, and its
rows stayed on the device. When the technician gained a site, its existing rows were older than the cursor and
never arrived. A ticket moved to another site kept appearing in the old site's clients.

**Why it is dangerous.** A revoked user keeps reading, and showing, data they no longer may see. A new
assignment looks empty until rows happen to change.

**Reproduce.** `apps/server/test/repro/f12-revocation-move.integration.spec.ts`:
- a client whose site is revoked must end with none of its rows;
- a client that loses a ticket to a site move must drop it;
- a move must reach the old site as deletes of the ticket and each part, the new site as puts, and a client
  that sees both as a delete followed by a put, so the row survives.

`apps/server/test/access/admin.integration.spec.ts` drives the same flow through the admin endpoints. The
simulation runs with access changes on.

**Fix.**
- *Moves.* A write that changes a row's site logs a delete under the old site before the put under the new
  one, in the same transaction.
- *Access changes.* Every cursor carries a fingerprint of the site set it was issued for. When the user's
  current sites give a different fingerprint, pull answers `mode: 'snapshot', reason: 'access_changed'` with
  every live row of the current sites, in version order. A paged snapshot replaces this single page later.
- *Client.* A snapshot page replaces the client's base entirely. Queued mutations stay and are replayed on
  top; one that touches a row now out of reach is rejected `NO_ACCESS` and lands in rejections.
- *Admin endpoints.* `POST`/`DELETE /admin/users/:userId/sites/:siteId` (admin only, each in a transaction)
  change access. They then re-read the user's sites for their open streams and poke them, so the snapshot
  arrives at once.
- *Model.* `ModelServer` answers snapshots the same way; the differential test against Postgres covers them.

**Alternatives considered.**
- Logging a `del` for every row of a revoked site would write one log row per entity per revocation, and
  still give a granted site nothing to send.
- Revocation tombstones keyed by user would need their own lifecycle.
- A snapshot costs one read of the user's sites when access changes, which is rare.

### F14 — a reload loses offline work and reuses mutation ids

**What.** The queue of unsynced mutations lived only in memory, and `lastMutationId` was saved only after a
successful pull. Mutation ids were computed as `lastMutationId + pending + 1`.

**Why it is dangerous.** Closing the tab or a crash while offline silently discards everything the technician
did since the last sync. Worse, a reload between "push acknowledged" and "pull done" starts numbering again
from the old `lastMutationId`: the server answers `duplicate` for the new work and it is lost without any
error.

**Reproduce.** `packages/sync-core/test/repro/f14-reload.spec.ts`: two mutations, dispose, reopen on the same
storage → both must still be queued and visible; a push is acknowledged, the pull fails, reopen, mutate → the
new id must be above every id the server has seen.

**Fix.** Storage became an asynchronous, transactional interface (`load`, `enqueue`, `commitPull`,
`dismissRejection`, `resetClient`), and it owns the queue, the client id and the id counter. `enqueue` takes
`nextMutationId` and appends the mutation in one atomic step, so an id is durable before it is ever sent and is
never handed out twice. `commitPull` applies a page, moves the cursor and — on the last page only — drops
acknowledged mutations and keeps rejected ones with their reason, all in one step guarded by the expected
cursor. `mutate()` stays synchronous for the UI: the mutation shows at once from an in-memory "unsaved" list and
gets its id when it is stored; nothing is pushed before that. The web app's `localStorage` backend migrates the
starter's blob and adopts its `fs_client_id`, so an upgraded browser keeps its server-side identity (checked in
a browser: the next mutation is accepted as number 5 of the old client).

**Alternatives considered.** Persisting the in-memory structures after every change (the starter's `save`)
keeps the race between "id handed out" and "id saved"; ids derived from a timestamp or random value would
break the server's gap-free per-client ordering that duplicate detection relies on.

### F15 — two tabs hand out the same mutation ids

**What.** Every tab of the app shared one `clientId` and one storage blob, but each kept its own in-memory id
counter and its own copy of the state, and each wrote the whole blob back.

**Why it is dangerous.** Two tabs creating something offline both used id `n + 1`: the server applied the first
and answered `duplicate` for the second, which was then silently gone; each tab also overwrote the other's saved
state.

**Reproduce.** `packages/sync-core/test/repro/f15-two-tabs.spec.ts`: two clients on one storage mutate at the
same time; after reopening, both mutations are queued with different ids.

**Fix.** Ids are allocated by the storage in the same atomic step that stores the mutation (`enqueue`; in
IndexedDB one `readwrite` transaction, which browsers serialise across tabs), so tabs can no longer collide.
On top, one tab leads (`WebLocksCoordinator`: a Web Lock held while the tab is open, messages over a
`BroadcastChannel`): only the leader pushes, pulls and keeps the stream; the others store their mutations, tell
the leader (`queue-changed`), reload after its commits (`state-changed`) and show its status. Closing or killing
the leader frees the lock and the next tab takes over from storage. Leadership only saves requests —
correctness does not depend on it: with two leaders the server drops duplicate pushes and `commitPull`'s cursor
check drops the slower of two overlapping pulls (`test/tabs/tabs.spec.ts`, including a leader that dies with its
push in flight). In Chrome, a second tab made no API request at all while its ticket was sent by the first, and
took over the stream and the sync when the first tab closed.

**Alternatives considered.** A `SharedWorker` owning the connection is cleaner but not available in Chrome for
Android, the technicians' likely browser; per-tab client ids would avoid collisions but multiply server clients
and still race on the shared storage.

### F16 — an acknowledged change disappears until the pull arrives

**What.** The client removed a mutation from its queue as soon as the push response said `applied`, but the
change itself reaches `base` only with the next pull. In between, the view (base + queue) contained the change
in neither place.

**Why it is dangerous.** The user's edit visibly reverts for the length of a pull, and if the pull fails or the
app is closed in that window, it is gone from the device until some later sync happens to deliver it.

**Reproduce.** `packages/sync-core/test/repro/f16-ack-flicker.spec.ts`: the push is answered `applied`, the
pull is held; the view must still show the created ticket.

**Fix.** The push response no longer removes anything. The client keeps an in-memory `pushedUpTo` so it does
not resend what the server has answered, and a mutation leaves the queue only inside `storage.commitPull` of
the pull page that also writes its effect into `base` (the last page, which carries `lastMutationId`). After
every committed page the client reloads base and queue from storage and replays the queue, so the view is
always base + every unacknowledged mutation (`test/client/rebase.spec.ts`: a base change under a pending
patch, a row deleted underneath, a snapshot replacing the base with three mutations queued, a pull that
acknowledges two of three). Push failures are now decided by `TransportError`: network / 5xx retry; `401` and
`426` block syncing with the queue kept; `OUT_OF_ORDER` resends from `expected` once; `OUT_OF_ORDER` with
`expected = 1` after earlier acknowledgements, or `CLIENT_MISMATCH`, start over under a new client id with
the queue renumbered; any other 4xx blocks instead of looping. The stored `lastMutationId` never goes
backwards, so a server that lost the client is detected on the next push (checked in a browser against a
server that had never seen the client: `409`, reset, the change is accepted as mutation 1 of the new client).

**Alternatives considered.** Keeping acknowledged mutations in a separate "applied, not yet pulled" list
duplicates the queue and still needs the same commit to retire them; applying the push result to `base`
directly would put an unconfirmed server state into `base` and break the rule that `base` only ever holds
what the server sent.

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

### F21 — disposing the client leaves requests and timers alive

**What.** `dispose()` only cleared the retry timer. A request in flight was never aborted and had no timeout,
and the web app created a client and an `EventSource` in an effect without any cleanup.

**Why it is dangerous.** Every token change or remount leaked a syncing client and an open stream; a hung
request (a dead TCP connection on a mobile network) kept the single sync slot busy forever, so the client
silently stopped syncing.

**Reproduce.** `packages/sync-core/test/repro/f21-dispose.spec.ts`: dispose during a held pull; the request's
`AbortSignal` must be aborted and no timer may remain.

**Fix.** The client owns an `AbortController`; every transport call receives its signal, and `HttpTransport`
combines it with a 20 s timeout in a per-request controller whose timer is cleared when the call ends. A timeout
is a `TransportError('timeout')` (retried with backoff); an abort by the caller is reported as such and ignored.
`dispose()` aborts, clears the retry and poll timers, removes the `online`/`visibilitychange` listeners, closes
storage and drops subscribers. The web effect now returns a cleanup that disposes the client, which also
closes its poke stream.

**Alternatives considered.** `AbortSignal.any` / `AbortSignal.timeout` are shorter but missing on older
browsers, and the timeout's timer would outlive a finished request.

### F22 — fixed 5 s retry and an immediate re-push loop

**What.** Every failure was retried after exactly 5 s, and after every sync the client started another one at
once if anything was still queued — including when the server had answered `200` without handling anything.

**Why it is dangerous.** After an outage every client retries in lockstep every 5 s (a thundering herd on a
recovering server); a server bug that returns empty results turns each client into a hot loop.

**Reproduce.** `packages/sync-core/test/repro/f22-backoff.spec.ts`: with the server unreachable the delays must
grow and stay capped; a push answered without results must not be resent in a loop.

**Fix.** Full-jitter exponential backoff, `delay = random() × min(60 s, 500 ms × 2^attempt)` (`nextDelay`, unit
tested), reset after a successful run; the unconditional re-run is gone (see F3); a push answered without any
result counts as a failure (`502`) and goes through the same backoff. In a browser with the server stopped, the
gaps between failed syncs were 0.3, 0.8, 1.0, 2.0, 0.9, 6.7, 1.5 and 8.6 s, each below its bound.

**Alternatives considered.** Equal or decorrelated jitter spread load similarly; full jitter is the simplest
with the lowest total load, and needs no state beyond the attempt counter.

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

### F28 — a dropped database connection crashes the server

Found while writing the concurrency proof (P2.7); not in the original list.

**What.** When Postgres closes a pooled connection (restart, failover, `pg_terminate_backend`, an idle timeout
in a proxy), node-postgres fails the running query *and* emits an `'error'` event — on the pool for an idle
connection, on the client for a checked-out one. Neither had a listener, and an `'error'` event without a
listener throws, so the whole Node process exited.

**Why it is dangerous.** Any database blip — including a routine Postgres restart while the server is idle —
takes every API instance down at once, and with them every open stream. The transaction-retry and `503`
logic for connection loss never ran, because the process was already gone.

**Reproduce.** `apps/server/test/repro/f28-connection-loss.integration.spec.ts` runs `src/main.ts` in its own
Node process (inside Jest an uncaught exception is only reported, not fatal) and finds its connections by
`application_name`: (1) its idle connections are terminated → the process must stay alive and keep answering;
(2) a push is paused inside its transaction (the test holds the `sync_state` row), its connection is
terminated → the push must be retried on a new connection and applied exactly once.

**Fix.** `Db` listens for `'error'` on the pool (idle connections; the pool already discards the dead client)
and on each client for as long as `tx()` has it checked out. Both only log a warning: the failed query
rejects on its own, `tx()` sees a transient error, releases the connection as broken and retries; after the
retries the request ends with `503 UNAVAILABLE`. `pool.query()` attaches its own listener, so it was not
affected.

**Alternatives considered.** A global `process.on('uncaughtException')` would keep the process alive but also
swallow genuine bugs and leave it in an unknown state; restarting via a supervisor still drops every in-flight
request and stream on each blip.

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

A deterministic simulation drives real `SyncClient`s against `ModelServer`. That is the push and pull protocol
in memory, with the same mutators and the same decision order as the server. Everything runs in virtual time
and draws from one seeded generator, so a seed replays exactly. Code: `packages/sync-core/src/testing/`.

Each step is one random action:
- a mutation from a fixed mix (create, update, status change, delete, add a part, adjust a quantity);
- the passage of time;
- a network partition;
- a device crash and restart on the same storage;
- opening or closing a second tab.

The network loses requests and responses, delivers duplicates, cuts a batch midway and delays every hop by up to
400 ms, so answers overtake each other. After the last step the network heals and every client settles.

Checked after every step:
1. no client holds a row of a site its user could not see;
2. no mutation is applied twice;
3. a client's cursor never goes backwards, except through a snapshot.

Checked at the end:

4. every tab holds exactly the server's rows for its user;
5. nothing is left pending;
6. every issued mutation is either applied or rejected with a reason the client knows;
7. every part quantity equals what it was added with plus each applied adjustment.

```sh
npm run sim                                  # regression seeds, then seeds 1–500 × 400 steps (about 40 s)
SIM_SEED=1234 npm run sim                    # one seed
SIM_SEED=1234 SIM_STEPS=57 npm run sim       # one seed, a shorter run
SIM_SEEDS=50 npm run sim                     # seeds 1–50 (0: regression seeds only)
```

On a failure the runner binary-searches the step count down. It prints the smallest failing run as a command,
followed by the violated invariant and the last 30 steps. `npm test` includes the simulation; CI runs it as
its own step (`test:sim`).

The same simulation also runs against the real `PushService` and `PullService` on Postgres
(`apps/server/test/sim/`): 50 seeds × 200 steps, plus a differential test. The differential test runs one seed
against the model and against Postgres. It requires the same steps, which depend on every answer the server
gives, and the same final state: rows with their sites and versions, each client's last mutation id, and the
rejection codes. Timestamps are left out of the comparison, because the model uses virtual time and Postgres
uses the transaction time. A server call is awaited in full before anything else happens, so a seed replays
exactly on Postgres too.

Access changes (F12) and change-log garbage collection (F13) are not simulated yet. With them switched on,
every seed fails on invariant 1 or 4, which is those two defects.

**Regression seeds** (`packages/sync-core/test/sim/regression-seeds.ts`). They run first. Each entry is the
smallest failing run found when that one fix was reverted on its own, which is evidence that the simulation
catches it. The second column shows how many of seeds 1–100 failed with that fix reverted.

| Seed | Steps | Seeds 1–100 failing | Found |
|---|---|---|---|
| 30 | 1 | 100 | F4: a server that does not deduplicate applies a retried mutation twice |
| 56 | 3 | 100 | F5: a rejection that does not advance the client blocks its queue |
| 91 | 2 | 68 | F15: a follower tab that ignores `state-changed` keeps a stale base |
| 86 | 27 | 41 | F15: a leader that ignores `queue-changed` never pushes another tab's mutation |

## Load results

## Not done / would do differently

## Your task

See `ЗАВДАННЯ.md`.
