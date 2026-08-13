import type { PoolClient } from "pg";
import type { Queryable } from "../db/types.js";

export interface OutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  createdAt: Date;
  publishedAt: Date | null;
}

interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  created_at: Date;
  published_at: Date | null;
}

function mapRow(row: OutboxRow): OutboxEvent {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}

const SELECT_COLUMNS = `id, aggregate_type, aggregate_id, event_type, payload, created_at, published_at`;

export interface InsertOutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
}

export async function insertOutboxEvent(client: PoolClient, input: InsertOutboxEventInput): Promise<void> {
  await client.query(
    `INSERT INTO outbox.events (aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [input.aggregateType, input.aggregateId, input.eventType, JSON.stringify(input.payload)],
  );
}

// Ordering holds not because of the routing key, but because the relay
// claims and publishes rows in created_at order inside one transaction,
// there's exactly one queue, and one consumer draining it sequentially
// (get -> ack -> next, no prefetch/pipelining). FOR UPDATE SKIP LOCKED
// guards against two overlapping relay ticks double-claiming the same rows
// if a slow publish makes one tick still running when the next timer fires.
export async function claimUnpublishedBatch(client: PoolClient, limit: number): Promise<OutboxEvent[]> {
  const { rows } = await client.query<OutboxRow>(
    `SELECT ${SELECT_COLUMNS} FROM outbox.events
     WHERE published_at IS NULL
     ORDER BY created_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return rows.map(mapRow);
}

export async function markPublished(client: PoolClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await client.query(`UPDATE outbox.events SET published_at = now() WHERE id = ANY($1)`, [ids]);
}

export async function findOutboxEventsByAggregateId(db: Queryable, aggregateId: string): Promise<OutboxEvent[]> {
  const { rows } = await db.query<OutboxRow>(
    `SELECT ${SELECT_COLUMNS} FROM outbox.events WHERE aggregate_id = $1 ORDER BY created_at`,
    [aggregateId],
  );
  return rows.map(mapRow);
}
