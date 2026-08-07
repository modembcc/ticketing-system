import type { Queryable } from "../../../platform/db/types.js";
import type { Seat, SeatStatus } from "./types.js";

interface SeatRow {
  id: string;
  event_id: string;
  label: string;
  status: SeatStatus;
  hold_id: string | null;
  held_until: Date | null;
  version: number;
}

function mapRow(row: SeatRow): Seat {
  return {
    id: row.id,
    eventId: row.event_id,
    label: row.label,
    status: row.status,
    holdId: row.hold_id,
    heldUntil: row.held_until,
    version: row.version,
  };
}

const SELECT_COLUMNS = `id, event_id, label, status, hold_id, held_until, version`;

export async function generateSeats(db: Queryable, eventId: string, capacity: number): Promise<Seat[]> {
  const labels = Array.from({ length: capacity }, (_, i) => `S${i + 1}`);
  const { rows } = await db.query<SeatRow>(
    `INSERT INTO inventory.seats (event_id, label)
     SELECT $1, label FROM unnest($2::text[]) AS label
     RETURNING ${SELECT_COLUMNS}`,
    [eventId, labels],
  );
  return rows.map(mapRow);
}

export async function listSeatsByEvent(db: Queryable, eventId: string): Promise<Seat[]> {
  const { rows } = await db.query<SeatRow>(
    `SELECT ${SELECT_COLUMNS} FROM inventory.seats WHERE event_id = $1 ORDER BY label`,
    [eventId],
  );
  return rows.map(mapRow);
}

// Batched rather than per-event so listing endpoints don't N+1 across events.
export async function countAvailableByEventIds(
  db: Queryable,
  eventIds: string[],
): Promise<Map<string, number>> {
  if (eventIds.length === 0) return new Map();
  const { rows } = await db.query<{ event_id: string; available: number }>(
    `SELECT event_id, count(*)::int AS available
     FROM inventory.seats
     WHERE event_id = ANY($1) AND status = 'AVAILABLE'
     GROUP BY event_id`,
    [eventIds],
  );
  return new Map(rows.map((r) => [r.event_id, r.available]));
}
