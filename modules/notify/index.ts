export { TerminalMessageError, parseNotifyEvent } from "./src/classify.js";
export { runNotifyConsumeOnce, startNotifyConsumer } from "./src/consumer.js";
export type { NotifyConsumeOptions } from "./src/consumer.js";
export { composeEmail } from "./src/mailer.js";
export type { DomainEventEnvelope, ReservationFulfilledPayload } from "./src/mailer.js";
export {
  DEFAULT_RETRY_BACKOFF_MS,
  ensureNotifyQueue,
  NOTIFY_QUEUE,
  retryQueueName,
  withJitter,
} from "./src/topology.js";
