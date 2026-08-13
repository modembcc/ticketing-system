import type { Channel } from "amqplib";
import { DOMAIN_EVENTS_EXCHANGE } from "../../../platform/broker/connection.js";

export const NOTIFY_QUEUE = "notify.email";
const FULFILLED_ROUTING_KEY = "reservation.fulfilled";

// Idempotent — safe to call on every process start (or test setup). Must be
// awaited before the relay ever publishes: a topic exchange with no bound
// queue silently drops anything sent to it, and a confirm channel's ack
// only means "the broker accepted it," not "a queue durably has it." If the
// relay starts first, the very first events published are lost with no
// trace despite being marked published_at, which is exactly the failure
// the outbox pattern exists to prevent — just moved one layer up.
export async function ensureNotifyQueue(channel: Channel): Promise<{ queue: string }> {
  await channel.assertQueue(NOTIFY_QUEUE, { durable: true });
  await channel.bindQueue(NOTIFY_QUEUE, DOMAIN_EVENTS_EXCHANGE, FULFILLED_ROUTING_KEY);
  return { queue: NOTIFY_QUEUE };
}
