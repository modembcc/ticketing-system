export { runNotifyConsumeOnce, startNotifyConsumer } from "./src/consumer.js";
export { composeEmail } from "./src/mailer.js";
export type { DomainEventEnvelope, ReservationFulfilledPayload } from "./src/mailer.js";
export { ensureNotifyQueue, NOTIFY_QUEUE } from "./src/topology.js";
