import { writeSync } from "node:fs";
import { Pool } from "pg";
import { withTransaction } from "../../../../platform/db/withTransaction.js";
import { insertEvent } from "../../../../modules/catalog/index.js";
import { generateSeats } from "../../../../modules/inventory/index.js";
import { createReservation, settlePaidPayment } from "../../../../modules/ordering/index.js";

// Runs the real fulfillment flow (event -> reservation -> paid -> fulfilled,
// which as of M5 also commits an outbox row in the same transaction) using
// the actual module functions — then deliberately exits before the relay
// (or RabbitMQ) is ever touched. This is the literal "process dies between
// commit and publish" scenario the M5 acceptance test exists to prove
// survives: nothing in this script calls runRelayOnce or connects to the
// broker at all.
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const pool = new Pool({ connectionString });
  const now = Date.now();

  const eventId = await withTransaction(pool, async (client) => {
    const event = await insertEvent(client, {
      name: "Crash Test Show",
      venue: "Test Hall",
      startsAt: new Date(now + 24 * 60 * 60 * 1000),
      saleStartsAt: new Date(now - 60 * 60 * 1000),
      saleEndsAt: new Date(now + 60 * 60 * 1000),
      capacity: 1,
    });
    await generateSeats(client, event.id, event.capacity);
    return event.id;
  });

  const reservation = await withTransaction(pool, (client) =>
    createReservation(client, { eventId, customerId: "cust-crash-test", seatCount: 1 }),
  );

  const paymentId = reservation.paymentId;
  if (!paymentId) {
    throw new Error("reservation was created without a payment intent");
  }

  // Resolve payment directly (bypass confirm/gateway simulator), same
  // established pattern as M2/M3's tests simulating time/outcome via SQL.
  await pool.query("UPDATE payments.payments SET status = 'SUCCEEDED' WHERE id = $1", [paymentId]);

  // Commits PAID -> FULFILLED, ticket issuance, seats SOLD, and (as of M5)
  // the outbox row — all in fulfillPaidReservation's own transaction.
  await settlePaidPayment(pool, { reservationId: reservation.id, paymentId });

  // Synchronous write, not console.log: on Windows, stdout to a pipe is
  // non-blocking, so a console.log immediately followed by process.exit()
  // can truncate before the parent process ever sees it.
  writeSync(1, `RESERVATION_ID=${reservation.id}\n`);

  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
