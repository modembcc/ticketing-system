import type { Channel } from "amqplib";
import { DOMAIN_EVENTS_EXCHANGE } from "../../../platform/broker/connection.js";

export const NOTIFY_QUEUE = "notify.email";
const FULFILLED_ROUTING_KEY = "reservation.fulfilled";

// 1s, 2s, 4s, 8s, 16s — index i is the delay before retry attempt i+1.
// Configurable (not a bare constant) so tests can pass a much shorter
// schedule and get a real end-to-end retry test — genuine RabbitMQ TTL
// expiry and dead-lettering, not mocked — that finishes in under a second.
export const DEFAULT_RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

export function retryQueueName(tier: number): string {
  return `notify.email.retry.${tier}`;
}

const JITTER_RATIO = 0.2; // ±20%

export function withJitter(baseMs: number): number {
  return Math.round(baseMs * (1 + (Math.random() * 2 - 1) * JITTER_RATIO));
}

// Idempotent — safe to call on every process start (or test setup). Must be
// awaited before the relay ever publishes: a topic exchange with no bound
// queue silently drops anything sent to it, and a confirm channel's ack
// only means "the broker accepted it," not "a queue durably has it." If the
// relay starts first, the very first events published are lost with no
// trace despite being marked published_at, which is exactly the failure
// the outbox pattern exists to prevent — just moved one layer up.
//
// Retry queues carry NO queue-level x-message-ttl. The spec requires
// backoff *with jitter*, but assertQueue throws PRECONDITION_FAILED if a
// queue already exists with different `arguments` than last time — since
// this function must stay safe to call on every restart, a fixed
// queue-level TTL could never vary per message without breaking that.
// Instead each queue only carries the dead-letter routing (fixed, safe to
// redeclare identically forever), and the actual delay is set per-message
// via the `expiration` property at publish time (see consumer.ts), jittered
// there. That reopens a narrower version of the exact head-of-queue hazard
// per-message TTL always has (a queue only expires messages at its head, so
// a shorter-TTL message queued behind a longer-TTL one waits) — but bounded
// to ±20% of one tier's delay, not the ~16x skew a shared queue across all
// five tiers would have risked.
export async function ensureNotifyQueue(
  channel: Channel,
  backoffMs: number[] = DEFAULT_RETRY_BACKOFF_MS,
): Promise<{ queue: string; maxRetries: number }> {
  await channel.assertQueue(NOTIFY_QUEUE, { durable: true });
  await channel.bindQueue(NOTIFY_QUEUE, DOMAIN_EVENTS_EXCHANGE, FULFILLED_ROUTING_KEY);

  for (let tier = 1; tier <= backoffMs.length; tier++) {
    await channel.assertQueue(retryQueueName(tier), {
      durable: true,
      arguments: {
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": NOTIFY_QUEUE,
      },
    });
  }

  return { queue: NOTIFY_QUEUE, maxRetries: backoffMs.length };
}
