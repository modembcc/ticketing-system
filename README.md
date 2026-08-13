# Ticketing Saga Lab

An event ticketing system built as a hands-on lab for distributed
transaction patterns: sagas with compensating actions, idempotency keys,
transactional outbox, retries with backoff, and dead-letter queues with
replay. See `DECISIONS.md` for the reasoning behind non-obvious choices.

## Stack

- TypeScript (Node 22) + Fastify
- PostgreSQL 16, plain SQL migrations (no ORM)
- RabbitMQ (management plugin)
- Vitest + Testcontainers for integration tests

## Running it

```
docker compose up
```

That's the only setup step. It builds the API image, starts Postgres and
RabbitMQ, waits for both to report healthy, then starts the API, which
runs pending migrations on boot.

- API: http://localhost:3000
- RabbitMQ management UI: http://localhost:15672 (guest/guest)
- Postgres: localhost:5432 (ticketing/ticketing)
- Mail: `./mail/*.eml` on the host (bind-mounted — no real SMTP, see
  "Outbox + notify" below)

Health checks:

```
curl http://localhost:3000/health/live   # process is up
curl http://localhost:3000/health/ready  # process + DB reachable
```

## Development

```
npm install
cp .env.example .env   # then point DATABASE_URL at a local Postgres
npm run migrate         # apply pending migrations
npm run dev              # watch mode
```

## Tests

```
npm test
```

Integration tests use Testcontainers, which needs a running Docker
daemon — they spin up a real disposable Postgres per run rather than
mocking the database.

## Migrations

Plain numbered `.sql` files in `/migrations`, applied in order by
`platform/migrate/run.ts`. Applied versions are tracked in a
`schema_migrations` table the runner creates on first run. Add a new
migration by creating the next-numbered file; nothing else to register.

## API

Admin:

- `POST /admin/events` — create an event; generates one seat row per
  `capacity` slot in the same transaction
- `GET /admin/events` — list events, each with `availableSeats`
- `GET /admin/events/:id` — fetch one event

Customer:

- `GET /events` — list events, each with `availableSeats`
- `POST /reservations` — hold N seats for 5 minutes (requires
  `X-Customer-Id` **and** `Idempotency-Key` headers). Body:
  `{ "eventId": "...", "seatCount": 2 }`. Seats are auto-assigned, not
  chosen by the customer. Response includes `paymentId`/`amountCents` (a
  flat placeholder price — see `DECISIONS.md`). `404` unknown event,
  `422` sale window not open, `409` not enough seats available (or a
  concurrent request with the same key still processing), `400` bad
  input or missing `Idempotency-Key`.
- `POST /payments/:id/confirm` — customer submits payment (requires
  `Idempotency-Key`); starts the fake gateway's async processing.
  Confirming twice with the same key replays the cached response;
  confirming twice with different keys is still a no-op at the payment
  level either way. `404` unknown payment, `409` reservation no longer
  awaiting payment (already expired/settled).
- `GET /payments/:id` — fetch one payment. No idempotency key needed —
  it's a read.

Admin (DLQ, M6):

- `GET /admin/dlq` — list unresolved dead-lettered messages, with
  `failureReason` and `attemptCount`
- `POST /admin/dlq/:id/replay` — requeue to the source queue with a
  fresh attempt budget; `404` if not found/already resolved, `503` if
  the broker is unavailable
- `POST /admin/dlq/:id/discard` — requires `{ "reason": "..." }`;
  `400` without one. The row is never deleted — it's the audit log.

### Idempotency-Key

Required on the two mutating customer endpoints above. Same key + same
request body → the first response is cached and replayed verbatim on
every retry, no matter how many times or what it was (success *or* a
business error like `409`/`422` — see `DECISIONS.md` for why errors are
cached too). Same key + a *different* body → `422`. A concurrent retry
that arrives while the first attempt is still running → `409`
("retry shortly", not a cached response). Keys expire after 24h and are
swept (`platform/idem`, `IDEM_SWEEP_INTERVAL_MS`, default 60000).

```
curl -X POST http://localhost:3000/reservations \
  -H "X-Customer-Id: cust-1" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"eventId":"...","seatCount":2}'
```

`POST /admin/events` body:

```json
{
  "name": "Rocket Launch",
  "venue": "Cape Canaveral",
  "startsAt": "2026-02-01T00:00:00.000Z",
  "saleStartsAt": "2026-01-01T00:00:00.000Z",
  "saleEndsAt": "2026-01-08T00:00:00.000Z",
  "capacity": 500
}
```

## Modules

`modules/catalog`, `modules/inventory`, `modules/ordering`, and
`modules/payments` each own a Postgres schema (`catalog.*`, `inventory.*`,
`ordering.*`, `payments.*`) and expose a public interface via their
`index.ts`. Code outside a module only imports from that `index.ts` —
never a module's internal `src/*` files, and never another module's
tables directly. See `DECISIONS.md` for how event + seat creation stays
atomic across modules without becoming a saga, the retry-loop design
behind seat holding under contention, and the M3 saga's pivot/fulfillment
split.

## The saga (M3)

`POST /reservations` holds seats **and** opens a payment intent in one
transaction (compensatable steps 1+2 — a failure at either rolls both
back). The customer then `POST /payments/:id/confirm`s, which starts the
fake gateway's async processing. From there, two independent background
workers drive the saga to a terminal state:

- **Gateway simulator** (`modules/payments`, `GATEWAY_TICK_INTERVAL_MS`,
  default 1000) — stands in for an external processor; resolves confirmed
  intents to `SUCCEEDED` after a short fake delay. Declines are simulated
  directly in tests (`UPDATE payments.payments SET status='FAILED'`), not
  via a toggle — chaos modes are M7.
- **Payment poller** (`modules/ordering`, `PAYMENT_POLL_INTERVAL_MS`,
  default 500) — polls each pending payment on a 1s/2s/3s/5s… backoff
  (capped at the reservation's `held_until`), then drives the pivot:
  `PAID → FULFILLED` (tickets issued, seats `SOLD`) on success, `FAILED`
  (seats released) on decline. A payment that succeeds *after* the hold
  already expired is routed to `REFUNDING → REFUNDED` instead of
  reclaiming the seat — the "late payment" race, and the most
  instructive path in the project.

Both workers are started in `apps/api/src/server.ts`, not inside
`buildApp` — tests call `runGatewayTickOnce`/`runPaymentPollOnce`/
`runSweepOnce` directly instead of waiting on real timers, same pattern
as the M2 sweeper.

## Sweeper

A background sweeper (`modules/ordering/src/sweeper.ts`) runs every
`SWEEP_INTERVAL_MS` (default 5000) and expires reservations whose hold has
passed, releasing their seats back to `AVAILABLE`. Its conditional update
duplicates its guard into the outer `WHERE` (not just an inner subquery)
so it can't clobber a reservation that a concurrent payment pivot just
won — see `DECISIONS.md` for the bug this fixes.

## Idempotency (M4)

`platform/idem` is cross-cutting infra, not a fifth business module — it
sits flat (no `src/`, no barrel `index.ts`) matching `platform/db`'s
shape, imported by direct path. `withIdempotency(pool, {key, endpoint,
requestBody}, handler)` owns one transaction: insert the key row as
`PENDING`, run `handler`, record its result as `COMPLETED` — all commit
or roll back together. `handler` is expected to catch its own domain
errors and return `{status, body}` rather than throwing, so business
errors get cached and replayed like any other outcome; a genuinely
unexpected exception is left to propagate, rolling everything back so a
retry after an infra failure isn't permanently poisoned.

Because of that same-transaction requirement, `createReservation` and
`confirmReservationPayment` (`modules/ordering`) take an already-open
`PoolClient` instead of a `Pool` — `withIdempotency` is what opens the
transaction now. Each route wraps its call to them in
`withSavepoint` (`platform/db/withSavepoint.ts`) so a business error
thrown *after* partial writes (e.g. `SeatsUnavailableError` once some
seats are already held) rolls back just that work, not the idempotency
bookkeeping around it — see `DECISIONS.md` for the bug this fixes and
why it only showed up after this refactor.

`processed_messages` (the consumer-side equivalent, `idem` schema) is
built and tested at the repository level
(`markMessageProcessed`) — there's no real message consumer to exercise
it against yet; that's M5.

## Outbox + notify (M5)

RabbitMQ has been running since M0 but M5 is the first milestone that
actually publishes or consumes a message. `platform/broker` (flat, same
shape as `platform/idem`) is a thin `amqplib` connection helper shared
by the publisher and consumer sides — one topic exchange
(`domain-events`), routing key = event type. `platform/outbox` owns
`outbox.events` (`id, aggregate_type, aggregate_id, event_type, payload,
created_at, published_at`, no FK on `aggregate_id` — it's deliberately
polymorphic, see `DECISIONS.md`) and the relay:

- **Relay** (`platform/outbox/relay.ts`, `RELAY_INTERVAL_MS`, default
  200) — one transaction per tick: `FOR UPDATE SKIP LOCKED` claims up
  to 100 unpublished rows in `created_at` order, publishes each on a
  **confirm channel**, `await`s `waitForConfirms()`, then marks
  `published_at` — all before committing. A plain (non-confirm) channel
  publish only means "written to the local TCP buffer," not "the
  broker has it"; without confirms, a dropped connection right after
  publish would mark a message published that the broker never
  actually received — the exact failure the outbox pattern exists to
  prevent, just moved one layer up. See `DECISIONS.md`.
- **`modules/notify`** — no Postgres schema of its own (its only
  persistent state is the shared `processed_messages` table). Declares
  and binds its own queue (`notify.email`) at startup — **before** the
  relay ever publishes, or the first events would be silently dropped
  by an exchange with nothing bound to it yet (also in
  `DECISIONS.md`). `runNotifyConsumeOnce` polls with `channel.get`
  (bounded to 100 per tick) rather than a long-lived `channel.consume`
  subscription, matching this project's testable `runXOnce` convention
  everywhere else. Dedupes redelivered messages via
  `processed_messages` before writing a `.eml` file to `MAIL_DIR`
  (default `./mail`, bind-mounted in Compose) — no real SMTP, same
  fake-gateway philosophy as `modules/payments`.

Both are started in `server.ts` alongside the M2–M4 background workers,
with topology setup explicitly awaited first.

**Acceptance test** (`apps/api/test/outbox-notify.test.ts`): a real
child process (`apps/api/test/fixtures/crash-before-publish.ts`, spawned
via `spawnSync` with `--import tsx/esm`) runs the actual fulfillment
flow through to a committed outbox row, then calls `process.exit(1)`
before ever touching the relay or RabbitMQ. The parent test confirms
the event survived unpublished, then recovers it with a fresh relay
tick and confirms the email gets written — literally proving a process
can die between commit and publish without losing the event, not just
asserting Postgres durability in the abstract.

## Retries + DLQ (M6)

`modules/notify/src/classify.ts` is the one place that decides
retriable vs. terminal — malformed JSON, an unrecognized `eventType`,
or a payload that fails shape validation all throw `TerminalMessageError`
and skip straight to the DLQ; anything else is retried by default
(a wrongly-terminal call silently drops a real transient failure
forever, a wrongly-retriable one just burns retries before landing in
the DLQ anyway — asymmetric risk, so default the safer way).

Retries use 5 RabbitMQ queues (`notify.email.retry.1`…`5`, one per
backoff tier: 1s/2s/4s/8s/16s ± 20% jitter), each dead-lettering back to
`notify.email` on expiry — no community plugin required. The delay is
set **per message** via the `expiration` property at publish time, not
a fixed `x-message-ttl` on the queue, specifically so jitter is
possible without breaking `ensureNotifyQueue`'s idempotent redeclaration
on every restart (see `DECISIONS.md`). A message that fails on its 6th
delivery (the original + all 5 retries) lands in `dlq.entries`
(`platform/dlq`, own schema, no RabbitMQ-native DLQ — Postgres is the
durable, queryable, admin-operable store, RabbitMQ stays pure
transport) with the failure reason, exact attempt count, and whatever
`x-death` history RabbitMQ attached along the way.

Simulating "a downstream dependency is down and later recovers" (for
`email.fail_transient(2)`-style scenarios) uses dependency injection —
`runNotifyConsumeOnce`'s optional `handleEvent` override — rather than a
flag baked into the message payload, because a replayed message is
byte-identical to what's stored; a payload flag couldn't behave
differently between the original failing attempt and a successful
replay after the "fix." Production never passes this option.

## Status

**M0 — Scaffold: done.**

**M1 — Catalog + inventory: done.** Admin CRUD for events, seat rows
generated on create, customer event listing, sale-window check
(`isSaleWindowOpen`).

**M2 — Holds and expiry: done.** `POST /reservations` holds seats for 5
minutes via a retry-loop conditional UPDATE (see `DECISIONS.md`), a
sweeper releases expired holds. 50-concurrent-requests-for-10-seats race
test passes repeatably.

**M3 — The saga: done.** Fake payment gateway, polling orchestrator,
`PAID → FULFILLED` with tickets issued and seats `SOLD`, compensation on
failure (`FAILED`) and on expiry (`EXPIRED`), and the late-payment refund
path (`REFUNDING → REFUNDED`). Sweeper-vs-payment race test passes
reliably across repeated 100-run executions.

**M4 — Idempotency: done.** `Idempotency-Key` required on
`POST /reservations` and `POST /payments/:id/confirm`; same key+body
replays verbatim (success or business error alike), a different body
under the same key is `422`, a concurrent duplicate mid-flight is `409`.
10-concurrent-identical-requests test converges to one reservation and
ten identical responses. `processed_messages` built and tested for M5's
consumers to use.

**M5 — Outbox + notifications: done.** RabbitMQ actually wired up for
the first time — a relay publishes outbox rows on a confirm channel,
`modules/notify` consumes and writes `.eml` files, deduped via
`processed_messages`. A real child process spawned mid-test and
`process.exit(1)`'d between commit and publish proves the event
survives and still gets delivered after "restart."

**M6 — Retries + DLQ: done.** Exponential backoff with jitter via 5
RabbitMQ delayed-retry queues, explicit terminal-vs-retriable
classification, a Postgres-backed DLQ with admin list/replay/discard.
A poison message (malformed JSON or an invalid payload shape) lands in
the DLQ on the first attempt with no retries burned; a transient
failure recovers on attempt 3; a permanent failure exhausts all 5
retries (6 total attempts) without ever touching the already-fulfilled
reservation's state; replay requeues with a fresh attempt budget and
succeeds once the underlying issue is fixed. Next: M7 — chaos +
scenario suite.
