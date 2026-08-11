import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { buildApp } from "../src/app.js";
import { runMigrations } from "../../../platform/migrate/run.js";
import { runSweepOnce } from "../../../modules/ordering/index.js";

describe("ordering: sweeper", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    app = buildApp({ pool });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await container.stop();
  });

  async function createEvent(capacity = 5): Promise<string> {
    const now = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/admin/events",
      payload: {
        name: "Rocket Launch",
        venue: "Cape Canaveral",
        startsAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
        saleStartsAt: new Date(now - 60 * 60 * 1000).toISOString(),
        saleEndsAt: new Date(now + 60 * 60 * 1000).toISOString(),
        capacity,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  async function reserve(eventId: string, seatCount: number): Promise<{ id: string; seatIds: string[] }> {
    const res = await app.inject({
      method: "POST",
      url: "/reservations",
      headers: { "x-customer-id": "cust-1" },
      payload: { eventId, seatCount },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  it("expires a due hold and releases its seats back to AVAILABLE", async () => {
    const eventId = await createEvent();
    const reservation = await reserve(eventId, 2);

    await pool.query(
      "UPDATE ordering.reservations SET held_until = now() - interval '1 second' WHERE id = $1",
      [reservation.id],
    );

    const expiredCount = await runSweepOnce(pool);
    expect(expiredCount).toBeGreaterThanOrEqual(1);

    const { rows: reservationRows } = await pool.query(
      "SELECT state FROM ordering.reservations WHERE id = $1",
      [reservation.id],
    );
    expect(reservationRows[0].state).toBe("EXPIRED");

    const { rows: seatRows } = await pool.query(
      "SELECT status, hold_id, held_until FROM inventory.seats WHERE id = ANY($1)",
      [reservation.seatIds],
    );
    expect(seatRows).toHaveLength(2);
    for (const row of seatRows) {
      expect(row.status).toBe("AVAILABLE");
      expect(row.hold_id).toBeNull();
      expect(row.held_until).toBeNull();
    }
  });

  it("leaves a still-valid hold untouched", async () => {
    const eventId = await createEvent();
    const reservation = await reserve(eventId, 1);

    await runSweepOnce(pool);

    const { rows: reservationRows } = await pool.query(
      "SELECT state FROM ordering.reservations WHERE id = $1",
      [reservation.id],
    );
    expect(reservationRows[0].state).toBe("AWAITING_PAYMENT");

    const { rows: seatRows } = await pool.query(
      "SELECT status, hold_id FROM inventory.seats WHERE id = ANY($1)",
      [reservation.seatIds],
    );
    for (const row of seatRows) {
      expect(row.status).toBe("HELD");
      expect(row.hold_id).toBe(reservation.id);
    }
  });
});
