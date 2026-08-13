import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { findEventById, isSaleWindowOpen, saleWindowStatus } from "../../catalog/index.js";
import { holdSeatsForEvent } from "../../inventory/index.js";
import { confirmPayment, createPaymentIntent, findPaymentById, PaymentNotFoundError } from "../../payments/index.js";
import {
  EventNotFoundError,
  ReservationNotAwaitingPaymentError,
  ReservationValidationError,
  SaleWindowClosedError,
  SeatsUnavailableError,
} from "./errors.js";
import { calculateAmountCents } from "./pricing.js";
import { attachPayment, findReservationById, insertReservation } from "./reservations.repository.js";
import type { CreateReservationInput, Reservation } from "./types.js";

const HOLD_DURATION_MS = 5 * 60 * 1000;

function validateCreateReservationInput(input: CreateReservationInput): void {
  if (!input.customerId.trim()) {
    throw new ReservationValidationError("customerId is required");
  }
  if (!Number.isInteger(input.seatCount) || input.seatCount <= 0) {
    throw new ReservationValidationError("seatCount must be a positive integer");
  }
}

// Takes an already-open transaction client rather than a Pool: the caller
// (the idempotency wrapper, for the real route) owns the transaction so the
// idempotency-key bookkeeping and this work commit or roll back together —
// "insert the PENDING row in the same transaction as the work" only holds if
// this function doesn't open its own separate transaction.
export async function createReservation(client: PoolClient, input: CreateReservationInput): Promise<Reservation> {
  validateCreateReservationInput(input);

  const event = await findEventById(client, input.eventId);
  if (!event) {
    throw new EventNotFoundError(input.eventId);
  }

  const now = new Date();
  const status = saleWindowStatus(event, now);
  if (!isSaleWindowOpen(event, now)) {
    throw new SaleWindowClosedError(status as "BEFORE_SALE_START" | "AFTER_SALE_END");
  }

  const reservationId = randomUUID();
  const heldUntil = new Date(now.getTime() + HOLD_DURATION_MS);

  const held = await holdSeatsForEvent(client, {
    eventId: input.eventId,
    count: input.seatCount,
    holdId: reservationId,
    heldUntil,
  });

  if (held.length !== input.seatCount) {
    throw new SeatsUnavailableError(input.seatCount, held.length);
  }

  // Reservation must exist before the payment row can FK to it, so intent
  // creation is a deliberate follow-up statement, not part of one INSERT.
  // Both happen in this same transaction, so a failure at either step
  // rolls back the seat hold too — the "compensation" for these two
  // compensatable saga steps is just a plain rollback, nothing fancier.
  await insertReservation(client, {
    id: reservationId,
    eventId: input.eventId,
    customerId: input.customerId,
    seatIds: held.map((seat) => seat.id).sort(),
    heldUntil,
  });

  const amountCents = calculateAmountCents(input.seatCount);
  const payment = await createPaymentIntent(client, { reservationId, amountCents });

  return attachPayment(client, { reservationId, paymentId: payment.id, amountCents });
}

// Customer submits payment ("confirm" — this is what starts the fake
// gateway's async processing; createReservation only opened the intent).
// Rejects confirming a reservation that isn't waiting on payment anymore
// (already expired, already settled) rather than letting the customer pay
// into a dead reservation. Same client-not-pool reasoning as above.
export async function confirmReservationPayment(client: PoolClient, paymentId: string): Promise<Reservation> {
  const payment = await findPaymentById(client, paymentId);
  if (!payment) {
    throw new PaymentNotFoundError(paymentId);
  }

  const reservation = await findReservationById(client, payment.reservationId);
  if (!reservation || reservation.state !== "AWAITING_PAYMENT") {
    throw new ReservationNotAwaitingPaymentError(payment.reservationId);
  }

  await confirmPayment(client, paymentId);
  return reservation;
}
