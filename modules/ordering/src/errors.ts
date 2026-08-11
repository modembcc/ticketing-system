import type { SaleWindowStatus } from "../../catalog/index.js";

export class ReservationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReservationValidationError";
  }
}

export class EventNotFoundError extends Error {
  constructor(eventId: string) {
    super(`event ${eventId} not found`);
    this.name = "EventNotFoundError";
  }
}

export class SaleWindowClosedError extends Error {
  readonly reason: Extract<SaleWindowStatus, "BEFORE_SALE_START" | "AFTER_SALE_END">;

  constructor(reason: Extract<SaleWindowStatus, "BEFORE_SALE_START" | "AFTER_SALE_END">) {
    super(
      reason === "BEFORE_SALE_START"
        ? "sale has not started yet"
        : "sale has already ended",
    );
    this.name = "SaleWindowClosedError";
    this.reason = reason;
  }
}

export class SeatsUnavailableError extends Error {
  constructor(requested: number, held: number) {
    super(`requested ${requested} seat(s), only ${held} available`);
    this.name = "SeatsUnavailableError";
  }
}
