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

// Snapshot read, no locking — the follow-up conditional UPDATE re-validates
// availability, so a stale candidate here just means that seat loses its race.
async function selectAvailableSeatCandidates(
  db: Queryable,
  eventId: string,
  count: number,
): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM inventory.seats
     WHERE event_id = $1 AND status = 'AVAILABLE'
     ORDER BY id
     LIMIT $2`,
    [eventId, count],
  );
  return rows.map((r) => r.id);
}

// Sorted seat ids avoid deadlocks when two concurrent holds touch overlapping
// rows in different orders. Only rows still AVAILABLE get claimed — rows lost
// to a concurrent winner are silently excluded from the result, not errored.
async function holdSeats(
  db: Queryable,
  { seatIds, holdId, heldUntil }: { seatIds: string[]; holdId: string; heldUntil: Date },
): Promise<Seat[]> {
  if (seatIds.length === 0) return [];
  const { rows } = await db.query<SeatRow>(
    `UPDATE inventory.seats
     SET status = 'HELD', hold_id = $1, held_until = $2, version = version + 1
     WHERE id = ANY($3) AND status = 'AVAILABLE'
     RETURNING ${SELECT_COLUMNS}`,
    [holdId, heldUntil, [...seatIds].sort()],
  );
  return rows.map(mapRow);
}

export interface HoldSeatsForEventInput {
  eventId: string;
  count: number;
  holdId: string;
  heldUntil: Date;
  maxAttempts?: number;
}

// Customers ask for a seat *count*, not specific seats (no seat maps), so a
// single select-then-update can't just retry with the same candidates when it
// loses a race — it has to re-select from what's still available and keep
// going until it reaches `count` or genuinely runs out. Each round strictly
// shrinks the pool of claimable seats, so this always terminates; maxAttempts
// is just a defensive backstop, not load-bearing at realistic contention.
export async function holdSeatsForEvent(
  db: Queryable,
  { eventId, count, holdId, heldUntil, maxAttempts = 50 }: HoldSeatsForEventInput,
): Promise<Seat[]> {
  const held: Seat[] = [];
  for (let attempt = 0; held.length < count && attempt < maxAttempts; attempt++) {
    const remaining = count - held.length;
    const candidateIds = await selectAvailableSeatCandidates(db, eventId, remaining);
    if (candidateIds.length === 0) break;
    const won = await holdSeats(db, { seatIds: candidateIds, holdId, heldUntil });
    held.push(...won);
  }
  return held;
}

export interface ReleaseSeatsInput {
  seatIds: string[];
  holdId: string;
}

// Guarded by hold_id so a stale/duplicate release can't clobber a seat that's
// since been re-held by someone else.
export async function releaseSeats(db: Queryable, { seatIds, holdId }: ReleaseSeatsInput): Promise<number> {
  if (seatIds.length === 0) return 0;
  const { rowCount } = await db.query(
    `UPDATE inventory.seats
     SET status = 'AVAILABLE', hold_id = NULL, held_until = NULL, version = version + 1
     WHERE id = ANY($1) AND hold_id = $2 AND status = 'HELD'`,
    [seatIds, holdId],
  );
  return rowCount ?? 0;
}

export interface MarkSeatsSoldInput {
  seatIds: string[];
  holdId: string;
}

// Guarded by hold_id + status='HELD' so a retried fulfillment (ticket issuance
// re-run after a partial failure) is a safe no-op the second time through.
export async function markSeatsSold(db: Queryable, { seatIds, holdId }: MarkSeatsSoldInput): Promise<number> {
  if (seatIds.length === 0) return 0;
  const { rowCount } = await db.query(
    `UPDATE inventory.seats
     SET status = 'SOLD', version = version + 1
     WHERE id = ANY($1) AND hold_id = $2 AND status = 'HELD'`,
    [seatIds, holdId],
  );
  return rowCount ?? 0;
}
