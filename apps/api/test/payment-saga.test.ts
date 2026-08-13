import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { buildApp } from "../src/app.js";
import { runMigrations } from "../../../platform/migrate/run.js";
import { runPaymentPollOnce, runSweepOnce } from "../../../modules/ordering/index.js";
import { runGatewayTickOnce } from "../../../modules/payments/index.js";

describe("payment saga", () => {
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

  async function reserve(eventId: string, seatCount: number, customerId = "cust-1") {
    const res = await app.inject({
      method: "POST",
      url: "/reservations",
      headers: { "x-customer-id": customerId, "idempotency-key": randomUUID() },
      payload: { eventId, seatCount },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as {
      id: string;
      seatIds: string[];
      paymentId: string;
      amountCents: number;
      customerId: string;
    };
  }

  // Fresh key by default so calling confirm() twice in a row (as the
  // "idempotent no-op" test does explicitly) isn't the only path exercised —
  // callers that specifically want to test idempotent-replay pass the same
  // key twice themselves.
  async function confirm(paymentId: string, idempotencyKey = randomUUID()) {
    return app.inject({
      method: "POST",
      url: `/payments/${paymentId}/confirm`,
      headers: { "idempotency-key": idempotencyKey },
    });
  }

  async function backdatePaymentConfirmedAt(paymentId: string, msAgo: number) {
    await pool.query(
      `UPDATE payments.payments SET confirmed_at = now() - ($2 || ' milliseconds')::interval WHERE id = $1`,
      [paymentId, msAgo],
    );
  }

  it("happy path: confirm -> gateway resolves -> poller fulfills -> seats SOLD, tickets issued", async () => {
    const eventId = await createEvent();
    const reservation = await reserve(eventId, 2);

    const confirmRes = await confirm(reservation.paymentId);
    expect(confirmRes.statusCode).toBe(200);
    expect(confirmRes.json().state).toBe("AWAITING_PAYMENT");

    await backdatePaymentConfirmedAt(reservation.paymentId, 2000);
    const resolvedCount = await runGatewayTickOnce(pool);
    expect(resolvedCount).toBeGreaterThanOrEqual(1);

    const settledCount = await runPaymentPollOnce(pool);
    expect(settledCount).toBeGreaterThanOrEqual(1);

    const { rows: reservationRows } = await pool.query(
      "SELECT state FROM ordering.reservations WHERE id = $1",
      [reservation.id],
    );
    expect(reservationRows[0].state).toBe("FULFILLED");

    const { rows: seatRows } = await pool.query(
      "SELECT status FROM inventory.seats WHERE id = ANY($1)",
      [reservation.seatIds],
    );
    for (const row of seatRows) expect(row.status).toBe("SOLD");

    const { rows: ticketRows } = await pool.query(
      "SELECT seat_id, customer_id, qr_token FROM ordering.tickets WHERE reservation_id = $1",
      [reservation.id],
    );
    expect(ticketRows).toHaveLength(2);
    for (const row of ticketRows) {
      expect(row.customer_id).toBe(reservation.customerId);
      expect(row.qr_token).toBeTruthy();
    }

    const { rows: paymentRows } = await pool.query(
      "SELECT status FROM payments.payments WHERE id = $1",
      [reservation.paymentId],
    );
    expect(paymentRows[0].status).toBe("SUCCEEDED");
  });

  it("failed payment: poller releases seats, no tickets issued", async () => {
    const eventId = await createEvent();
    const reservation = await reserve(eventId, 1);
    await confirm(reservation.paymentId);

    // Decline is simulated directly (no chaos-toggle machinery yet, same as
    // M2 simulating expiry by back-dating held_until directly).
    await pool.query("UPDATE payments.payments SET status = 'FAILED' WHERE id = $1", [reservation.paymentId]);

    const settledCount = await runPaymentPollOnce(pool);
    expect(settledCount).toBeGreaterThanOrEqual(1);

    const { rows: reservationRows } = await pool.query(
      "SELECT state FROM ordering.reservations WHERE id = $1",
      [reservation.id],
    );
    expect(reservationRows[0].state).toBe("FAILED");

    const { rows: seatRows } = await pool.query(
      "SELECT status, hold_id FROM inventory.seats WHERE id = ANY($1)",
      [reservation.seatIds],
    );
    for (const row of seatRows) {
      expect(row.status).toBe("AVAILABLE");
      expect(row.hold_id).toBeNull();
    }

    const { rows: ticketRows } = await pool.query(
      "SELECT count(*)::int AS count FROM ordering.tickets WHERE reservation_id = $1",
      [reservation.id],
    );
    expect(ticketRows[0].count).toBe(0);
  });

  it("late payment after expiry: refunds instead of reclaiming the seat", async () => {
    const eventId = await createEvent();
    const reservation = await reserve(eventId, 1);
    await confirm(reservation.paymentId);

    await pool.query("UPDATE ordering.reservations SET held_until = now() - interval '1 second' WHERE id = $1", [
      reservation.id,
    ]);
    await pool.query("UPDATE payments.payments SET status = 'SUCCEEDED' WHERE id = $1", [reservation.paymentId]);

    // Sweeper wins the row first, deterministically, so this test exercises
    // the late-refund path specifically rather than the race itself.
    const expiredCount = await runSweepOnce(pool);
    expect(expiredCount).toBeGreaterThanOrEqual(1);

    const settledCount = await runPaymentPollOnce(pool);
    expect(settledCount).toBeGreaterThanOrEqual(1);

    const { rows: reservationRows } = await pool.query(
      "SELECT state FROM ordering.reservations WHERE id = $1",
      [reservation.id],
    );
    expect(reservationRows[0].state).toBe("REFUNDED");

    const { rows: paymentRows } = await pool.query(
      "SELECT status FROM payments.payments WHERE id = $1",
      [reservation.paymentId],
    );
    expect(paymentRows[0].status).toBe("REFUNDED");

    const { rows: seatRows } = await pool.query(
      "SELECT status, hold_id FROM inventory.seats WHERE id = ANY($1)",
      [reservation.seatIds],
    );
    for (const row of seatRows) {
      expect(row.status).toBe("AVAILABLE");
      expect(row.hold_id).toBeNull();
    }
  });

  it("confirming twice is an idempotent no-op, not an error", async () => {
    const eventId = await createEvent();
    const reservation = await reserve(eventId, 1);

    const first = await confirm(reservation.paymentId);
    expect(first.statusCode).toBe(200);
    const second = await confirm(reservation.paymentId);
    expect(second.statusCode).toBe(200);
  });

  it("returns 404 confirming an unknown payment", async () => {
    const res = await confirm("00000000-0000-0000-0000-000000000000");
    expect(res.statusCode).toBe(404);
  });

  it("returns 409 confirming payment for a reservation that already expired", async () => {
    const eventId = await createEvent();
    const reservation = await reserve(eventId, 1);

    await pool.query("UPDATE ordering.reservations SET held_until = now() - interval '1 second' WHERE id = $1", [
      reservation.id,
    ]);
    await runSweepOnce(pool);

    const res = await confirm(reservation.paymentId);
    expect(res.statusCode).toBe(409);
  });
});
