// No pricing tiers (anti-goal) — a flat placeholder rate exists only so
// amount_cents carries a real number through the saga. Not a pricing feature.
export const PRICE_PER_SEAT_CENTS = 5000;

export function calculateAmountCents(seatCount: number): number {
  return seatCount * PRICE_PER_SEAT_CENTS;
}
