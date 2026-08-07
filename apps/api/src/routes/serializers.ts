import type { Event } from "../../../../modules/catalog/index.js";

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
