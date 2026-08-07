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

## Status

**M0 — Scaffold: done.** Compose stack, migration runner, health
endpoints, one Testcontainers integration test. No domain modules yet —
those start at M1.
