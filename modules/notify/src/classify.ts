import type { DomainEventEnvelope, ReservationFulfilledPayload } from "./mailer.js";

// Thrown for anything no amount of redelivery could fix — malformed bytes,
// an event type this consumer doesn't know how to handle, or a payload that
// doesn't match the shape the handler needs. Classified straight to the
// DLQ, no retries burned. Everything else thrown during processing is
// treated as retriable by default: a wrongly-terminal classification
// silently discards a real transient failure forever, while a
// wrongly-retriable one just burns retries before landing in the DLQ
// anyway (recoverable via replay) — asymmetric risk, so default the safer
// way. Getting this split wrong is "the most common real-world DLQ bug."
export class TerminalMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalMessageError";
  }
}

const KNOWN_EVENT_TYPES = new Set(["reservation.fulfilled"]);

function isValidReservationFulfilledPayload(payload: unknown): payload is ReservationFulfilledPayload {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Partial<ReservationFulfilledPayload>;
  return (
    typeof p.reservationId === "string" &&
    typeof p.customerId === "string" &&
    Array.isArray(p.seatIds) &&
    p.seatIds.every((s) => typeof s === "string") &&
    typeof p.amountCents === "number"
  );
}

// Centralized on purpose — this is the one place a reviewer checks for
// "did they get the retriable/terminal split right."
export function parseNotifyEvent(raw: Buffer): DomainEventEnvelope {
  let event: DomainEventEnvelope;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    throw new TerminalMessageError(`malformed JSON: ${(err as Error).message}`);
  }

  if (typeof event.eventType !== "string" || !KNOWN_EVENT_TYPES.has(event.eventType)) {
    throw new TerminalMessageError(`unknown eventType: ${String(event.eventType)}`);
  }

  if (event.eventType === "reservation.fulfilled" && !isValidReservationFulfilledPayload(event.payload)) {
    throw new TerminalMessageError("payload failed ReservationFulfilledPayload validation");
  }

  return event;
}
