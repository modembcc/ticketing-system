import type { CreateEventInput } from "./types.js";

export class EventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventValidationError";
  }
}

export function validateCreateEventInput(input: CreateEventInput): void {
  if (!input.name.trim()) {
    throw new EventValidationError("name is required");
  }
  if (!input.venue.trim()) {
    throw new EventValidationError("venue is required");
  }
  if (Number.isNaN(input.startsAt.getTime())) {
    throw new EventValidationError("startsAt is not a valid date");
  }
  if (Number.isNaN(input.saleStartsAt.getTime())) {
    throw new EventValidationError("saleStartsAt is not a valid date");
  }
  if (Number.isNaN(input.saleEndsAt.getTime())) {
    throw new EventValidationError("saleEndsAt is not a valid date");
  }
  if (!Number.isInteger(input.capacity) || input.capacity <= 0) {
    throw new EventValidationError("capacity must be a positive integer");
  }
  if (input.saleStartsAt.getTime() >= input.saleEndsAt.getTime()) {
    throw new EventValidationError("saleStartsAt must be before saleEndsAt");
  }
}
