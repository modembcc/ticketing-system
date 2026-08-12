export type ReservationState =
  | "AWAITING_PAYMENT"
  | "PAID"
  | "FAILED"
  | "EXPIRED"
  | "FULFILLED"
  | "REFUNDING"
  | "REFUNDED";

export interface Reservation {
  id: string;
  eventId: string;
  customerId: string;
  seatIds: string[];
  state: ReservationState;
  heldUntil: Date;
  paymentId: string | null;
  amountCents: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateReservationInput {
  eventId: string;
  customerId: string;
  seatCount: number;
}

export interface Ticket {
  id: string;
  reservationId: string;
  seatId: string;
  customerId: string;
  issuedAt: Date;
  qrToken: string;
}
