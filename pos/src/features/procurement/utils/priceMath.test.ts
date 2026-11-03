import { describe, expect, it } from "vitest";
import {
  formatPercent,
  percentChange,
  perUnitPrice,
  priceDirection,
} from "./priceMath";

describe("percentChange", () => {
  it("computes a positive change", () => {
    expect(percentChange(120, 100)).toBe(20);
  });

  it("computes a negative change", () => {
    expect(percentChange(105, 120)).toBeCloseTo(-12.5, 2);
  });

  it("rounds to two decimals", () => {
    expect(percentChange(110, 90)).toBe(22.22);
  });

  it("returns null for a zero previous price", () => {
    expect(percentChange(50, 0)).toBeNull();
  });

  it("returns null for missing values", () => {
    expect(percentChange(null, 100)).toBeNull();
    expect(percentChange(100, null)).toBeNull();
    expect(percentChange(undefined, undefined)).toBeNull();
  });
});

describe("formatPercent", () => {
  it("formats increases with a plus sign", () => {
    expect(formatPercent(20)).toBe("+20.00%");
    expect(formatPercent(22.22)).toBe("+22.22%");
  });

  it("formats decreases with a minus sign", () => {
    expect(formatPercent(-4.5)).toBe("−4.50%");
  });

  it("formats zero without a sign", () => {
    expect(formatPercent(0)).toBe("0.00%");
  });

  it("returns an em dash for missing values", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(undefined)).toBe("—");
  });
});

describe("priceDirection", () => {
  it("classifies up, down, and flat", () => {
    expect(priceDirection(10)).toBe("up");
    expect(priceDirection(-1)).toBe("down");
    expect(priceDirection(0)).toBe("flat");
    expect(priceDirection(null)).toBe("flat");
  });
});

describe("perUnitPrice", () => {
  it("normalizes a packaged quotation to per-unit", () => {
    expect(perUnitPrice(1500, 25)).toBe(60);
    expect(perUnitPrice(450, 5)).toBe(90);
  });

  it("rounds to two decimals", () => {
    expect(perUnitPrice(100, 3)).toBe(33.33);
  });

  it("returns null when the quote is already per unit", () => {
    expect(perUnitPrice(100, null)).toBeNull();
    expect(perUnitPrice(100, undefined)).toBeNull();
  });

  it("returns null for invalid input", () => {
    expect(perUnitPrice(null, 25)).toBeNull();
    expect(perUnitPrice(1500, 0)).toBeNull();
    expect(perUnitPrice(1500, -5)).toBeNull();
  });
});
