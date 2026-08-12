import type { Pool, PoolClient } from "pg";
import { markSeatsSold, releaseSeats } from "../../inventory/index.js";
import { refundPayment } from "../../payments/index.js";
import { withTransaction } from "../../../platform/db/withTransaction.js";
import {
  findReservationById,
  markRefunded,
  tryMarkFulfilled,
  tryTransitionToFailed,
  tryTransitionToPaid,
  tryTransitionToRefunding,
} from "./reservations.repository.js";
import { issueTicketsForReservation } from "./tickets.repository.js";
import type { Reservation } from "./types.js";

export interface SettleInput {
  reservationId: string;
  paymentId: string;
}

// Fulfillment is deliberately its OWN transaction, separate from the PAID
// pivot: if ticket issuance ever had to be retried and it shared a
// transaction with the pivot, a retry failure would roll the PAID state back
// too — leaving a captured payment on a reservation that looks unpaid, which
// self-heals in the worst possible way (an eventual, unnecessary refund of a
// successful charge). Guarded by state='PAID' and built from idempotent
// pieces so re-running it after a partial failure is always safe.
export async function fulfillPaidReservation(pool: Pool, reservationId: string): Promise<Reservation | null> {
  return withTransaction(pool, async (client) => {
    const reservation = await findReservationById(client, reservationId);
    if (!reservation) return null;
    if (reservation.state === "FULFILLED") return reservation;
    if (reservation.state !== "PAID") return reservation;

    await issueTicketsForReservation(client, {
      reservationId: reservation.id,
      seatIds: reservation.seatIds,
      customerId: reservation.customerId,
    });
    await markSeatsSold(client, { seatIds: reservation.seatIds, holdId: reservation.id });
    const fulfilled = await tryMarkFulfilled(client, reservationId);
    return fulfilled ?? reservation;
  });
}

async function attemptRefundForLatePayment(pool: Pool, input: SettleInput): Promise<boolean> {
  return withTransaction(pool, async (client: PoolClient) => {
    const refunding = await tryTransitionToRefunding(client, input);
    if (!refunding) return false;
    await refundPayment(client, input.paymentId);
    await markRefunded(client, refunding.id);
    return true;
  });
}

// The pivot handler. Whoever's conditional UPDATE matches first wins the row
// (see reservations.repository's tryTransitionToPaid / the sweeper's
// expireDueReservations — both duplicate their guard into the outer UPDATE
// so a concurrent winner can't be clobbered after the fact). A loss here
// means either: the sweeper won first (fall through to the late-refund
// path), or a previous poll tick already settled this payment (both
// transitions below become no-ops — safe, and this is also what makes a
// duplicate "payment succeeded" signal harmless without needing an
// idempotency key).
export async function settlePaidPayment(pool: Pool, input: SettleInput): Promise<void> {
  const paid = await withTransaction(pool, (client) => tryTransitionToPaid(client, input));
  if (paid) {
    await fulfillPaidReservation(pool, input.reservationId);
    return;
  }
  await attemptRefundForLatePayment(pool, input);
}

export async function settleFailedPayment(pool: Pool, input: SettleInput): Promise<void> {
  await withTransaction(pool, async (client) => {
    const failed = await tryTransitionToFailed(client, input);
    if (failed) {
      await releaseSeats(client, { seatIds: failed.seatIds, holdId: failed.id });
    }
  });
}
