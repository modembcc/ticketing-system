import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { buildApp } from "../src/app.js";
import { runMigrations } from "../../../platform/migrate/run.js";

describe("ordering: reservations", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    await runMigrations(container.getConnectionUri());
    // max:50 so the concurrency test below actually races 50-way at the
    // database level instead of serializing into waves under the pg default of 10.
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 50 });
    app = buildApp({ pool });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await container.stop();
  });

  function openEventPayload(overrides: Record<string, unknown> = {}) {
    const now = Date.now();
    return {
      name: "Rocket Launch",
      venue: "Cape Canaveral",
      startsAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      saleStartsAt: new Date(now - 60 * 60 * 1000).toISOString(),
      saleEndsAt: new Date(now + 60 * 60 * 1000).toISOString(),
      capacity: 10,
      ...overrides,
    };
  }

  async function createEvent(overrides: Record<string, unknown> = {}): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/admin/events",
      payload: openEventPayload(overrides),
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  function reserve(eventId: string, seatCount: number, customerId = "cust-1") {
    return app.inject({
      method: "POST",
      url: "/reservations",
      headers: { "x-customer-id": customerId },
      payload: { eventId, seatCount },
    });
  }

  it("holds the requested number of seats and flips them to HELD with this reservation as hold_id", async () => {
    const eventId = await createEvent({ capacity: 5 });

    const res = await reserve(eventId, 2);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.seatIds).toHaveLength(2);
    expect(body.state).toBe("AWAITING_PAYMENT");

    const heldUntil = new Date(body.heldUntil).getTime();
    const expected = Date.now() + 5 * 60 * 1000;
    expect(Math.abs(heldUntil - expected)).toBeLessThan(10_000);

    const { rows: held } = await pool.query(
      "SELECT status, hold_id, held_until FROM inventory.seats WHERE id = ANY($1)",
      [body.seatIds],
    );
    expect(held).toHaveLength(2);
    for (const row of held) {
      expect(row.status).toBe("HELD");
      expect(row.hold_id).toBe(body.id);
    }

    const { rows: available } = await pool.query(
      "SELECT count(*)::int AS count FROM inventory.seats WHERE event_id = $1 AND status = 'AVAILABLE'",
      [eventId],
    );
    expect(available[0].count).toBe(3);
  });

  it("rejects a missing X-Customer-Id header", async () => {
    const eventId = await createEvent();
    const res = await app.inject({
      method: "POST",
      url: "/reservations",
      payload: { eventId, seatCount: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a malformed eventId", async () => {
    const res = await reserve("not-a-uuid", 1);
    expect(res.statusCode).toBe(400);
  });

  it.each([0, -1, 1.5])("rejects a non-positive-integer seatCount (%s)", async (seatCount) => {
    const eventId = await createEvent();
    const res = await reserve(eventId, seatCount);
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for an unknown event", async () => {
    const res = await reserve("00000000-0000-0000-0000-000000000000", 1);
    expect(res.statusCode).toBe(404);
  });

  it("returns 422 when the sale window has not started yet", async () => {
    const now = Date.now();
    const eventId = await createEvent({
      saleStartsAt: new Date(now + 60 * 60 * 1000).toISOString(),
      saleEndsAt: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
    });
    const res = await reserve(eventId, 1);
    expect(res.statusCode).toBe(422);
    expect(res.json().reason).toBe("BEFORE_SALE_START");
  });

  it("returns 422 when the sale window has already closed", async () => {
    const now = Date.now();
    const eventId = await createEvent({
      saleStartsAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      saleEndsAt: new Date(now - 60 * 60 * 1000).toISOString(),
    });
    const res = await reserve(eventId, 1);
    expect(res.statusCode).toBe(422);
    expect(res.json().reason).toBe("AFTER_SALE_END");
  });

  it("returns 409 when requesting more seats than the event has", async () => {
    const eventId = await createEvent({ capacity: 2 });
    const res = await reserve(eventId, 5);
    expect(res.statusCode).toBe(409);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS count FROM inventory.seats WHERE event_id = $1 AND status = 'HELD'",
      [eventId],
    );
    expect(rows[0].count).toBe(0);
  });

  it("50 concurrent requests for 10 seats yield exactly 10 holds and 40 clean 409s", async () => {
    const eventId = await createEvent({ capacity: 10 });

    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) => reserve(eventId, 1, `cust-${i}`)),
    );

    const statuses = responses.map((r) => r.statusCode);
    for (const status of statuses) {
      expect([201, 409]).toContain(status);
    }
    expect(statuses.filter((s) => s === 201).length).toBe(10);
    expect(statuses.filter((s) => s === 409).length).toBe(40);

    const { rows: byStatus } = await pool.query(
      `SELECT status, count(*)::int AS count FROM inventory.seats WHERE event_id = $1 GROUP BY status`,
      [eventId],
    );
    expect(byStatus).toEqual([{ status: "HELD", count: 10 }]);

    const { rows: reservations } = await pool.query(
      "SELECT count(*)::int AS count FROM ordering.reservations WHERE event_id = $1",
      [eventId],
    );
    expect(reservations[0].count).toBe(10);
  });
});
