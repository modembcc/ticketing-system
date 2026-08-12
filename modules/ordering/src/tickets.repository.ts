import type { Queryable } from "../../../platform/db/types.js";
import type { Ticket } from "./types.js";

interface TicketRow {
  id: string;
  reservation_id: string;
  seat_id: string;
  customer_id: string;
  issued_at: Date;
  qr_token: string;
}

function mapRow(row: TicketRow): Ticket {
  return {
    id: row.id,
    reservationId: row.reservation_id,
    seatId: row.seat_id,
    customerId: row.customer_id,
    issuedAt: row.issued_at,
    qrToken: row.qr_token,
  };
}

const SELECT_COLUMNS = `id, reservation_id, seat_id, customer_id, issued_at, qr_token`;

export async function findTicketsByReservation(db: Queryable, reservationId: string): Promise<Ticket[]> {
  const { rows } = await db.query<TicketRow>(
    `SELECT ${SELECT_COLUMNS} FROM ordering.tickets WHERE reservation_id = $1 ORDER BY seat_id`,
    [reservationId],
  );
  return rows.map(mapRow);
}

export interface IssueTicketsInput {
  reservationId: string;
  seatIds: string[];
  customerId: string;
}

// Idempotent: `seat_id` is UNIQUE, so a retried fulfillment attempt just
// finds nothing left to insert the second time through. Re-fetches the full
// set afterward so a partial-then-completed insert still returns everything.
export async function issueTicketsForReservation(db: Queryable, input: IssueTicketsInput): Promise<Ticket[]> {
  const existing = await findTicketsByReservation(db, input.reservationId);
  if (existing.length === input.seatIds.length) return existing;

  await db.query(
    `INSERT INTO ordering.tickets (reservation_id, seat_id, customer_id, qr_token)
     SELECT $1, seat_id, $3, encode(gen_random_bytes(16), 'hex')
     FROM unnest($2::uuid[]) AS seat_id
     ON CONFLICT (seat_id) DO NOTHING`,
    [input.reservationId, input.seatIds, input.customerId],
  );

  return findTicketsByReservation(db, input.reservationId);
}
