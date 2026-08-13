import type { Channel } from "amqplib";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../../../platform/db/withTransaction.js";
import { markMessageProcessed } from "../../../platform/idem/repository.js";
import { insertDlqEntry } from "../../../platform/dlq/repository.js";
import { TerminalMessageError, parseNotifyEvent } from "./classify.js";
import { writeEmailFile, type DomainEventEnvelope } from "./mailer.js";
import { DEFAULT_RETRY_BACKOFF_MS, NOTIFY_QUEUE, retryQueueName, withJitter } from "./topology.js";

const CONSUMER_NAME = "notify";
const NOTIFY_BATCH_SIZE = 100;

export interface NotifyConsumeOptions {
  // Must match whatever was passed to ensureNotifyQueue — this is what
  // decides which retry tier to publish to and when a failure has
  // exhausted its retries. Also lets tests use a short schedule (e.g.
  // [50, 100, 150]) and get a real end-to-end retry test — genuine
  // RabbitMQ TTL expiry, not mocked — in well under a second.
  backoffMs?: number[];
  // Overrides the actual side effect (writing the email) after the
  // idempotency check. Default is the real writeEmailFile. Tests use this
  // to simulate "some downstream dependency was down and later recovered"
  // as *external, mutable* state — not a flag baked into the message
  // payload, which would make "DLQ due to genuine exhaustion, then replay
  // succeeds because the underlying issue was fixed" impossible to express
  // (a replayed message is byte-identical to what's stored, so a
  // payload-embedded flag would fail identically every time).
  handleEvent?: (event: DomainEventEnvelope, client: PoolClient) => Promise<void>;
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function tryParseJsonLoosely(raw: string): { id?: unknown; payload?: unknown } | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// basic.get (poll one message), not basic.consume (long-lived push
// subscription) — fits this project's runXOnce testable-tick convention
// instead of an event-driven callback that's harder to deterministically
// await in a test. Lower throughput than consume at scale, which doesn't
// matter for this lab's pedagogical point.
//
// Bounded like every other runXOnce here rather than draining until empty —
// an unbounded loop would make one tick's runtime unbounded under load.
export async function runNotifyConsumeOnce(
  pool: Pool,
  channel: Channel,
  mailDir: string,
  options: NotifyConsumeOptions = {},
): Promise<number> {
  const backoffMs = options.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const maxRetries = backoffMs.length;
  const handleEvent =
    options.handleEvent ?? (async (event: DomainEventEnvelope) => void (await writeEmailFile(mailDir, event)));

  let processed = 0;

  for (let i = 0; i < NOTIFY_BATCH_SIZE; i++) {
    const msg = await channel.get(NOTIFY_QUEUE, { noAck: false });
    if (msg === false) break;

    // Prior retries this exact delivery has already been through — 0 on
    // the message's first-ever delivery. This delivery is attempt N+1.
    const priorRetryCount = (msg.properties.headers?.["x-retry-count"] as number | undefined) ?? 0;
    const currentAttempt = priorRetryCount + 1;
    const rawContent = msg.content.toString("utf8");
    const loose = tryParseJsonLoosely(rawContent);

    let event: DomainEventEnvelope | undefined;
    let failure: unknown;
    try {
      event = parseNotifyEvent(msg.content);
      await withTransaction(pool, async (client) => {
        const firstTime = await markMessageProcessed(client, { messageId: event!.id, consumer: CONSUMER_NAME });
        if (firstTime) {
          await handleEvent(event!, client);
        }
      });
    } catch (err) {
      failure = err;
    }

    if (failure === undefined) {
      channel.ack(msg);
      processed++;
      continue;
    }

    const isTerminal = failure instanceof TerminalMessageError;
    const messageId = event?.id ?? (typeof loose?.id === "string" ? loose.id : null);
    const payloadForDlq = event?.payload ?? loose?.payload ?? null;

    if (isTerminal || priorRetryCount >= maxRetries) {
      await withTransaction(pool, (client) =>
        insertDlqEntry(client, {
          sourceQueue: NOTIFY_QUEUE,
          consumer: CONSUMER_NAME,
          messageId,
          rawContent,
          payload: payloadForDlq,
          failureReason: describeError(failure),
          attemptCount: currentAttempt,
          brokerHeaders: msg.properties.headers ?? null,
        }),
      );
      channel.ack(msg);
      // Alert on every DLQ arrival — log at ERROR is enough for this lab.
      console.error(
        `notify consumer: message ${messageId ?? "(unparseable)"} sent to DLQ after ${currentAttempt} attempt(s) — ${describeError(failure)}`,
      );
      continue;
    }

    // Retriable, and retries remain: republish to the next backoff tier
    // BEFORE acking the original — acking first and then crashing before
    // the republish would lose the message entirely, the same reasoning
    // that put waitForConfirms() before markPublished in the relay.
    const nextRetryCount = priorRetryCount + 1;
    const delayMs = withJitter(backoffMs[nextRetryCount - 1]);
    channel.sendToQueue(retryQueueName(nextRetryCount), msg.content, {
      persistent: true,
      expiration: String(delayMs),
      // Spread the original headers forward — a fresh {} here would
      // silently drop any x-death history RabbitMQ already attached from
      // earlier retry-tier hops, along with anything else riding along.
      headers: { ...msg.properties.headers, "x-retry-count": nextRetryCount },
    });
    channel.ack(msg);
    console.warn(
      `notify consumer: message ${messageId ?? "(unknown)"} failed on attempt ${currentAttempt}, retrying in ~${delayMs}ms — ${describeError(failure)}`,
    );
  }

  return processed;
}

export function startNotifyConsumer(
  pool: Pool,
  channel: Channel,
  mailDir: string,
  intervalMs: number,
  options: NotifyConsumeOptions = {},
): () => void {
  const handle = setInterval(() => {
    runNotifyConsumeOnce(pool, channel, mailDir, options).catch((err) => {
      console.error("notify consumer tick failed", err);
    });
  }, intervalMs);

  return () => clearInterval(handle);
}
