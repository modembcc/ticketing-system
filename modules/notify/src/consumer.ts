import type { Channel } from "amqplib";
import type { Pool } from "pg";
import { withTransaction } from "../../../platform/db/withTransaction.js";
import { markMessageProcessed } from "../../../platform/idem/repository.js";
import { writeEmailFile, type DomainEventEnvelope } from "./mailer.js";
import { NOTIFY_QUEUE } from "./topology.js";

const CONSUMER_NAME = "notify";
const NOTIFY_BATCH_SIZE = 100;

// basic.get (poll one message), not basic.consume (long-lived push
// subscription) — fits this project's runXOnce testable-tick convention
// instead of an event-driven callback that's harder to deterministically
// await in a test. Lower throughput than consume at scale, which doesn't
// matter for this lab's pedagogical point (outbox/crash-recovery
// mechanics, not broker throughput).
//
// Bounded like every other runXOnce here (relay caps at 100, sweepers cap
// their batch) rather than draining until empty — an unbounded loop would
// make one tick's runtime unbounded under load, the one way overlapping
// ticks could actually compound (get() itself has no double-claim hazard
// the way a plain SQL read would — the broker hands each message to at most
// one get() call as part of dequeuing it).
export async function runNotifyConsumeOnce(pool: Pool, channel: Channel, mailDir: string): Promise<number> {
  let processed = 0;

  for (let i = 0; i < NOTIFY_BATCH_SIZE; i++) {
    const msg = await channel.get(NOTIFY_QUEUE, { noAck: false });
    if (msg === false) break;

    let event: DomainEventEnvelope;
    try {
      event = JSON.parse(msg.content.toString("utf8"));
    } catch (err) {
      // Malformed payload — not retriable, no amount of redelivery fixes
      // bad JSON. Proper terminal-vs-retriable classification and a DLQ
      // are M6; for now, drop it rather than requeue-loop forever.
      console.error("notify consumer: malformed message, dropping", err);
      channel.ack(msg);
      continue;
    }

    try {
      await withTransaction(pool, async (client) => {
        const firstTime = await markMessageProcessed(client, { messageId: event.id, consumer: CONSUMER_NAME });
        if (firstTime) {
          await writeEmailFile(mailDir, event);
        }
      });
      channel.ack(msg);
      processed++;
    } catch (err) {
      console.error("notify consumer: failed processing message, requeueing", err);
      channel.nack(msg, false, true);
    }
  }

  return processed;
}

export function startNotifyConsumer(pool: Pool, channel: Channel, mailDir: string, intervalMs: number): () => void {
  const handle = setInterval(() => {
    runNotifyConsumeOnce(pool, channel, mailDir).catch((err) => {
      console.error("notify consumer tick failed", err);
    });
  }, intervalMs);

  return () => clearInterval(handle);
}
