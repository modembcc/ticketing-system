import type { PoolClient } from "pg";
import type { Queryable } from "../db/types.js";

export interface DlqEntry {
  id: string;
  sourceQueue: string;
  consumer: string;
  messageId: string | null;
  rawContent: string;
  payload: unknown;
  failureReason: string;
  attemptCount: number;
  brokerHeaders: unknown;
  createdAt: Date;
  replayedAt: Date | null;
  discardedAt: Date | null;
  discardReason: string | null;
}

interface DlqEntryRow {
  id: string;
  source_queue: string;
  consumer: string;
  message_id: string | null;
  raw_content: string;
  payload: unknown;
  failure_reason: string;
  attempt_count: number;
  broker_headers: unknown;
  created_at: Date;
  replayed_at: Date | null;
  discarded_at: Date | null;
  discard_reason: string | null;
}

function mapRow(row: DlqEntryRow): DlqEntry {
  return {
    id: row.id,
    sourceQueue: row.source_queue,
    consumer: row.consumer,
    messageId: row.message_id,
    rawContent: row.raw_content,
    payload: row.payload,
    failureReason: row.failure_reason,
    attemptCount: row.attempt_count,
    brokerHeaders: row.broker_headers,
    createdAt: row.created_at,
    replayedAt: row.replayed_at,
    discardedAt: row.discarded_at,
    discardReason: row.discard_reason,
  };
}

const SELECT_COLUMNS = `id, source_queue, consumer, message_id, raw_content, payload, failure_reason,
  attempt_count, broker_headers, created_at, replayed_at, discarded_at, discard_reason`;

export interface InsertDlqEntryInput {
  sourceQueue: string;
  consumer: string;
  messageId: string | null;
  rawContent: string;
  payload: unknown;
  failureReason: string;
  attemptCount: number;
  brokerHeaders: unknown;
}

// ON CONFLICT DO NOTHING guards the crash window between this insert and
// acking the original delivery (see migration comment) — only matters when
// messageId is known; a malformed message with no parseable id always gets
// its own row, which is fine (rare, and there's no id to dedupe on anyway).
export async function insertDlqEntry(client: PoolClient, input: InsertDlqEntryInput): Promise<void> {
  await client.query(
    `INSERT INTO dlq.entries
       (source_queue, consumer, message_id, raw_content, payload, failure_reason, attempt_count, broker_headers)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb)
     ON CONFLICT (message_id, consumer) WHERE message_id IS NOT NULL AND replayed_at IS NULL AND discarded_at IS NULL
     DO NOTHING`,
    [
      input.sourceQueue,
      input.consumer,
      input.messageId,
      input.rawContent,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.failureReason,
      input.attemptCount,
      input.brokerHeaders === undefined ? null : JSON.stringify(input.brokerHeaders),
    ],
  );
}

export async function listUnresolvedDlqEntries(db: Queryable, limit = 100): Promise<DlqEntry[]> {
  const { rows } = await db.query<DlqEntryRow>(
    `SELECT ${SELECT_COLUMNS} FROM dlq.entries
     WHERE replayed_at IS NULL AND discarded_at IS NULL
     ORDER BY created_at
     LIMIT $1`,
    [limit],
  );
  return rows.map(mapRow);
}

export async function findDlqEntryById(db: Queryable, id: string): Promise<DlqEntry | null> {
  const { rows } = await db.query<DlqEntryRow>(`SELECT ${SELECT_COLUMNS} FROM dlq.entries WHERE id = $1`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function markDlqEntryReplayed(client: PoolClient, id: string): Promise<void> {
  await client.query(
    `UPDATE dlq.entries SET replayed_at = now() WHERE id = $1 AND replayed_at IS NULL AND discarded_at IS NULL`,
    [id],
  );
}

export async function markDlqEntryDiscarded(client: PoolClient, id: string, reason: string): Promise<void> {
  await client.query(
    `UPDATE dlq.entries SET discarded_at = now(), discard_reason = $2
     WHERE id = $1 AND replayed_at IS NULL AND discarded_at IS NULL`,
    [id, reason],
  );
}
