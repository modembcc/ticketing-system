import type { PoolClient } from "pg";
import type { Queryable } from "../db/types.js";

export type IdempotencyStatus = "PENDING" | "COMPLETED";

export interface IdempotencyRecord {
  key: string;
  endpoint: string;
  requestHash: string;
  status: IdempotencyStatus;
  responseStatus: number | null;
  responseBody: unknown;
  createdAt: Date;
  expiresAt: Date;
}

interface IdempotencyRow {
  key: string;
  endpoint: string;
  request_hash: string;
  status: IdempotencyStatus;
  response_status: number | null;
  response_body: unknown;
  created_at: Date;
  expires_at: Date;
}

function mapRow(row: IdempotencyRow): IdempotencyRecord {
  return {
    key: row.key,
    endpoint: row.endpoint,
    requestHash: row.request_hash,
    status: row.status,
    responseStatus: row.response_status,
    responseBody: row.response_body,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

const SELECT_COLUMNS = `key, endpoint, request_hash, status, response_status, response_body, created_at, expires_at`;

export async function findIdempotencyKey(
  db: Queryable,
  key: string,
  endpoint: string,
): Promise<IdempotencyRecord | null> {
  const { rows } = await db.query<IdempotencyRow>(
    `SELECT ${SELECT_COLUMNS} FROM idem.idempotency_keys WHERE key = $1 AND endpoint = $2`,
    [key, endpoint],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export interface InsertPendingKeyInput {
  key: string;
  endpoint: string;
  requestHash: string;
}

const TTL_INTERVAL = "24 hours";

// ON CONFLICT DO NOTHING rather than throw/catch a unique-violation: under
// this endpoint's own acceptance test, a concurrent-duplicate insert isn't
// an exceptional case, it's the steady state (9 of 10 concurrent callers
// hit it on every run) — a thrown Postgres ERROR is the wrong tool for
// something that routine. Returns whether THIS call won the race.
export async function insertPendingKey(client: PoolClient, input: InsertPendingKeyInput): Promise<boolean> {
  const { rows } = await client.query(
    `INSERT INTO idem.idempotency_keys (key, endpoint, request_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '${TTL_INTERVAL}')
     ON CONFLICT (key, endpoint) DO NOTHING
     RETURNING key`,
    [input.key, input.endpoint, input.requestHash],
  );
  return rows.length > 0;
}

export interface CompleteKeyInput {
  key: string;
  endpoint: string;
  status: number;
  body: unknown;
}

export async function completeKey(client: PoolClient, input: CompleteKeyInput): Promise<void> {
  await client.query(
    `UPDATE idem.idempotency_keys
     SET status = 'COMPLETED', response_status = $3, response_body = $4::jsonb
     WHERE key = $1 AND endpoint = $2`,
    [input.key, input.endpoint, input.status, JSON.stringify(input.body)],
  );
}

// Bounded batch, mirroring the M2/M3 sweepers' LIMIT pattern.
export async function sweepExpiredIdempotencyKeys(db: Queryable, limit = 500): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM idem.idempotency_keys
     WHERE (key, endpoint) IN (
       SELECT key, endpoint FROM idem.idempotency_keys
       WHERE expires_at < now()
       LIMIT $1
     )`,
    [limit],
  );
  return rowCount ?? 0;
}

export interface MarkMessageProcessedInput {
  messageId: string;
  consumer: string;
  resultHash?: string | null;
}

// Must be called inside the same transaction as the message's side effect.
// Returns false ("already handled, ack and move on") on redelivery — the
// normal case for at-least-once delivery, hence ON CONFLICT DO NOTHING
// rather than a thrown error, same reasoning as insertPendingKey above.
// Never dedupe in application memory — the whole point is surviving a
// process restart mid-delivery.
export async function markMessageProcessed(client: PoolClient, input: MarkMessageProcessedInput): Promise<boolean> {
  const { rows } = await client.query(
    `INSERT INTO idem.processed_messages (message_id, consumer, result_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (message_id, consumer) DO NOTHING
     RETURNING message_id`,
    [input.messageId, input.consumer, input.resultHash ?? null],
  );
  return rows.length > 0;
}
