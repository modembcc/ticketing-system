import type { Event } from "../../../../modules/catalog/index.js";
import type { Reservation } from "../../../../modules/ordering/index.js";
import type { Payment } from "../../../../modules/payments/index.js";
import type { DlqEntry } from "../../../../platform/dlq/repository.js";

export function serializeEvent(event: Event, availableSeats: number) {
  return {
    id: event.id,
    name: event.name,
    venue: event.venue,
    startsAt: event.startsAt.toISOString(),
    saleStartsAt: event.saleStartsAt.toISOString(),
    saleEndsAt: event.saleEndsAt.toISOString(),
    capacity: event.capacity,
    availableSeats,
    createdAt: event.createdAt.toISOString(),
  };
}

export function serializeReservation(reservation: Reservation) {
  return {
    id: reservation.id,
    eventId: reservation.eventId,
    customerId: reservation.customerId,
    seatIds: reservation.seatIds,
    state: reservation.state,
    heldUntil: reservation.heldUntil.toISOString(),
    paymentId: reservation.paymentId,
    amountCents: reservation.amountCents,
    createdAt: reservation.createdAt.toISOString(),
    updatedAt: reservation.updatedAt.toISOString(),
  };
}

export function serializePayment(payment: Payment) {
  return {
    id: payment.id,
    reservationId: payment.reservationId,
    status: payment.status,
    amountCents: payment.amountCents,
    providerRef: payment.providerRef,
    confirmedAt: payment.confirmedAt ? payment.confirmedAt.toISOString() : null,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
  };
}

export function serializeDlqEntry(entry: DlqEntry) {
  return {
    id: entry.id,
    sourceQueue: entry.sourceQueue,
    consumer: entry.consumer,
    messageId: entry.messageId,
    payload: entry.payload,
    failureReason: entry.failureReason,
    attemptCount: entry.attemptCount,
    brokerHeaders: entry.brokerHeaders,
    createdAt: entry.createdAt.toISOString(),
    replayedAt: entry.replayedAt ? entry.replayedAt.toISOString() : null,
    discardedAt: entry.discardedAt ? entry.discardedAt.toISOString() : null,
    discardReason: entry.discardReason,
  };
}
