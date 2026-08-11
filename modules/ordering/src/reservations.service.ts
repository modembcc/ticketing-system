import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { findEventById, isSaleWindowOpen, saleWindowStatus } from "../../catalog/index.js";
import { holdSeatsForEvent } from "../../inventory/index.js";
import { withTransaction } from "../../../platform/db/withTransaction.js";
import {
  EventNotFoundError,
  ReservationValidationError,
  SaleWindowClosedError,
  SeatsUnavailableError,
} from "./errors.js";
import { insertReservation } from "./reservations.repository.js";
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

export async function createReservation(pool: Pool, input: CreateReservationInput): Promise<Reservation> {
  validateCreateReservationInput(input);

  return withTransaction(pool, async (client) => {
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

    return insertReservation(client, {
      id: reservationId,
      eventId: input.eventId,
      customerId: input.customerId,
      seatIds: held.map((seat) => seat.id).sort(),
      heldUntil,
    });
  });
}
