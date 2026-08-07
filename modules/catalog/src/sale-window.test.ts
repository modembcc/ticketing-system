import { describe, expect, it } from "vitest";
import { isSaleWindowOpen, saleWindowStatus } from "./sale-window.js";

const window = {
  saleStartsAt: new Date("2026-01-01T00:00:00.000Z"),
  saleEndsAt: new Date("2026-01-08T00:00:00.000Z"),
};

describe("saleWindowStatus", () => {
  it("is BEFORE_SALE_START strictly before sale_starts_at", () => {
    const now = new Date(window.saleStartsAt.getTime() - 1);
    expect(saleWindowStatus(window, now)).toBe("BEFORE_SALE_START");
    expect(isSaleWindowOpen(window, now)).toBe(false);
  });

  it("is OPEN exactly at sale_starts_at (inclusive)", () => {
    const now = new Date(window.saleStartsAt.getTime());
    expect(saleWindowStatus(window, now)).toBe("OPEN");
    expect(isSaleWindowOpen(window, now)).toBe(true);
  });

  it("is OPEN in the middle of the window", () => {
    const now = new Date((window.saleStartsAt.getTime() + window.saleEndsAt.getTime()) / 2);
    expect(saleWindowStatus(window, now)).toBe("OPEN");
    expect(isSaleWindowOpen(window, now)).toBe(true);
  });

  it("is OPEN exactly at sale_ends_at (inclusive)", () => {
    const now = new Date(window.saleEndsAt.getTime());
    expect(saleWindowStatus(window, now)).toBe("OPEN");
    expect(isSaleWindowOpen(window, now)).toBe(true);
  });

  it("is AFTER_SALE_END strictly after sale_ends_at", () => {
    const now = new Date(window.saleEndsAt.getTime() + 1);
    expect(saleWindowStatus(window, now)).toBe("AFTER_SALE_END");
    expect(isSaleWindowOpen(window, now)).toBe(false);
  });
});
