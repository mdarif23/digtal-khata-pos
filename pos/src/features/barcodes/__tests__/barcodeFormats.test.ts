import { describe, expect, it } from "vitest";
import {
  detectBarcodeFormat,
  gtinCheckDigit,
  gtinCheckDigitIsValid,
  validateBarcode,
} from "../barcodeFormats.js";

describe("barcode validation (client mirror of backend rules)", () => {
  it("computes GS1 mod-10 check digits", () => {
    // EAN-13 400638133393 + check digit 1
    expect(gtinCheckDigit("400638133393")).toBe(1);
    expect(gtinCheckDigitIsValid("4006381333931")).toBe(true);
    expect(gtinCheckDigitIsValid("4006381333932")).toBe(false);
  });

  it("validates EAN-13/EAN-8/UPC-A lengths and check digits", () => {
    expect(validateBarcode("4006381333931").format).toBe("ean13");
    expect(validateBarcode("96385074").format).toBe("ean8");
    expect(validateBarcode("036000291452").format).toBe("upca");

    const bad = validateBarcode("4006381333932");
    expect(bad.valid).toBe(false);
    expect(bad.error).toMatch(/check digit/i);

    const short = validateBarcode("400638133393", "ean13");
    expect(short.valid).toBe(false);
    expect(short.error).toMatch(/exactly 13/);
  });

  it("detects formats and falls back to CODE128/CODE39", () => {
    expect(detectBarcodeFormat("EZ000000000001")).toBe("code39");
    expect(detectBarcodeFormat("ez-label-42")).toBe("code128");
    expect(validateBarcode("ez-label-42").format).toBe("code128");
    expect(validateBarcode("SHELF-LABEL-42").format).toBe("code39");
  });

  it("rejects non-printable and oversized codes", () => {
    expect(validateBarcode("ab\u0001cd").valid).toBe(false);
    expect(validateBarcode("x".repeat(101)).valid).toBe(false);
    expect(validateBarcode("").valid).toBe(false);
  });

  it("CODE39 rejects lowercase", () => {
    const result = validateBarcode("abc123", "code39");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/CODE39 supports/);
  });
});
