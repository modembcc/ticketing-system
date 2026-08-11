export type ReservationState = "AWAITING_PAYMENT" | "EXPIRED";

export interface Reservation {
  id: string;
  eventId: string;
  customerId: string;
  seatIds: string[];
  state: ReservationState;
  heldUntil: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateReservationInput {
  eventId: string;
  customerId: string;
  seatCount: number;
}
