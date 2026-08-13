# Decisions

One entry per non-obvious choice, with the reasoning. Newest at bottom.

## 2026-08-07 — Stack: TypeScript (Node 22) + Fastify

Chose TypeScript over Go. No strong preference either way going in; TS/Node
keeps one language across API and any future workers, and Vitest +
Testcontainers is a smaller step for a first pass at this project.

## 2026-08-07 — Modular monolith, schema-per-module

Following the lab spec directly: one deployable, one Postgres instance, but
modules get separate schemas and talk to each other only through events or
in-process calls to a module's public interface — never a cross-schema
query. This buys the saga/idempotency/outbox/DLQ mechanics without
service-discovery noise, and keeps a clean extraction seam for M8.

## 2026-08-07 — Migrations: plain SQL, hand-rolled runner

No ORM. Migrations are numbered `.sql` files in `/migrations`, applied in
order by a small script (`platform/migrate/run.ts`) that tracks applied
versions in a `schema_migrations` table it creates on first run. The
locking semantics in seat holds and reservation transitions are the point
of this project — an ORM would paper over exactly the SQL we need to
reason about.

## 2026-08-07 — M0 scope: no domain modules yet

M0 is scaffold only: Compose (Postgres + RabbitMQ + app), migration
runner, health endpoints, one Testcontainers integration test. The
`modules/*` directories from the architecture sketch are not created until
their milestone (catalog/inventory at M1, ordering at M3, etc.) so the
repo doesn't carry empty stubs ahead of the work that fills them.

## 2026-08-07 — Module boundaries: separate Postgres schemas, cross-schema FK allowed

`catalog.events` and `inventory.seats` live in their own Postgres
schemas. `inventory.seats.event_id` carries a real foreign key into
`catalog.events` — the "never query across schema boundaries" rule in the
project spec is read as an application-code rule (no module's repository
code does a cross-schema `JOIN`), not a ban on DB-level referential
integrity. Application code composes results from each module's own
queries (e.g. `countAvailableByEventIds` batches over `inventory.seats`
only; the API route layer merges it with `catalog.listEvents()` in
memory) rather than writing a join across schemas itself.

## 2026-08-07 — Event + seat creation: one transaction, two modules

Creating an event and generating its seat rows must be atomic — an event
with zero seats is a broken state, not a valid one. Since both schemas
live in the same Postgres instance, `platform/db/withTransaction.ts`
wraps a single `pg` client across calls into `modules/catalog` and
`modules/inventory`, each of which only ever touches its own schema's
tables. This is deliberately *not* a saga — sagas are for the M3+ payment
flow, where compensating actions and cross-process failure windows are
the point. Here a plain DB transaction is the correct, boring tool.

## 2026-08-07 — Sale-window check built now, wired in at M2

M1's acceptance criteria mention "reservation attempts outside the window
rejected," but `POST /reservations` doesn't exist until M2. Rather than
build a throwaway partial endpoint, the window logic is a pure,
fully-tested function — `isSaleWindowOpen` / `saleWindowStatus` in
`modules/catalog` — that M2's reservation endpoint will call directly.
Both `sale_starts_at` and `sale_ends_at` are treated as inclusive
boundaries (exactly-at-start and exactly-at-end are OPEN), matching the
spec's note that the window gates reservation *creation* only — a
reservation started right before close is allowed to finish paying after
the window shuts.

## 2026-08-11 — M2 seat holding: retry loop, not single-shot select+update

The spec's example seat-hold SQL is a single-shot conditional UPDATE: pick
N candidate seat ids, try to claim exactly those, roll back and 409 if you
didn't get all N. That's correct when a request already knows *which*
seats it wants — but customers here only specify a seat *count* (no seat
maps, anti-goal), so with `seatCount=1` every concurrent request
independently selects the same lowest-id `AVAILABLE` seat as its only
candidate. Exactly one wins it; everyone else has no fallback and fails
immediately, even with other seats still free. A first draft had exactly
this bug — caught by a Plan-agent review before it was built, not after.

The fix (`modules/inventory/src/seats.repository.ts`,
`holdSeatsForEvent`): loop candidate-select + conditional-UPDATE inside the
reservation's own transaction. A losing round re-selects from what's still
available (excluding whatever just got committed) and tries again, up to a
generous attempt cap, until it reaches the requested count or genuinely
runs out. A final shortfall rolls back the whole transaction — including
any partial holds picked up in earlier rounds of the same attempt — and
the caller gets a 409. Still never a bare read-then-write outside a
conditional UPDATE; just the spec's own primitive applied repeatedly
instead of once. Verified against the M2 acceptance test (50 concurrent
requests for a 10-seat event → exactly 10 holds, 40 clean 409s) across
multiple runs, not just once.

## 2026-08-11 — Sweeper: one transaction per batch, not per reservation

`runSweepOnce` expires all due reservations in a single bulk `UPDATE ...
RETURNING`, then releases each one's seats in the same transaction, rather
than a separate transaction per reservation. What makes race condition #2
(sweeper vs. a future payment-confirm handler) safe is the conditional
`WHERE state='AWAITING_PAYMENT' AND held_until < now()` predicate, not the
transaction boundary — batching doesn't weaken that guarantee, and at M2
there's no other writer yet for a per-row failure to be isolated from.
Simpler now, nothing foreclosed for M3.

## 2026-08-11 — `ordering.reservations` schema: no PENDING state, no payment columns yet

A reservation row is only inserted *after* seats are successfully held,
directly as `AWAITING_PAYMENT` — no persisted `PENDING` state, since
there's nothing to compensate if the hold attempt fails before any row
exists. Columns like `amount_cents`, `payment_id`, `idempotency_key`, and
states like `PAID`/`FULFILLED` are left out of the M2 migration and will
arrive via `ALTER TABLE` in M3/M4 when the payment saga actually needs
them — same "don't build schema ahead of its milestone" call made for M1.

## 2026-08-12 — Correction: the M2 sweeper's batching claim above was wrong

The 2026-08-11 sweeper entry claimed "batching doesn't weaken the
guarantee" that the conditional `WHERE state='AWAITING_PAYMENT' AND
held_until<now()` predicate makes race condition #2 safe. That was true
only as long as nothing else could ever concurrently write to the same
row — which stopped being true the moment M3 added a second writer (the
payment pivot). Caught by a Plan-agent review before M3's race test was
even written, not after:

`runSweepOnce`'s bulk statement is `UPDATE ... WHERE id IN (SELECT id
FROM reservations WHERE state='AWAITING_PAYMENT' AND held_until<now()
LIMIT $1) RETURNING ...`. The subquery is evaluated once, up front, as a
non-locking read, producing a fixed set of ids. When the outer UPDATE has
to wait for a row lock held by a concurrent transaction (here: the
payment pivot transitioning that same reservation to `PAID`), Postgres
re-checks the row after the wait (`EvalPlanQual`) — but it only re-checks
the *outer* WHERE clause (`id IN <fixed set>`), never re-running the
inner subquery's `state='AWAITING_PAYMENT'` filter. So a reservation that
just won the pivot race (now `PAID`/`FULFILLED`) could still get
clobbered back to `EXPIRED` by a sweeper batch that captured it as a
candidate a moment earlier.

Fix (`modules/ordering/src/reservations.repository.ts`,
`expireDueReservations`): duplicate the guard into the *outer* WHERE too
(`AND state='AWAITING_PAYMENT' AND held_until<now()`), so it gets
independently re-checked by `EvalPlanQual` exactly like a plain
single-row conditional UPDATE would. No-op 99.99% of the time; required
for the sweeper-vs-payment race to be reliable rather than usually-safe.
General rule for this codebase going forward: conditional-update dedup
for concurrent state transitions only holds for `WHERE id=$1 AND
state=$2`-shaped updates — a subquery/batch-selected bulk update must
repeat its guard in the outer WHERE or it silently loses this property.

## 2026-08-12 — M3 pivot and fulfillment: two transactions, not one

`tryTransitionToPaid` (the pivot — flips `AWAITING_PAYMENT` → `PAID`) and
`fulfillPaidReservation` (issue tickets, flip seats to `SOLD`, flip `PAID`
→ `FULFILLED`) are deliberately separate `withTransaction` calls in
`modules/ordering/src/settle.ts`, not one. Bundling them looked
appealing (there's no message queue yet, nothing external can fail
issuing a ticket row) but has a real failure mode even in this fake
system: if fulfillment ever had to be retried and shared a transaction
with the pivot, a retry failure would roll the PAID transition back too
— leaving a reservation that reads `AWAITING_PAYMENT` again with a
payment that's already `SUCCEEDED`. If enough time passes before the
next retry, the hold expires, the sweeper claims it, and a later tick
routes a successfully-captured payment down the expensive REFUNDING path
for no reason. That's the exact "unhappy pivot" mistake the project
exists to teach against — so the split stands even without a queue yet.
Fulfillment is built to be safely re-run (ticket insertion is
`ON CONFLICT (seat_id) DO NOTHING` + re-fetch; seat-sold and the
`PAID→FULFILLED` flip are both conditional updates), and the payment
poller's candidate query includes reservations stuck in `PAID` so a
partial failure gets retried on the next tick.

## 2026-08-12 — Fake gateway: two independent timers, not one

`modules/payments`'s gateway simulator (resolves confirmed `PENDING`
intents to `SUCCEEDED` after a fake processing delay) and
`modules/ordering`'s payment poller (notices terminal payments and
advances the reservation) run on two separate `setInterval`s, started
independently in `server.ts`. Collapsing them into one tick was tempting
but conflates two roles the spec keeps distinct: the gateway simulator
stands in for an external, out-of-process actor (Stripe's own
processing), and it's not the orchestrator's job to advance that actor's
clock — only to observe it, matching "poll, don't webhook."

## 2026-08-12 — Payment poller keeps an in-memory backoff schedule

`modules/ordering/src/payment-poller.ts` tracks per-reservation poll
attempts in a plain `Map`, following the spec's explicit 1s/2s/3s/5s...
capped schedule (never scheduled past a reservation's `held_until`)
rather than just re-checking every candidate on every tick. This is
intentionally not persisted — a process restart re-seeds every candidate
for immediate polling, which is harmless (the schedule is a pacing
hint, not a source of truth; the database rows are that). Chosen over
the simpler flat-sweep approach because the spec calls out the backoff
schedule in enough detail to read as deliberate pedagogy (realistic
external-call polling), not incidental color.

## 2026-08-12 — Race test: deadline offsets, not hoped-for wall-clock jitter

The M3 sweeper-vs-payment race test (`apps/api/test/
sweeper-vs-payment-race.test.ts`) does not rely on real timing jitter to
sample both outcomes. `tryTransitionToPaid`'s guard requires
`held_until>=now()`; the sweeper's requires `held_until<now()` — for a
fixed timestamp those are a strict partition of a single instant, so a
`held_until` already in the past makes a `FULFILLED` outcome
*structurally* impossible (not just unlikely) no matter how the two
transactions interleave, and a `held_until` far in the future makes
`REFUNDED` structurally impossible. An earlier draft set `held_until` a
full second in the past for every iteration and got deterministic,
uninteresting `EXPIRED`-only results (worse: a few iterations got stuck
in `EXPIRED` because a single `settlePaidPayment` call, like a single
poller tick, can lose a narrow timing window and needs a follow-up call
to resolve — the test now simulates that follow-up explicitly, the same
way the real poller's next tick would). The fixed test instead runs
three deliberate buckets per 100 iterations — generous positive offset
(payment should win), offset already past (sweeper should win), and a
tight ~15ms offset raced concurrently (genuine contention, the scenario
that actually exercises the `EvalPlanQual` fix above) — guaranteeing
both outcomes are observed on every run instead of hoping for it.

## 2026-08-13 — `platform/idem` is flat, not module-shaped

`catalog`/`inventory`/`ordering`/`payments` each have `index.ts` +
`src/*.ts` because they're business modules with a public interface
other modules call into. `platform/idem` (like `platform/db` and
`platform/migrate` before it) is cross-cutting infra, not a fifth
module — the architecture doc names it `platform/idem` for a reason. It
gets its own Postgres schema (`idem`) for the same "own schema per
concern" reasoning as the business modules, but its files
(`repository.ts`, `withIdempotency.ts`, `sweeper.ts`, `hash.ts`) sit
flat with no `src/` and no barrel, imported by direct relative path —
matching `platform/db/withTransaction.ts`'s existing shape, not the
modules' shape. Caught before being built the other way, not after.

## 2026-08-13 — Idempotency caches business errors too, not just success

`withIdempotency`'s handler is expected to catch its own typed domain
errors and return them as `{status, body}` rather than letting them
propagate — so a `409 SeatsUnavailableError` or `422
SaleWindowClosedError` gets recorded as the permanent, replayable
outcome for that key exactly like a `201` would. Only a genuinely
unexpected exception (not one of the endpoint's known error types) is
allowed to propagate out of the handler, rolling back the transaction
and leaving no idempotency record — so a legitimate retry after an
infra failure isn't permanently poisoned. This matches the spec's own
"Completed → replay the stored status and body verbatim," applied
uniformly: an idempotency key represents one specific attempt, same
model Stripe's own keys use. A client that wants a fresh attempt after
a business-logic failure (e.g. seats sold out) sends a new key, not a
retry of the old one.

## 2026-08-13 — `createReservation`/`confirmReservationPayment` take a client, not a pool

Both functions used to own their own `withTransaction(pool, ...)` call.
M4 requires "insert the PENDING idempotency row in the same transaction
as the work," which is only possible if something else owns that one
transaction — so both were changed to accept an already-open
`PoolClient` instead, and `withIdempotency` owns the transaction
(PENDING insert → handler → COMPLETED update, all one commit-or-rollback
unit). This isn't really "breaking" anything: every repository function
these two call was already `Queryable`-typed and already called with a
`client` today — these were the only two functions in `ordering` still
opening their own transaction, so this makes them consistent with
everything else rather than the odd ones out. Typed as `PoolClient`
specifically (not `Queryable`, which also allows a bare `Pool`) so
calling either function outside an open transaction is a compile error,
not a runtime footgun — the whole point now depends on running inside
someone else's transaction.

## 2026-08-13 — Savepoint boundary around the actual work, inside the idempotency handler

Moving the two functions above to take a `client` created a real bug,
caught by the existing "409 when requesting more seats than the event
has" test failing after the refactor (not by design review): `createReservation`
can throw `SeatsUnavailableError` *after* `holdSeatsForEvent`'s retry
loop has already committed-in-progress a few partial holds. Before M4,
that throw unwound the function's own `withTransaction` and rolled
everything back automatically. After M4, the route catches that error
*inside* the handler passed to `withIdempotency` and returns a normal
`{status: 409, body}` — which looks like clean success to the
enclosing transaction, so it commits, partial seat holds included.

Fix: `platform/db/withSavepoint.ts` wraps just the risky call
(`withSavepoint(client, () => createReservation(client, input))`)
inside each route's handler. A `SAVEPOINT` before the call and
`ROLLBACK TO SAVEPOINT` on throw undoes only the work's partial writes,
then rethrows so the route's existing `try/catch` can still convert it
to a response — while the outer transaction (idempotency bookkeeping)
commits normally around it. General rule going forward: any handler
passed to `withIdempotency` that calls something capable of partial
writes before throwing needs this savepoint boundary around that call,
not just a try/catch.

## 2026-08-13 — Idempotency-Key required means every M0–M3 test needed one

Making the header required broke all four pre-existing integration test
files at once (`reservations.test.ts`, `sweeper.test.ts`,
`payment-saga.test.ts`, `sweeper-vs-payment-race.test.ts`) — every
`reserve()`/`confirm()` helper started 400ing. Fixed by giving each
helper a `randomUUID()` default parameter (evaluated fresh per call, so
existing one-call-one-reservation test semantics are unchanged). The one
place this needed care: M2's 50-concurrent-seat-race test, where 50
different (fake) customers race for 10 scarce seats — if that test's
helper accidentally shared one key across calls instead of generating a
fresh one per call, 49 of the 50 requests would collapse into
`409 Retry-Later` idempotency bounces instead of the real
`409 SeatsUnavailableError` the test exists to exercise, and the test
would pass for the wrong reason. Confirmed the default-parameter pattern
avoids this before relying on it.

## 2026-08-13 — Outbox publish uses a confirm channel, not a plain one

A first draft published on a plain amqplib channel and treated
`channel.publish()` returning without throwing as "sent," then committed
`published_at`. That reasoning has a real hole: a plain channel's
`publish()` returns once the frame is written to the local TCP buffer —
it does not mean the broker has the message. A dropped connection
between that write and the broker actually processing the frame loses
the event with no trace, even though `channel.publish()` "succeeded."
That's exactly the failure the outbox pattern exists to prevent
("the process can die between commit and publish, and the event is
lost forever with no trace") — a confirm-less relay just moves the same
hole one layer up, from "commit vs. publish" to "publish() returns vs.
broker actually has it." Fixed: `platform/broker/connection.ts`'s
publisher channel is `connection.createConfirmChannel()`, and
`platform/outbox/relay.ts` `await`s `channel.waitForConfirms()` after
publishing a batch, before marking `published_at`. Caught by a
Plan-agent review before this was built the confirm-less way, not
after.

## 2026-08-13 — Notify's queue/binding must exist before the relay's first tick

A topic exchange with no bound queue silently drops anything published
to it — and a confirm channel's ack only means "the broker accepted
it," not "a queue durably has it," so the confirms fix above doesn't
catch this. If `startRelay` and `modules/notify`'s queue declaration
were two independently-timed things (which is how every other
background worker in this project is wired in `server.ts` — no
ordering between them), the very first events published before
`notify` has run `assertQueue`/`bindQueue` would be lost forever,
`published_at = true` and all. Fixed by making topology setup an
explicit, awaited step in `server.ts` (and in `outbox-notify.test.ts`'s
`beforeAll`) that happens *before* `startRelay` is called, not something
left to `notify`'s own poll tick to establish on its own schedule.

## 2026-08-13 — Outbox insert in `fulfillPaidReservation` is guarded, not unconditional

`fulfillPaidReservation` is explicitly designed to be safely re-entered
after a partial failure — ticket issuance is `ON CONFLICT DO NOTHING`,
seat-sold and the `PAID`→`FULFILLED` flip are both conditional updates.
An outbox insert isn't naturally idempotent the same way, so it's
gated on `tryMarkFulfilled`'s actual return value
(`if (fulfilled) { await insertOutboxEvent(...) }`), not run
unconditionally after the call. Same shape as the M4 savepoint bug and
the M2/M3 `EvalPlanQual` bug already in this file: bolting a new,
non-idempotent side effect onto an existing idempotent primitive
without re-deriving the guard. Caught in design review this time, not
by a failing test — worth noting the pattern is recurring enough now to
watch for deliberately on every new side effect added to an
already-idempotent function.

## 2026-08-13 — Ordering holds because of one queue and sequential draining, not routing keys

The spec says "partition/route by `aggregate_id` so per-reservation
ordering holds." At M5's scale (one event type, one consumer, no
consistent-hash-exchange plugin installed) nothing here actually
partitions by `aggregate_id` — the relay's topic exchange routes by
`event_type`. Per-reservation ordering holds for a boring reason that
has nothing to do with the routing key: the relay claims and publishes
rows in `created_at` order inside one transaction, there's exactly one
queue (`notify.email`), and one consumer drains it sequentially
(`get` → `ack` → next, no prefetch/pipelining, no competing consumers).
Worth being precise about this rather than claiming the routing key
delivers ordering — it doesn't, and a second consumer or a
competing-consumers setup in a later milestone would break that claim
immediately if it were ever relied on.

## 2026-08-13 — RabbitMQ connection needs its own retry, not just `depends_on: service_healthy`

First `docker compose up` from a clean volume failed at boot with
`ECONNREFUSED` on port 5672, despite `depends_on: rabbitmq: condition:
service_healthy` already being satisfied. RabbitMQ's healthcheck
(`rabbitmq-diagnostics -q ping`) checks the Erlang node's
responsiveness, which can go green a moment before the AMQP listener
itself is actually accepting connections — a real startup race, not a
hypothetical one. Fixed with a small connect-with-retry loop in
`platform/broker/connection.ts` (10 attempts, 1s apart) rather than
tightening the healthcheck further; the same fix also makes local dev
(`npm run dev` against a `docker compose up`'d Postgres/RabbitMQ that's
still warming up) more forgiving.

## 2026-08-13 — Crash-recovery test spawns a real child process

The acceptance bar is unusually specific: "killing the app between
commit and publish (a deliberate `process.exit` in a test hook) still
delivers the email after restart." Read literally rather than loosely
— matching how this project already treats other specifically-worded
spec details (e.g. the M3 payment backoff schedule) as deliberate, not
incidental. A same-process version ("just don't call `runRelayOnce`
yet, call it later") can't distinguish "the process actually died" from
"the code path was simply never reached," which is a materially weaker
claim, and Postgres commit durability is already assumed everywhere
else in this suite — this is the one milestone whose entire point is
proving a process really can die and the data survives.
`apps/api/test/fixtures/crash-before-publish.ts` runs the real
fulfillment flow (event → reservation → paid → fulfilled, via direct
module calls, no HTTP) against `DATABASE_URL` from the environment,
then calls `process.exit(1)` immediately — never touching the relay or
RabbitMQ. The parent test spawns it with `spawnSync(process.execPath,
["--import", "tsx/esm", scriptPath], {...})` (no shell, no `.bin` shim,
identical behavior on Windows/Linux/CI), asserts the exit code, then
recovers via a fresh `runRelayOnce` in the parent process. The fixture
writes its sentinel line with `fs.writeSync(1, ...)`, not
`console.log` — stdout to a pipe is non-blocking on Windows, so a
`console.log` immediately followed by `process.exit()` can truncate
before the parent ever sees it.

## 2026-08-13 — Retry delay is per-message `expiration`, not queue-level `x-message-ttl`

First draft gave each of the 5 retry-tier queues a fixed `x-message-ttl`
argument matching its backoff step. That's structurally incompatible
with the spec's own requirement of jitter *and* with
`ensureNotifyQueue` needing to stay safe to call on every process
restart: `assertQueue` throws `PRECONDITION_FAILED` if a queue already
exists with different `arguments` than last time, so a queue-level TTL
can never vary per-process-start, let alone per-message — jitter simply
cannot be expressed that way. Caught by a Plan-agent review before this
was built the fixed-TTL way, not after.

Fixed: the retry queues carry only their dead-letter routing
(`x-dead-letter-exchange`/`-routing-key`, fixed forever, safe to
redeclare identically on every restart); the actual delay is set per
message via the `expiration` property at publish time
(`modules/notify/src/consumer.ts`), jittered there
(`topology.ts`'s `withJitter`, ±20%). This reopens a narrower version
of the exact hazard fixed-TTL-per-tier was chosen to avoid in the first
place (a queue only expires messages at its head, so a shorter-TTL
message queued behind a longer-TTL one waits) — but now bounded to
±20% of one tier's own delay, not the ~16x skew a single shared queue
across all five tiers would have risked. Worth the tradeoff; the spec
asks for both backoff *and* jitter, and this is the only design here
that delivers both without breaking restart-safety.

## 2026-08-13 — Republishing to a retry tier must spread the original headers

A first draft's republish set `headers: {"x-retry-count": attempt}` —
overwriting, not extending, `msg.properties.headers`. A republish is a
brand-new AMQP publish, not a dead-letter event; nothing carries
forward automatically, so this would have silently discarded any
`x-death` history RabbitMQ had already attached from earlier retry-tier
hops (real, broker-populated redelivery metadata, not something this
codebase constructs — useful for debugging exactly how a message got to
the DLQ). Fixed to `headers: { ...msg.properties.headers, "x-retry-count": nextRetryCount }`.
The DLQ's `broker_headers` column captures whatever accumulated by the
time a message actually lands there.

## 2026-08-13 — "Max 5 attempts" read as 5 retries (6 total), all 5 backoff tiers used

The spec lists exactly 5 backoff delays (1s/2s/4s/8s/16s) and says "max
5 attempts." Genuinely ambiguous between "5 total attempts" (would
leave the 16s tier permanently unused — the 5 delays would only be
needed to reach attempt 5 if 4 of them are consumed, not 5) and "5
retries after the original" (6 total deliveries, all 5 tiers used
exactly once each). Took the second reading — it's the one where every
listed backoff number does something, and it's what
`modules/notify/src/consumer.ts` implements: a message that fails on
attempt 6 (the original plus all 5 retries exhausted) lands in the DLQ
with `attempt_count = 6`. `apps/api/test/notify-retry-dlq.test.ts`
asserts this exact number rather than a loose bound, specifically so
the ambiguity can't silently regress to a different reading later.

## 2026-08-13 — DLQ storage is Postgres, not a RabbitMQ queue

`GET /admin/dlq`/`replay`/`discard` need per-entry list/filter/replay/
discard with a permanent audit trail — awkward to build against
RabbitMQ's own management HTTP API, which isn't meant for this kind of
per-message business operation. Every other durable, queryable piece of
state in this project already lives in Postgres with RabbitMQ purely as
transport (the outbox itself is the precedent); `dlq.entries` keeps
that boundary consistent instead of introducing a second source of
truth. A partial unique index on `(message_id, consumer)` scoped to
unresolved rows absorbs the one real duplicate-row risk in this design:
if the process crashes between inserting the DLQ row and acking the
original delivery, RabbitMQ redelivers the un-acked message and the
consumer would otherwise insert a second row for the same failure —
`ON CONFLICT ... DO NOTHING` makes that a no-op. Once an entry is
replayed or discarded, a later failure of the same message id is a new
failure episode and correctly gets a fresh row (the index only covers
unresolved entries).

## 2026-08-13 — Terminal classification is centralized, not just "catch JSON.parse"

The spec's terminal list is "malformed payload, unknown event type,
**validation failure**" — three cases, not two. A first draft only
special-cased bad JSON and an unrecognized `eventType`; a
syntactically-valid envelope with a wrong-shaped `payload` (e.g.
`amountCents` as a string) would have thrown a plain `TypeError` deep
inside the mailer, been classified retriable by default, and burned all
5 retries before landing in the DLQ — the exact "unknown terminal case
masquerading as transient" risk the spec calls out as "the most common
real-world DLQ bug." Caught by a Plan-agent review, not by a failing
test. Fixed by centralizing all three checks in one place
(`modules/notify/src/classify.ts`'s `parseNotifyEvent`) — the single
spot a reviewer checks for "did they get the retriable/terminal split
right" — and using payload-shape validation (not just malformed bytes)
as the more realistic `email.malformed_payload`-style scenario in
`apps/api/test/notify-retry-dlq.test.ts`.

## 2026-08-13 — Simulating transient failures via dependency injection, not a payload flag

`runNotifyConsumeOnce` takes an optional `handleEvent` override (default:
the real `writeEmailFile`) rather than tests embedding a
"fail N times then succeed" flag inside the outbox event's payload. A
payload flag is frozen once the message is published — a test proving
"DLQ due to genuine exhaustion, then the underlying issue gets fixed,
then replay succeeds" needs the *replayed* delivery to behave
differently from the original, which a byte-identical payload can't
express. Modeling the fault as external, mutable test state (a closure
counter) instead is also the more honest simulation: a real transient
failure is a property of the environment at the time ("some downstream
dependency was down and came back"), not of the message itself.
Production code never passes this option — the default argument is the
real behavior, zero footprint outside tests.

## 2026-08-13 — `buildApp`'s `publisherChannel` is optional

`POST /admin/dlq/:id/replay` needs a channel to requeue onto, but making
one a required `buildApp` parameter would force all 9 other test files
(none of which touch RabbitMQ) to each pay for a broker Testcontainer
they never use. `BuildAppOptions.publisherChannel` is optional; the
replay route 503s if it's missing rather than the route being
conditionally registered — keeps route registration static and
identical across environments, only the runtime dependency is
optional. Same reasoning extends `waitForConfirms()` to the replay path
(publish → confirm → only then mark `replayed_at`) — skipping it would
risk marking an entry replayed that the broker never actually received,
and unlike the outbox, a DLQ entry has no fallback layer behind it if
that silently goes wrong.
