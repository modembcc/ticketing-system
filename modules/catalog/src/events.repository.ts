import type { Queryable } from "../../../platform/db/types.js";
import type { CreateEventInput, Event } from "./types.js";

interface EventRow {
  id: string;
  name: string;
  venue: string;
  starts_at: Date;
  sale_starts_at: Date;
  sale_ends_at: Date;
  capacity: number;
  created_at: Date;
}

function mapRow(row: EventRow): Event {
  return {
    id: row.id,
    name: row.name,
    venue: row.venue,
    startsAt: row.starts_at,
    saleStartsAt: row.sale_starts_at,
    saleEndsAt: row.sale_ends_at,
    capacity: row.capacity,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS = `id, name, venue, starts_at, sale_starts_at, sale_ends_at, capacity, created_at`;

export async function insertEvent(db: Queryable, input: CreateEventInput): Promise<Event> {
  const { rows } = await db.query<EventRow>(
    `INSERT INTO catalog.events (name, venue, starts_at, sale_starts_at, sale_ends_at, capacity)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${SELECT_COLUMNS}`,
    [input.name, input.venue, input.startsAt, input.saleStartsAt, input.saleEndsAt, input.capacity],
  );
  return mapRow(rows[0]);
}

export async function findEventById(db: Queryable, id: string): Promise<Event | null> {
  const { rows } = await db.query<EventRow>(
    `SELECT ${SELECT_COLUMNS} FROM catalog.events WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function listEvents(db: Queryable): Promise<Event[]> {
  const { rows } = await db.query<EventRow>(
    `SELECT ${SELECT_COLUMNS} FROM catalog.events ORDER BY starts_at`,
  );
  return rows.map(mapRow);
}
