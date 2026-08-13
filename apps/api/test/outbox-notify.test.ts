import { randomUUID } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RabbitMQContainer, type StartedRabbitMQContainer } from "@testcontainers/rabbitmq";
import { Pool } from "pg";
import type { ConfirmChannel, Channel } from "amqplib";
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
import { ensureNotifyQueue, runNotifyConsumeOnce } from "../../../modules/notify/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("outbox + notify", () => {
  let postgresContainer: StartedPostgreSqlContainer;
  let rabbitContainer: StartedRabbitMQContainer;
  let pool: Pool;
  let publisherChannel: ConfirmChannel;
  let consumerChannel: Channel;
  let mailDir: string;

  beforeAll(async () => {
    [postgresContainer, rabbitContainer] = await Promise.all([
      new PostgreSqlContainer("postgres:16-alpine").start(),
      // Generous startup timeout: this file's RabbitMQ container competes
      // for CPU/IO with every other test file's own Postgres container
      // starting in parallel, and RabbitMQ's normal ~15-20s boot can blow
      // past testcontainers' 30s default log-wait under that load.
      new RabbitMQContainer("rabbitmq:3.13-management-alpine").withStartupTimeout(120_000).start(),
    ]);
    await runMigrations(postgresContainer.getConnectionUri());
    pool = new Pool({ connectionString: postgresContainer.getConnectionUri() });

    publisherChannel = await createPublisherChannel(rabbitContainer.getAmqpUrl());
    consumerChannel = await createConsumerChannel(rabbitContainer.getAmqpUrl());
    // Must exist before anything publishes — see DECISIONS.md.
    await ensureNotifyQueue(consumerChannel);

    mailDir = path.join(__dirname, ".tmp-mail", randomUUID());
  }, 150_000);

  afterAll(async () => {
    // Guarded per-step: if beforeAll failed partway (e.g. a container
    // startup timeout), some of these were never assigned — don't let a
    // teardown TypeError mask the real beforeAll failure.
    await closeBrokerConnection().catch(() => {});
    await pool?.end();
    await postgresContainer?.stop();
    await rabbitContainer?.stop();
    await rm(path.join(__dirname, ".tmp-mail"), { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  async function insertFulfilledEvent(aggregateId = randomUUID()): Promise<{ id: string; aggregateId: string }> {
    const outboxEvent = await withTransaction(pool, async (client) => {
      await insertOutboxEvent(client, {
        aggregateType: "reservation",
        aggregateId,
        eventType: "reservation.fulfilled",
        payload: {
          reservationId: aggregateId,
          customerId: "cust-test",
          seatIds: [randomUUID()],
          amountCents: 5000,
        },
      });
      const [event] = await findOutboxEventsByAggregateId(client, aggregateId);
      return event;
    });
    return { id: outboxEvent.id, aggregateId };
  }

  it("relay claims unpublished events, publishes them, and marks published_at", async () => {
    const a = await insertFulfilledEvent();
    const b = await insertFulfilledEvent();

    const publishedCount = await runRelayOnce(pool, publisherChannel);
    expect(publishedCount).toBeGreaterThanOrEqual(2);

    const [eventA] = await findOutboxEventsByAggregateId(pool, a.aggregateId);
    const [eventB] = await findOutboxEventsByAggregateId(pool, b.aggregateId);
    expect(eventA.publishedAt).not.toBeNull();
    expect(eventB.publishedAt).not.toBeNull();

    // Drain what the relay just published so it doesn't leak into other tests.
    await runNotifyConsumeOnce(pool, consumerChannel, mailDir);
  });

  it("leaves already-published events alone on a second relay tick", async () => {
    const before = await insertFulfilledEvent();
    await runRelayOnce(pool, publisherChannel);
    const [publishedOnce] = await findOutboxEventsByAggregateId(pool, before.aggregateId);

    const secondTickCount = await runRelayOnce(pool, publisherChannel);
    const [stillPublished] = await findOutboxEventsByAggregateId(pool, before.aggregateId);

    expect(stillPublished.publishedAt).toEqual(publishedOnce.publishedAt);
    // Tests in this file run sequentially against one container, so by now
    // the only row that could be unpublished is this test's own — and it
    // was already claimed by the first tick above.
    expect(secondTickCount).toBe(0);

    await runNotifyConsumeOnce(pool, consumerChannel, mailDir);
  });

  it("notify consumer writes a .eml file and dedupes a redelivered message", async () => {
    const { aggregateId } = await insertFulfilledEvent();
    await runRelayOnce(pool, publisherChannel);

    const processed = await runNotifyConsumeOnce(pool, consumerChannel, mailDir);
    expect(processed).toBeGreaterThanOrEqual(1);

    const files = await readdir(mailDir);
    const matching = files.filter((f) => f.endsWith(".eml"));
    expect(matching.length).toBeGreaterThanOrEqual(1);

    const [outboxEvent] = await findOutboxEventsByAggregateId(pool, aggregateId);
    const emlPath = path.join(mailDir, `${outboxEvent.id}.eml`);
    const contents = await readFile(emlPath, "utf8");
    expect(contents).toContain(aggregateId);
    expect(contents).toContain("Subject: Your reservation is confirmed");

    const { rows } = await pool.query(
      "SELECT count(*)::int AS count FROM idem.processed_messages WHERE message_id = $1 AND consumer = 'notify'",
      [outboxEvent.id],
    );
    expect(rows[0].count).toBe(1);

    // Simulate an at-least-once redelivery of the exact same message
    // (e.g. relay re-publishing after a crash before markPublished
    // committed) by publishing the identical envelope again directly.
    publisherChannel.publish(
      DOMAIN_EVENTS_EXCHANGE,
      "reservation.fulfilled",
      Buffer.from(
        JSON.stringify({
          id: outboxEvent.id,
          aggregateType: outboxEvent.aggregateType,
          aggregateId: outboxEvent.aggregateId,
          eventType: outboxEvent.eventType,
          payload: outboxEvent.payload,
          createdAt: outboxEvent.createdAt.toISOString(),
        }),
      ),
      { persistent: true, contentType: "application/json" },
    );
    await publisherChannel.waitForConfirms();

    const filesBefore = await readdir(mailDir);
    await runNotifyConsumeOnce(pool, consumerChannel, mailDir);
    const filesAfter = await readdir(mailDir);

    // The duplicate is ack'd (no infinite redelivery loop) but does not
    // write a second file or a second processed_messages row.
    expect(filesAfter.length).toBe(filesBefore.length);
    const { rows: afterRows } = await pool.query(
      "SELECT count(*)::int AS count FROM idem.processed_messages WHERE message_id = $1 AND consumer = 'notify'",
      [outboxEvent.id],
    );
    expect(afterRows[0].count).toBe(1);
  });

  it("survives the app dying between commit and publish: a fresh relay tick still delivers the email", async () => {
    const scriptPath = path.join(__dirname, "fixtures", "crash-before-publish.ts");
    const result = spawnSync(process.execPath, ["--import", "tsx/esm", scriptPath], {
      env: { ...process.env, DATABASE_URL: postgresContainer.getConnectionUri() },
      encoding: "utf8",
    });

    // The fixture deliberately calls process.exit(1) right after committing
    // the fulfillment (and its outbox row) — never touching the relay or
    // RabbitMQ. A non-zero, specifically-1 exit confirms it reached that
    // line rather than crashing somewhere else for an unrelated reason.
    expect(result.status).toBe(1);

    const sentinel = result.stdout.split("\n").find((line) => line.startsWith("RESERVATION_ID="));
    expect(sentinel).toBeDefined();
    const reservationId = sentinel!.slice("RESERVATION_ID=".length).trim();

    // Proof the event survived the "crash" durably, before anything has
    // tried to recover it.
    const [eventBeforeRecovery] = await findOutboxEventsByAggregateId(pool, reservationId);
    expect(eventBeforeRecovery).toBeDefined();
    expect(eventBeforeRecovery.publishedAt).toBeNull();

    const { rows: reservationRows } = await pool.query(
      "SELECT state FROM ordering.reservations WHERE id = $1",
      [reservationId],
    );
    expect(reservationRows[0].state).toBe("FULFILLED");

    // "App restarts": a fresh relay tick, in this (the parent) process,
    // finds and publishes the leftover row.
    const publishedCount = await runRelayOnce(pool, publisherChannel);
    expect(publishedCount).toBeGreaterThanOrEqual(1);

    const [eventAfterRelay] = await findOutboxEventsByAggregateId(pool, reservationId);
    expect(eventAfterRelay.publishedAt).not.toBeNull();

    const consumedCount = await runNotifyConsumeOnce(pool, consumerChannel, mailDir);
    expect(consumedCount).toBeGreaterThanOrEqual(1);

    const emlPath = path.join(mailDir, `${eventAfterRelay.id}.eml`);
    const contents = await readFile(emlPath, "utf8");
    expect(contents).toContain(reservationId);
  }, 60_000);
});
