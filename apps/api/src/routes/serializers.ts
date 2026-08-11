import type { Event } from "../../../../modules/catalog/index.js";
import type { Reservation } from "../../../../modules/ordering/index.js";

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
    createdAt: reservation.createdAt.toISOString(),
    updatedAt: reservation.updatedAt.toISOString(),
  };
}
