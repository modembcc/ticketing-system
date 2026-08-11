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
