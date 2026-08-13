import type { ConfirmChannel } from "amqplib";
import type { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { DOMAIN_EVENTS_EXCHANGE } from "../broker/connection.js";
import { claimUnpublishedBatch, markPublished, type OutboxEvent } from "./repository.js";

const RELAY_BATCH_SIZE = 100;

function toMessage(event: OutboxEvent): Buffer {
  return Buffer.from(
    JSON.stringify({
      id: event.id,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.payload,
      createdAt: event.createdAt.toISOString(),
    }),
  );
}

// Claim -> publish -> confirm -> mark, all inside one transaction. Publishing
// on a confirm channel and awaiting waitForConfirms() before marking
// published_at is what makes this safe: without it, channel.publish()
// returning just means "written to the local TCP buffer," not "the broker
// has it" — a dropped connection in between would mark the row published
// while the message never actually landed, silently losing it (the exact
// failure this whole pattern exists to prevent). If the process dies after
// confirms succeed but before the transaction commits, the row is still
// unpublished on restart and gets re-claimed and re-published — a harmless
// duplicate, absorbed downstream by processed_messages.
export async function runRelayOnce(pool: Pool, channel: ConfirmChannel): Promise<number> {
  return withTransaction(pool, async (client) => {
    const batch = await claimUnpublishedBatch(client, RELAY_BATCH_SIZE);
    if (batch.length === 0) return 0;

    for (const event of batch) {
      channel.publish(DOMAIN_EVENTS_EXCHANGE, event.eventType, toMessage(event), {
        persistent: true,
        contentType: "application/json",
      });
    }
    await channel.waitForConfirms();

    await markPublished(
      client,
      batch.map((event) => event.id),
    );
    return batch.length;
  });
}

export function startRelay(pool: Pool, channel: ConfirmChannel, intervalMs: number): () => void {
  const handle = setInterval(() => {
    runRelayOnce(pool, channel).catch((err) => {
      console.error("outbox relay tick failed", err);
    });
  }, intervalMs);

  return () => clearInterval(handle);
}
