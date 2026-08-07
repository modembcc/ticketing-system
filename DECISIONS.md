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
