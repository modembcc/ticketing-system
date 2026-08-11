import type { Queryable } from "../../../platform/db/types.js";
import type { Reservation, ReservationState } from "./types.js";

interface ReservationRow {
  id: string;
  event_id: string;
  customer_id: string;
  seat_ids: string[];
  state: ReservationState;
  held_until: Date;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS = `id, event_id, customer_id, seat_ids, state, held_until, created_at, updated_at`;

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

export interface ExpiredReservation {
  id: string;
  seatIds: string[];
}

// One statement for the whole batch — the WHERE predicate (not the batch
// size) is what makes this safe against a concurrent writer racing on the
// same reservation (e.g. a future payment-confirm handler in M3).
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
     RETURNING id, seat_ids`,
    [limit],
  );
  return rows.map((r) => ({ id: r.id, seatIds: r.seat_ids }));
}
