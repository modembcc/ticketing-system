import type { Event } from "./types.js";

export type SaleWindowStatus = "BEFORE_SALE_START" | "OPEN" | "AFTER_SALE_END";

type WindowFields = Pick<Event, "saleStartsAt" | "saleEndsAt">;

// Window gates reservation *creation*, not fulfilment — a reservation made
// a second before sale_ends_at is allowed to finish paying after close.
// Both ends are inclusive: exactly at sale_starts_at or sale_ends_at is OPEN.
export function saleWindowStatus(event: WindowFields, now: Date): SaleWindowStatus {
  if (now.getTime() < event.saleStartsAt.getTime()) return "BEFORE_SALE_START";
  if (now.getTime() > event.saleEndsAt.getTime()) return "AFTER_SALE_END";
  return "OPEN";
}

export function isSaleWindowOpen(event: WindowFields, now: Date): boolean {
  return saleWindowStatus(event, now) === "OPEN";
}
