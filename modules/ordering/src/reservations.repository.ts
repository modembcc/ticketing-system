import type { Queryable } from "../../../platform/db/types.js";
import type { Reservation, ReservationState } from "./types.js";

interface ReservationRow {
  id: string;
  event_id: string;
  customer_id: string;
  seat_ids: string[];
  state: ReservationState;
  held_until: Date;
  payment_id: string | null;
  amount_cents: number;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: ReservationRow): Reservation {
  return {
    id: row.id,
    eventId: row.event_id,
    customerId: row.customer_id,
    seatIds: row.seat_ids,
    state: row.state,
    heldUntil: row.held_until,
    paymentId: row.payment_id,
    amountCents: row.amount_cents,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS = `id, event_id, customer_id, seat_ids, state, held_until, payment_id, amount_cents, created_at, updated_at`;

export interface InsertReservationInput {
  id: string;
  eventId: string;
  customerId: string;
  seatIds: string[];
  heldUntil: Date;
}

export async function insertReservation(db: Queryable, input: InsertReservationInput): Promise<Reservation> {
  const { rows } = await db.query<ReservationRow>(
    `INSERT INTO ordering.reservations (id, event_id, customer_id, seat_ids, held_until)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${SELECT_COLUMNS}`,
    [input.id, input.eventId, input.customerId, input.seatIds, input.heldUntil],
  );
  return mapRow(rows[0]);
}

export async function findReservationById(db: Queryable, id: string): Promise<Reservation | null> {
  const { rows } = await db.query<ReservationRow>(
    `SELECT ${SELECT_COLUMNS} FROM ordering.reservations WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export interface AttachPaymentInput {
  reservationId: string;
  paymentId: string;
  amountCents: number;
}

// Reservation must exist before the payment row can FK to it, so this is a
// deliberate follow-up statement, not part of insertReservation itself.
export async function attachPayment(db: Queryable, input: AttachPaymentInput): Promise<Reservation> {
  const { rows } = await db.query<ReservationRow>(
    `UPDATE ordering.reservations
     SET payment_id = $2, amount_cents = $3, updated_at = now()
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [input.reservationId, input.paymentId, input.amountCents],
  );
  return mapRow(rows[0]);
}

export interface ExpiredReservation {
  id: string;
  seatIds: string[];
}

// The outer WHERE duplicates the subquery's guard on purpose: when this
// UPDATE has to wait for a row lock held by a concurrent settlePaidPayment,
// Postgres re-checks the OUTER predicate on wake (EvalPlanQual) but does NOT
// re-run the inner subquery — so without this duplication, a row that just
// won the payment race could still get clobbered back to EXPIRED after the
// fact. This is what makes the sweeper-vs-payment race actually safe.
export async function expireDueReservations(db: Queryable, limit: number): Promise<ExpiredReservation[]> {
  const { rows } = await db.query<{ id: string; seat_ids: string[] }>(
    `UPDATE ordering.reservations
     SET state = 'EXPIRED', updated_at = now()
     WHERE id IN (
       SELECT id FROM ordering.reservations
       WHERE state = 'AWAITING_PAYMENT' AND held_until < now()
       ORDER BY held_until
       LIMIT $1
     )
     AND state = 'AWAITING_PAYMENT'
     AND held_until < now()
     RETURNING id, seat_ids`,
    [limit],
  );
  return rows.map((r) => ({ id: r.id, seatIds: r.seat_ids }));
}

export interface TransitionInput {
  reservationId: string;
  paymentId: string;
}

// The pivot. Guarded by held_until (the sweeper must not have won yet) AND a
// live check that the payment itself reads SUCCEEDED — money only moves
// forward through this row if both are true at the instant this commits.
export async function tryTransitionToPaid(db: Queryable, input: TransitionInput): Promise<Reservation | null> {
  const { rows } = await db.query<ReservationRow>(
    `UPDATE ordering.reservations
     SET state = 'PAID', updated_at = now()
     WHERE id = $1
       AND state = 'AWAITING_PAYMENT'
       AND payment_id = $2
       AND held_until >= now()
       AND EXISTS (SELECT 1 FROM payments.payments p WHERE p.id = $2 AND p.status = 'SUCCEEDED')
     RETURNING ${SELECT_COLUMNS}`,
    [input.reservationId, input.paymentId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

// Compensation for a declined/errored charge: release seats, no refund needed
// since no money was ever captured. No-op if the sweeper already won (seats
// are already released) or another tick already settled this payment.
export async function tryTransitionToFailed(db: Queryable, input: TransitionInput): Promise<Reservation | null> {
  const { rows } = await db.query<ReservationRow>(
    `UPDATE ordering.reservations
     SET state = 'FAILED', updated_at = now()
     WHERE id = $1 AND state = 'AWAITING_PAYMENT' AND payment_id = $2
     RETURNING ${SELECT_COLUMNS}`,
    [input.reservationId, input.paymentId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

// The unhappy pivot: payment succeeded after the sweeper already expired the
// hold and released the seats. Never claws the seat back — just starts the
// refund.
export async function tryTransitionToRefunding(db: Queryable, input: TransitionInput): Promise<Reservation | null> {
  const { rows } = await db.query<ReservationRow>(
    `UPDATE ordering.reservations
     SET state = 'REFUNDING', updated_at = now()
     WHERE id = $1 AND state = 'EXPIRED' AND payment_id = $2
     RETURNING ${SELECT_COLUMNS}`,
    [input.reservationId, input.paymentId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function markRefunded(db: Queryable, reservationId: string): Promise<Reservation | null> {
  const { rows } = await db.query<ReservationRow>(
    `UPDATE ordering.reservations
     SET state = 'REFUNDED', updated_at = now()
     WHERE id = $1 AND state = 'REFUNDING'
     RETURNING ${SELECT_COLUMNS}`,
    [reservationId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

// Fulfillment is retried by re-running the whole thing (issue tickets, mark
// seats sold — both idempotent) then flipping state; guarded by state='PAID'
// so a reservation already FULFILLED is left alone.
export async function tryMarkFulfilled(db: Queryable, reservationId: string): Promise<Reservation | null> {
  const { rows } = await db.query<ReservationRow>(
    `UPDATE ordering.reservations
     SET state = 'FULFILLED', updated_at = now()
     WHERE id = $1 AND state = 'PAID'
     RETURNING ${SELECT_COLUMNS}`,
    [reservationId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export interface PollCandidate {
  id: string;
  state: ReservationState;
  paymentId: string;
  heldUntil: Date;
}

// Candidates for the payment poller: anything with an intent that might
// still need settling. PAID means fulfillment started but didn't finish
// (retry it); EXPIRED means check for a late-succeeding payment.
export async function findPollCandidates(db: Queryable): Promise<PollCandidate[]> {
  const { rows } = await db.query<{
    id: string;
    state: ReservationState;
    payment_id: string;
    held_until: Date;
  }>(
    `SELECT id, state, payment_id, held_until
     FROM ordering.reservations
     WHERE state IN ('AWAITING_PAYMENT', 'PAID', 'EXPIRED') AND payment_id IS NOT NULL`,
  );
  return rows.map((r) => ({ id: r.id, state: r.state, paymentId: r.payment_id, heldUntil: r.held_until }));
}
