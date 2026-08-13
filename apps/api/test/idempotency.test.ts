import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { buildApp } from "../src/app.js";
import { runMigrations } from "../../../platform/migrate/run.js";
import { hashRequestBody } from "../../../platform/idem/hash.js";
import { markMessageProcessed } from "../../../platform/idem/repository.js";
import { runIdemSweepOnce } from "../../../platform/idem/sweeper.js";
import { withTransaction } from "../../../platform/db/withTransaction.js";

describe("idempotency", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    await runMigrations(container.getConnectionUri());
    // 10 concurrent test needs genuine concurrency at the DB level, same
    // gotcha as M2's race test.
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 15 });
    app = buildApp({ pool });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await container.stop();
  });

  async function createEvent(capacity = 10): Promise<string> {
    const now = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/admin/events",
      payload: {
        name: "Idempotency Test Show",
        venue: "Test Hall",
        startsAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
        saleStartsAt: new Date(now - 60 * 60 * 1000).toISOString(),
        saleEndsAt: new Date(now + 60 * 60 * 1000).toISOString(),
        capacity,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  function reserve(eventId: string, seatCount: number, idempotencyKey: string, customerId = "cust-1") {
    return app.inject({
      method: "POST",
      url: "/reservations",
      headers: { "x-customer-id": customerId, "idempotency-key": idempotencyKey },
      payload: { eventId, seatCount },
    });
  }

  it("rejects a missing Idempotency-Key on POST /payments/:id/confirm", async () => {
    const eventId = await createEvent();
    const created = await reserve(eventId, 1, randomUUID());
    const paymentId = created.json().paymentId;

    const res = await app.inject({ method: "POST", url: `/payments/${paymentId}/confirm` });
    expect(res.statusCode).toBe(400);
  });

  it("replays the exact first response for a repeated key+body, with no new reservation", async () => {
    const eventId = await createEvent();
    const key = randomUUID();

    const first = await reserve(eventId, 2, key);
    expect(first.statusCode).toBe(201);

    const second = await reserve(eventId, 2, key);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());

    const { rows } = await pool.query(
      "SELECT count(*)::int AS count FROM ordering.reservations WHERE event_id = $1",
      [eventId],
    );
    expect(rows[0].count).toBe(1);

    const { rows: idemRows } = await pool.query(
      "SELECT status FROM idem.idempotency_keys WHERE key = $1 AND endpoint = 'POST /reservations'",
      [key],
    );
    expect(idemRows).toHaveLength(1);
    expect(idemRows[0].status).toBe("COMPLETED");
  });

  it("replays a cached business-error response too (409 seats unavailable)", async () => {
    const eventId = await createEvent(1);
    const key = randomUUID();

    const first = await reserve(eventId, 5, key);
    expect(first.statusCode).toBe(409);

    const second = await reserve(eventId, 5, key);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual(first.json());

    const { rows } = await pool.query(
      "SELECT count(*)::int AS count FROM inventory.seats WHERE event_id = $1 AND status = 'HELD'",
      [eventId],
    );
    expect(rows[0].count).toBe(0);
  });

  it("rejects the same key reused with a different request body", async () => {
    const eventId = await createEvent();
    const key = randomUUID();

    const first = await reserve(eventId, 1, key);
    expect(first.statusCode).toBe(201);

    const second = await reserve(eventId, 2, key);
    expect(second.statusCode).toBe(422);
  });

  it("returns 409 Retry-Later for a concurrent duplicate while the first attempt is still PENDING", async () => {
    const eventId = await createEvent();
    const key = randomUUID();
    const requestBody = { eventId, seatCount: 1, customerId: "cust-1" };

    // Simulate "another request for this key is already in flight" directly,
    // rather than racing real timing — deterministic and exercises the same
    // lookup path a genuine concurrent request would hit.
    await pool.query(
      `INSERT INTO idem.idempotency_keys (key, endpoint, request_hash, status, expires_at)
       VALUES ($1, 'POST /reservations', $2, 'PENDING', now() + interval '24 hours')`,
      [key, hashRequestBody(requestBody)],
    );

    const res = await reserve(eventId, 1, key);
    expect(res.statusCode).toBe(409);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS count FROM ordering.reservations WHERE event_id = $1",
      [eventId],
    );
    expect(rows[0].count).toBe(0);
  });

  it("10 concurrent requests with the same key converge to one reservation and identical responses", async () => {
    const eventId = await createEvent();
    const key = randomUUID();

    async function attemptUntilTerminal(): Promise<{ statusCode: number; body: unknown }> {
      for (let i = 0; i < 50; i++) {
        const res = await reserve(eventId, 1, key);
        if (res.statusCode !== 409 || i === 49) {
          return { statusCode: res.statusCode, body: res.json() };
        }
        // Only retry on the "still processing" 409 — check the body isn't
        // e.g. a seat-conflict 409 masquerading as the same status.
        if (!/Idempotency-Key/i.test(res.json().error ?? "")) {
          return { statusCode: res.statusCode, body: res.json() };
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("never reached a terminal response");
    }

    const results = await Promise.all(Array.from({ length: 10 }, () => attemptUntilTerminal()));

    expect(results).toHaveLength(10);
    for (const result of results) {
      expect(result.statusCode).toBe(results[0].statusCode);
      expect(result.body).toEqual(results[0].body);
    }
    expect(results[0].statusCode).toBe(201);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS count FROM ordering.reservations WHERE event_id = $1",
      [eventId],
    );
    expect(rows[0].count).toBe(1);

    const { rows: idemRows } = await pool.query(
      "SELECT count(*)::int AS count FROM idem.idempotency_keys WHERE key = $1 AND endpoint = 'POST /reservations' AND status = 'COMPLETED'",
      [key],
    );
    expect(idemRows[0].count).toBe(1);
  });

  it("scopes the confirm endpoint's idempotency identity by payment id, not just the key", async () => {
    const eventId = await createEvent();
    const a = (await reserve(eventId, 1, randomUUID())).json();
    const b = (await reserve(eventId, 1, randomUUID())).json();

    const sharedKey = randomUUID();
    const confirmA = await app.inject({
      method: "POST",
      url: `/payments/${a.paymentId}/confirm`,
      headers: { "idempotency-key": sharedKey },
    });
    const confirmB = await app.inject({
      method: "POST",
      url: `/payments/${b.paymentId}/confirm`,
      headers: { "idempotency-key": sharedKey },
    });

    expect(confirmA.statusCode).toBe(200);
    expect(confirmB.statusCode).toBe(200);
    expect(confirmA.json().id).not.toBe(confirmB.json().id);
  });

  it("processed_messages: markMessageProcessed dedupes within the same transaction as a side effect", async () => {
    const messageId = randomUUID();
    const consumer = "test-consumer";
    let sideEffectRuns = 0;

    async function handleMessage(): Promise<void> {
      await withTransaction(pool, async (client) => {
        const firstTime = await markMessageProcessed(client, { messageId, consumer });
        if (!firstTime) return; // already handled — ack and move on, no side effect
        sideEffectRuns++;
      });
    }

    await handleMessage();
    await handleMessage(); // redelivery of the same message

    expect(sideEffectRuns).toBe(1);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS count FROM idem.processed_messages WHERE message_id = $1 AND consumer = $2",
      [messageId, consumer],
    );
    expect(rows[0].count).toBe(1);
  });

  it("processed_messages: same message id under a different consumer is independent", async () => {
    const messageId = randomUUID();

    const wonA = await withTransaction(pool, (client) => markMessageProcessed(client, { messageId, consumer: "consumer-a" }));
    const wonB = await withTransaction(pool, (client) => markMessageProcessed(client, { messageId, consumer: "consumer-b" }));

    expect(wonA).toBe(true);
    expect(wonB).toBe(true);
  });

  it("sweeps expired idempotency keys but leaves live ones alone", async () => {
    const expiredKey = randomUUID();
    const liveKey = randomUUID();

    await pool.query(
      `INSERT INTO idem.idempotency_keys (key, endpoint, request_hash, status, expires_at)
       VALUES ($1, 'TEST', 'hash', 'COMPLETED', now() - interval '1 second')`,
      [expiredKey],
    );
    await pool.query(
      `INSERT INTO idem.idempotency_keys (key, endpoint, request_hash, status, expires_at)
       VALUES ($1, 'TEST', 'hash', 'COMPLETED', now() + interval '24 hours')`,
      [liveKey],
    );

    const swept = await runIdemSweepOnce(pool);
    expect(swept).toBeGreaterThanOrEqual(1);

    const { rows: expiredRows } = await pool.query(
      "SELECT count(*)::int AS count FROM idem.idempotency_keys WHERE key = $1",
      [expiredKey],
    );
    expect(expiredRows[0].count).toBe(0);

    const { rows: liveRows } = await pool.query(
      "SELECT count(*)::int AS count FROM idem.idempotency_keys WHERE key = $1",
      [liveKey],
    );
    expect(liveRows[0].count).toBe(1);
  });
});
