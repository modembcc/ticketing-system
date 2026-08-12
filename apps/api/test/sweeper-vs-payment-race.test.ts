import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { buildApp } from "../src/app.js";
import { runMigrations } from "../../../platform/migrate/run.js";
import { runSweepOnce, settlePaidPayment } from "../../../modules/ordering/index.js";

// The scenario from the spec: "The sweeper fires at T+5:00 exactly as
// capture succeeds. Both must be conditional so exactly one wins." Exercised
// directly against the real sweeper and the real pivot handler (bypassing
// the payment poller/gateway simulator, which is fine per this project's
// established pattern of simulating time-based conditions with direct SQL
// rather than waiting on real timers — see M2's sweeper test).
describe("sweeper vs payment success race", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 10 });
    app = buildApp({ pool });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await container.stop();
  });

  // held_until sits at now()+offsetMs. tryTransitionToPaid's own guard
  // requires held_until>=now(), and expireDueReservations requires
  // held_until<now() — those are a strict partition of a single instant for
  // a fixed timestamp, so a *negative* offset makes FULFILLED structurally
  // impossible (settle can never pass its own guard) and a large positive
  // offset makes REFUNDED structurally impossible (sweep can never match).
  // Only an offset close to zero, raced concurrently, leaves the outcome
  // genuinely dependent on transaction-start timing — which is exactly the
  // "sweeper fires at T+5:00 exactly as capture succeeds" scenario from the
  // spec, and the one that exercises the row-lock/EvalPlanQual fix.
  async function setupDueReservation(
    offsetMs: number,
  ): Promise<{ reservationId: string; paymentId: string; seatIds: string[] }> {
    const now = Date.now();
    const eventRes = await app.inject({
      method: "POST",
      url: "/admin/events",
      payload: {
        name: "Race Test Show",
        venue: "Test Hall",
        startsAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
        saleStartsAt: new Date(now - 60 * 60 * 1000).toISOString(),
        saleEndsAt: new Date(now + 60 * 60 * 1000).toISOString(),
        capacity: 1,
      },
    });
    expect(eventRes.statusCode).toBe(201);
    const eventId = eventRes.json().id;

    const reservationRes = await app.inject({
      method: "POST",
      url: "/reservations",
      headers: { "x-customer-id": "cust-race" },
      payload: { eventId, seatCount: 1 },
    });
    expect(reservationRes.statusCode).toBe(201);
    const reservation = reservationRes.json();

    await pool.query(
      "UPDATE ordering.reservations SET held_until = now() + ($2 || ' milliseconds')::interval WHERE id = $1",
      [reservation.id, offsetMs],
    );
    await pool.query("UPDATE payments.payments SET status = 'SUCCEEDED' WHERE id = $1", [reservation.paymentId]);

    return { reservationId: reservation.id, paymentId: reservation.paymentId, seatIds: reservation.seatIds };
  }

  it("resolves to exactly one consistent outcome across 100 runs, observing both", async () => {
    const outcomes: Array<"FULFILLED" | "REFUNDED"> = [];

    for (let i = 0; i < 100; i++) {
      // 1/3 clearly in payment's favor (generous deadline), 1/3 clearly in
      // the sweeper's favor (deadline already passed), 1/3 a genuine
      // concurrent race right at the boundary — see setupDueReservation.
      const mod = i % 3;
      const offsetMs = mod === 0 ? 200 : mod === 1 ? -50 : 15;
      const { reservationId, paymentId, seatIds } = await setupDueReservation(offsetMs);

      const settle = () => settlePaidPayment(pool, { reservationId, paymentId });
      const sweep = () => runSweepOnce(pool);

      await Promise.all([sweep(), settle()]);

      // Each of sweep()/settle() makes exactly one attempt — same as one
      // tick of the real sweeper/poller. Sub-millisecond disagreement
      // between the two transactions' own now() (e.g. sweep decides "not
      // due yet" a moment before settle decides "too late to pivot") can
      // leave the row briefly unresolved. In production this self-heals on
      // the next tick of each background worker; simulate exactly that
      // rather than expecting single-shot resolution from one instant.
      let { rows: reservationRows } = await pool.query(
        "SELECT state FROM ordering.reservations WHERE id = $1",
        [reservationId],
      );
      if (reservationRows[0].state === "AWAITING_PAYMENT") {
        await sweep();
        await settle();
        ({ rows: reservationRows } = await pool.query(
          "SELECT state FROM ordering.reservations WHERE id = $1",
          [reservationId],
        ));
      } else if (reservationRows[0].state === "EXPIRED") {
        await settle();
        ({ rows: reservationRows } = await pool.query(
          "SELECT state FROM ordering.reservations WHERE id = $1",
          [reservationId],
        ));
      }
      const state = reservationRows[0].state;

      if (state === "FULFILLED") {
        outcomes.push("FULFILLED");
        const { rows: seatRows } = await pool.query("SELECT status FROM inventory.seats WHERE id = ANY($1)", [
          seatIds,
        ]);
        for (const row of seatRows) expect(row.status).toBe("SOLD");

        const { rows: ticketRows } = await pool.query(
          "SELECT count(*)::int AS count FROM ordering.tickets WHERE reservation_id = $1",
          [reservationId],
        );
        expect(ticketRows[0].count).toBe(seatIds.length);

        const { rows: paymentRows } = await pool.query("SELECT status FROM payments.payments WHERE id = $1", [
          paymentId,
        ]);
        expect(paymentRows[0].status).toBe("SUCCEEDED");
      } else if (state === "REFUNDED") {
        outcomes.push("REFUNDED");
        const { rows: seatRows } = await pool.query(
          "SELECT status, hold_id FROM inventory.seats WHERE id = ANY($1)",
          [seatIds],
        );
        for (const row of seatRows) {
          expect(row.status).toBe("AVAILABLE");
          expect(row.hold_id).toBeNull();
        }

        const { rows: paymentRows } = await pool.query("SELECT status FROM payments.payments WHERE id = $1", [
          paymentId,
        ]);
        expect(paymentRows[0].status).toBe("REFUNDED");
      } else {
        throw new Error(`iteration ${i}: reservation ended up in unexpected state ${state}`);
      }
    }

    expect(outcomes).toHaveLength(100);
    const fulfilledCount = outcomes.filter((o) => o === "FULFILLED").length;
    const refundedCount = outcomes.filter((o) => o === "REFUNDED").length;
    // Both outcomes must actually occur — otherwise this test could pass
    // 100/100 times without ever exercising one side of the race.
    expect(fulfilledCount).toBeGreaterThanOrEqual(10);
    expect(refundedCount).toBeGreaterThanOrEqual(10);
  }, 120_000);
});
