import { describe, expect, it } from "vitest";
import { gtinCheckDigitIsValid } from "./product.schema";
import { productSchema } from "./product.schema";

/**
 * P5: frontend GTIN validation must match the backend
 * (ezPosBackend/src/modules/barcodes/barcodes.validation.ts) exactly.
 */
describe("gtinCheckDigitIsValid (frontend port)", () => {
  it("accepts valid GS1 codes", () => {
    expect(gtinCheckDigitIsValid("4006381333931")).toBe(true); // EAN-13
    expect(gtinCheckDigitIsValid("73513537")).toBe(true); // EAN-8
    expect(gtinCheckDigitIsValid("036000291452")).toBe(true); // UPC-A
  });

  it("rejects GTIN-shaped codes with bad check digits", () => {
    expect(gtinCheckDigitIsValid("4006381333932")).toBe(false);
    expect(gtinCheckDigitIsValid("73513538")).toBe(false);
  });

  it("function level mirrors backend for non-GTIN codes", () => {
    // The raw function only speaks GS1: non-GTIN strings return false —
    // IDENTICAL to the backend function. The SCHEMA refine is the layer
    // that exempts non-GTIN-shaped codes.
    expect(gtinCheckDigitIsValid("ABC-123")).toBe(false);
    expect(gtinCheckDigitIsValid("12345")).toBe(false);
  });

  it("schema refine exempts non-GTIN-length codes (backend parity)", () => {
    const base = {
      name: "Internal Item",
      categoryId: null,
      brandId: null,
      unitId: 1,
      supplierId: null,
      description: "",
      productType: "physical",
      hasVariants: false,
      trackingType: "none",
      status: "active",
      imageUrl: null,
      imageFile: null,
      source: "purchase",
      variants: [
        {
          sku: "TEST-2",
          barcode: "12345", // 5 digits — not GTIN-shaped, refine skips it
          sellingPrice: 100,
          alertQuantity: 1,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: "B1",
          purchasePrice: 50,
          quantity: 0,
          expiryDate: null,
          options: [],
        },
      ],
    };
    expect(productSchema.safeParse(base).success).toBe(true);
  });

  it("rejects non-numeric and degenerate input", () => {
    expect(gtinCheckDigitIsValid("12")).toBe(false); // <2 chars after digit check? 2 digits → payload "1", check 2 → invalid
    expect(gtinCheckDigitIsValid("abcd")).toBe(false);
  });

  it("productSchema rejects a variant barcode with a bad check digit", () => {
    const base = {
      name: "Football",
      categoryId: null,
      brandId: null,
      unitId: 1,
      supplierId: null,
      description: "",
      productType: "physical",
      hasVariants: false,
      trackingType: "none",
      status: "active",
      imageUrl: null,
      imageFile: null,
      source: "purchase",
      variants: [
        {
          sku: "TEST-1",
          barcode: "4006381333932",
          sellingPrice: 100,
          alertQuantity: 1,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: "B1",
          purchasePrice: 50,
          quantity: 0,
          expiryDate: null,
          options: [],
        },
      ],
    } as never;
    const result = productSchema.safeParse(base);
    expect(result.success).toBe(false);
  });
});
