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
