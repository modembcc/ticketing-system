import { randomUUID } from "node:crypto";
import type { Queryable } from "../../../platform/db/types.js";
import { PaymentNotFoundError } from "./errors.js";
import type { Payment, PaymentStatus } from "./types.js";

interface PaymentRow {
  id: string;
  reservation_id: string;
  status: PaymentStatus;
  amount_cents: number;
  provider_ref: string;
  confirmed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: PaymentRow): Payment {
  return {
    id: row.id,
    reservationId: row.reservation_id,
    status: row.status,
    amountCents: row.amount_cents,
    providerRef: row.provider_ref,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS = `id, reservation_id, status, amount_cents, provider_ref, confirmed_at, created_at, updated_at`;

export interface CreatePaymentIntentInput {
  reservationId: string;
  amountCents: number;
}

export async function createPaymentIntent(db: Queryable, input: CreatePaymentIntentInput): Promise<Payment> {
  const { rows } = await db.query<PaymentRow>(
    `INSERT INTO payments.payments (id, reservation_id, amount_cents, provider_ref)
     VALUES ($1, $2, $3, $4)
     RETURNING ${SELECT_COLUMNS}`,
    [randomUUID(), input.reservationId, input.amountCents, `pi_${randomUUID()}`],
  );
  return mapRow(rows[0]);
}

export async function findPaymentById(db: Queryable, id: string): Promise<Payment | null> {
  const { rows } = await db.query<PaymentRow>(`SELECT ${SELECT_COLUMNS} FROM payments.payments WHERE id = $1`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

// Confirming twice is not an error — a customer double-clicking "pay" (or a
// retried request before M4's idempotency keys exist) just observes the
// intent's current state rather than being rejected.
export async function confirmPayment(db: Queryable, id: string): Promise<Payment> {
  const { rows } = await db.query<PaymentRow>(
    `UPDATE payments.payments
     SET confirmed_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'PENDING' AND confirmed_at IS NULL
     RETURNING ${SELECT_COLUMNS}`,
    [id],
  );
  if (rows[0]) return mapRow(rows[0]);

  const existing = await findPaymentById(db, id);
  if (!existing) throw new PaymentNotFoundError(id);
  return existing;
}

// The fake gateway's own tick: resolves confirmed intents that have been
// "processing" long enough, independent of anything the orchestrator does.
export async function resolveDuePayments(db: Queryable, olderThanMs: number): Promise<Payment[]> {
  const { rows } = await db.query<PaymentRow>(
    `UPDATE payments.payments
     SET status = 'SUCCEEDED', updated_at = now()
     WHERE status = 'PENDING'
       AND confirmed_at IS NOT NULL
       AND confirmed_at < now() - ($1 || ' milliseconds')::interval
     RETURNING ${SELECT_COLUMNS}`,
    [olderThanMs],
  );
  return rows.map(mapRow);
}

export async function refundPayment(db: Queryable, id: string): Promise<Payment | null> {
  const { rows } = await db.query<PaymentRow>(
    `UPDATE payments.payments
     SET status = 'REFUNDED', updated_at = now()
     WHERE id = $1 AND status = 'SUCCEEDED'
     RETURNING ${SELECT_COLUMNS}`,
    [id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}
