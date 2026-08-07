import { describe, expect, it } from "vitest";
import { EventValidationError, validateCreateEventInput } from "./events.service.js";
import type { CreateEventInput } from "./types.js";

function validInput(overrides: Partial<CreateEventInput> = {}): CreateEventInput {
  return {
    name: "Rocket Launch",
    venue: "Cape Canaveral",
    startsAt: new Date("2026-02-01T00:00:00.000Z"),
    saleStartsAt: new Date("2026-01-01T00:00:00.000Z"),
    saleEndsAt: new Date("2026-01-08T00:00:00.000Z"),
    capacity: 100,
    ...overrides,
  };
}

describe("validateCreateEventInput", () => {
  it("accepts a well-formed input", () => {
    expect(() => validateCreateEventInput(validInput())).not.toThrow();
  });

  it("rejects a blank name", () => {
    expect(() => validateCreateEventInput(validInput({ name: "  " }))).toThrow(
      EventValidationError,
    );
  });

  it("rejects non-positive capacity", () => {
    expect(() => validateCreateEventInput(validInput({ capacity: 0 }))).toThrow(
      EventValidationError,
    );
  });

  it("rejects non-integer capacity", () => {
    expect(() => validateCreateEventInput(validInput({ capacity: 1.5 }))).toThrow(
      EventValidationError,
    );
  });

  it("rejects saleStartsAt equal to saleEndsAt", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    expect(() =>
      validateCreateEventInput(validInput({ saleStartsAt: at, saleEndsAt: at })),
    ).toThrow(EventValidationError);
  });

  it("rejects saleStartsAt after saleEndsAt", () => {
    expect(() =>
      validateCreateEventInput(
        validInput({
          saleStartsAt: new Date("2026-01-08T00:00:00.000Z"),
          saleEndsAt: new Date("2026-01-01T00:00:00.000Z"),
        }),
      ),
    ).toThrow(EventValidationError);
  });
});
