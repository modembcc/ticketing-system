import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RabbitMQContainer, type StartedRabbitMQContainer } from "@testcontainers/rabbitmq";
import { Pool } from "pg";
import type { ConfirmChannel, Channel } from "amqplib";
import { buildApp } from "../src/app.js";
import { runMigrations } from "../../../platform/migrate/run.js";
import { withTransaction } from "../../../platform/db/withTransaction.js";
import {
  closeBrokerConnection,
  createConsumerChannel,
  createPublisherChannel,
  DOMAIN_EVENTS_EXCHANGE,
} from "../../../platform/broker/connection.js";
import { insertOutboxEvent, findOutboxEventsByAggregateId } from "../../../platform/outbox/repository.js";
import { runRelayOnce } from "../../../platform/outbox/relay.js";
import {
  ensureNotifyQueue,
  runNotifyConsumeOnce,
  type DomainEventEnvelope,
  type NotifyConsumeOptions,
} from "../../../modules/notify/index.js";
import { insertEvent } from "../../../modules/catalog/index.js";
import { generateSeats } from "../../../modules/inventory/index.js";
import { createReservation, settlePaidPayment } from "../../../modules/ordering/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Short enough that the sum of all 5 tiers (plus ±20% jitter) comfortably
// finishes well under this file's test timeouts, but still exercises real
// RabbitMQ TTL expiry and dead-lettering — not mocked, not shortened logic,
// just a faster clock. Same length as production's 5-tier schedule, so the
// "6 total attempts before DLQ" reading (see DECISIONS.md) matches what ships.
const TEST_BACKOFF_MS = [20, 30, 40, 50, 60];

describe("notify: retries + DLQ", () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let rabbitContainer: StartedRabbitMQContainer;
  let pool: Pool;
  let publisherChannel: ConfirmChannel;
  let consumerChannel: Channel;
  let app: ReturnType<typeof buildApp>;
  let mailDir: string;

  beforeAll(async () => {
    [postgresContainer, rabbitContainer] = await Promise.all([
      new PostgreSqlContainer("postgres:16-alpine").start(),
      new RabbitMQContainer("rabbitmq:3.13-management-alpine").withStartupTimeout(120_000).start(),
    ]);
    await runMigrations(postgresContainer.getConnectionUri());
    pool = new Pool({ connectionString: postgresContainer.getConnectionUri() });

    publisherChannel = await createPublisherChannel(rabbitContainer.getAmqpUrl());
    consumerChannel = await createConsumerChannel(rabbitContainer.getAmqpUrl());
    await ensureNotifyQueue(consumerChannel, TEST_BACKOFF_MS);

    app = buildApp({ pool, publisherChannel });
    await app.ready();

    mailDir = path.join(__dirname, ".tmp-mail-dlq", randomUUID());
  }, 150_000);

  afterAll(async () => {
    await app?.close();
    await closeBrokerConnection().catch(() => {});
    await pool?.end();
    await postgresContainer?.stop();
    await rabbitContainer?.stop();
    await rm(path.join(__dirname, ".tmp-mail-dlq"), { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  async function insertFulfilledEvent(payloadOverrides: Record<string, unknown> = {}): Promise<{
    outboxEventId: string;
    aggregateId: string;
  }> {
    const aggregateId = randomUUID();
    const outboxEvent = await withTransaction(pool, async (client) => {
      await insertOutboxEvent(client, {
        aggregateType: "reservation",
        aggregateId,
        eventType: "reservation.fulfilled",
        payload: {
          reservationId: aggregateId,
          customerId: "cust-dlq-test",
          seatIds: [randomUUID()],
          amountCents: 5000,
          ...payloadOverrides,
        },
      });
      const [event] = await findOutboxEventsByAggregateId(client, aggregateId);
      return event;
    });
    await runRelayOnce(pool, publisherChannel);
    return { outboxEventId: outboxEvent.id, aggregateId };
  }

  async function createFulfilledReservation(): Promise<{ reservationId: string; paymentId: string }> {
    const now = Date.now();
    const eventId = await withTransaction(pool, async (client) => {
      const event = await insertEvent(client, {
        name: "DLQ Test Show",
        venue: "Test Hall",
        startsAt: new Date(now + 24 * 60 * 60 * 1000),
        saleStartsAt: new Date(now - 60 * 60 * 1000),
        saleEndsAt: new Date(now + 60 * 60 * 1000),
        capacity: 1,
      });
      await generateSeats(client, event.id, event.capacity);
      return event.id;
    });

    const reservation = await withTransaction(pool, (client) =>
      createReservation(client, { eventId, customerId: "cust-dlq-test", seatCount: 1 }),
    );
    const paymentId = reservation.paymentId!;
    await pool.query("UPDATE payments.payments SET status = 'SUCCEEDED' WHERE id = $1", [paymentId]);
    await settlePaidPayment(pool, { reservationId: reservation.id, paymentId });
    return { reservationId: reservation.id, paymentId };
  }

  // Repeatedly ticks the consumer, sleeping briefly between ticks so
  // RabbitMQ's retry-queue TTLs actually expire and dead-letter back to
  // notify.email — real broker timing, just fast, same "real infra, fast
  // clock" approach M2/M3 used for Postgres timestamps.
  async function drainUntil(
    check: () => Promise<boolean>,
    options: NotifyConsumeOptions = {},
    maxMs = 8000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      await runNotifyConsumeOnce(pool, consumerChannel, mailDir, { backoffMs: TEST_BACKOFF_MS, ...options });
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("drainUntil: condition not met within timeout");
  }

  async function hasProcessedMessage(messageId: string): Promise<boolean> {
    const { rows } = await pool.query(
      "SELECT 1 FROM idem.processed_messages WHERE message_id = $1 AND consumer = 'notify'",
      [messageId],
    );
    return rows.length > 0;
  }

  async function findDlqRowByMessageId(messageId: string | null): Promise<Record<string, unknown> | undefined> {
    const { rows } = messageId
      ? await pool.query(
          "SELECT * FROM dlq.entries WHERE message_id = $1 AND replayed_at IS NULL AND discarded_at IS NULL",
          [messageId],
        )
      : await pool.query(
          "SELECT * FROM dlq.entries WHERE message_id IS NULL ORDER BY created_at DESC LIMIT 1",
        );
    return rows[0];
  }

  it("a transient failure recovers on attempt 3", async () => {
    const { outboxEventId, aggregateId } = await insertFulfilledEvent();
    let callCount = 0;

    const handleEvent = async (event: DomainEventEnvelope) => {
      callCount++;
      if (callCount < 3) {
        throw new Error("simulated transient failure");
      }
      const { writeEmailFile } = await import("../../../modules/notify/src/mailer.js");
      await writeEmailFile(mailDir, event);
    };

    await drainUntil(() => hasProcessedMessage(outboxEventId), { handleEvent });

    expect(callCount).toBe(3);
    const emlPath = path.join(mailDir, `${outboxEventId}.eml`);
    const contents = await readFile(emlPath, "utf8");
    expect(contents).toContain(aggregateId);

    const dlqRow = await findDlqRowByMessageId(outboxEventId);
    expect(dlqRow).toBeUndefined();
  });

  it("a permanently failing handler exhausts all retries, lands in the DLQ, and does not affect the already-fulfilled reservation", async () => {
    const { reservationId } = await createFulfilledReservation();
    await runRelayOnce(pool, publisherChannel);
    const [outboxEvent] = await pool
      .query("SELECT id FROM outbox.events WHERE aggregate_id = $1", [reservationId])
      .then((r) => r.rows);
    const outboxEventId = outboxEvent.id as string;

    let callCount = 0;
    const handleEvent = async () => {
      callCount++;
      throw new Error("simulated permanent failure");
    };

    await drainUntil(async () => Boolean(await findDlqRowByMessageId(outboxEventId)), { handleEvent }, 10_000);

    // 1 original delivery + 5 retries (all 5 backoff tiers used) — see
    // DECISIONS.md for why "max 5 attempts" is read as 5 retries, not 5
    // total, and asserted exactly here rather than with a loose bound.
    expect(callCount).toBe(6);

    const dlqRow = await findDlqRowByMessageId(outboxEventId);
    expect(dlqRow).toBeDefined();
    expect(dlqRow!.attempt_count).toBe(6);
    expect(dlqRow!.source_queue).toBe("notify.email");
    expect(String(dlqRow!.failure_reason)).toContain("simulated permanent failure");

    const { rows: reservationRows } = await pool.query(
      "SELECT state FROM ordering.reservations WHERE id = $1",
      [reservationId],
    );
    expect(reservationRows[0].state).toBe("FULFILLED");
  });

  it("a malformed (non-JSON) message goes straight to the DLQ with no retries", async () => {
    publisherChannel.publish(DOMAIN_EVENTS_EXCHANGE, "reservation.fulfilled", Buffer.from("not valid json{{{"), {
      persistent: true,
    });
    await publisherChannel.waitForConfirms();

    await drainUntil(async () => Boolean(await findDlqRowByMessageId(null)), {}, 3000);

    const dlqRow = await findDlqRowByMessageId(null);
    expect(dlqRow).toBeDefined();
    expect(dlqRow!.message_id).toBeNull();
    expect(dlqRow!.attempt_count).toBe(1);
    expect(String(dlqRow!.failure_reason)).toContain("malformed JSON");
  });

  it("a well-formed envelope with an invalid payload shape goes straight to the DLQ with no retries", async () => {
    const { outboxEventId } = await insertFulfilledEvent({ amountCents: "not-a-number" });

    await drainUntil(async () => Boolean(await findDlqRowByMessageId(outboxEventId)), {}, 3000);

    const dlqRow = await findDlqRowByMessageId(outboxEventId);
    expect(dlqRow).toBeDefined();
    expect(dlqRow!.attempt_count).toBe(1);
    expect(String(dlqRow!.failure_reason)).toContain("validation");
  });

  it("GET /admin/dlq lists unresolved entries with failure reason and attempt count", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/dlq" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; failureReason: string; attemptCount: number }>;
    expect(body.length).toBeGreaterThan(0);
    for (const entry of body) {
      expect(typeof entry.failureReason).toBe("string");
      expect(typeof entry.attemptCount).toBe("number");
    }
  });

  it("replay requeues to the source queue and succeeds once the underlying issue is fixed", async () => {
    const { outboxEventId } = await insertFulfilledEvent();
    const handleEventAlwaysFails = async () => {
      throw new Error("still broken");
    };
    await drainUntil(async () => Boolean(await findDlqRowByMessageId(outboxEventId)), { handleEvent: handleEventAlwaysFails }, 10_000);

    const dlqRow = await findDlqRowByMessageId(outboxEventId);
    expect(dlqRow).toBeDefined();

    const replayRes = await app.inject({ method: "POST", url: `/admin/dlq/${dlqRow!.id}/replay` });
    expect(replayRes.statusCode).toBe(200);

    // Underlying issue is "fixed" now — the default handler (real
    // writeEmailFile) is used instead of the failing one.
    await drainUntil(() => hasProcessedMessage(outboxEventId), {}, 3000);

    const emlPath = path.join(mailDir, `${outboxEventId}.eml`);
    const contents = await readFile(emlPath, "utf8");
    expect(contents.length).toBeGreaterThan(0);

    const { rows } = await pool.query("SELECT replayed_at FROM dlq.entries WHERE id = $1", [dlqRow!.id]);
    expect(rows[0].replayed_at).not.toBeNull();
  });

  it("discard requires a reason and marks the entry resolved without replaying it", async () => {
    publisherChannel.publish(DOMAIN_EVENTS_EXCHANGE, "reservation.fulfilled", Buffer.from("also not json"), {
      persistent: true,
    });
    await publisherChannel.waitForConfirms();
    await drainUntil(async () => (await pool.query("SELECT count(*)::int AS c FROM dlq.entries WHERE message_id IS NULL")).rows[0].c >= 1, {}, 3000);

    const { rows } = await pool.query(
      "SELECT id FROM dlq.entries WHERE message_id IS NULL AND replayed_at IS NULL AND discarded_at IS NULL ORDER BY created_at DESC LIMIT 1",
    );
    const entryId = rows[0].id as string;

    const missingReasonRes = await app.inject({ method: "POST", url: `/admin/dlq/${entryId}/discard`, payload: {} });
    expect(missingReasonRes.statusCode).toBe(400);

    const discardRes = await app.inject({
      method: "POST",
      url: `/admin/dlq/${entryId}/discard`,
      payload: { reason: "known duplicate test data, safe to ignore" },
    });
    expect(discardRes.statusCode).toBe(200);

    const { rows: after } = await pool.query(
      "SELECT discarded_at, discard_reason FROM dlq.entries WHERE id = $1",
      [entryId],
    );
    expect(after[0].discarded_at).not.toBeNull();
    expect(after[0].discard_reason).toBe("known duplicate test data, safe to ignore");
  });
});
