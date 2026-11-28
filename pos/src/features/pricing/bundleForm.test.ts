import { describe, expect, it } from "vitest";
import {
  buildBundleRule,
  bundleComponentPayload,
  bundleNormalTotalOf,
  validateBundleForm,
} from "./bundleForm";

/**
 * Bundle & Combo Phase 1 — fixed-bundle form rules (creation validation,
 * rule payload building, savings preview). The backend re-validates all of
 * it server-side; these tests pin the client contract.
 */

const prices = new Map([
  [1, 100],
  [2, 30],
]);

describe("bundleForm", () => {
  describe("bundleComponentPayload", () => {
    it("keeps rows with a variant and a positive quantity", () => {
      expect(
        bundleComponentPayload([
          { variantId: "1", quantity: "1" },
          { variantId: "2", quantity: "2" },
        ]),
      ).toEqual([
        { variantId: 1, quantity: 1 },
        { variantId: 2, quantity: 2 },
      ]);
    });

    it("drops empty and non-positive rows", () => {
      expect(
        bundleComponentPayload([
          { variantId: "", quantity: "1" },
          { variantId: "1", quantity: "0" },
          { variantId: "2", quantity: "-1" },
        ]),
      ).toEqual([]);
    });

    it("keeps fractional weight quantities", () => {
      expect(bundleComponentPayload([{ variantId: "1", quantity: "0.5" }])).toEqual([
        { variantId: 1, quantity: 0.5 },
      ]);
    });
  });

  describe("validateBundleForm", () => {
    const valid = [{ variantId: "1", quantity: "1" }];

    it("accepts a complete fixed-price bundle", () => {
      expect(validateBundleForm(valid, "price", "299", "")).toBeNull();
    });

    it("accepts a complete percent bundle", () => {
      expect(validateBundleForm(valid, "percent", "", "10")).toBeNull();
    });

    it("rejects an empty component list", () => {
      expect(validateBundleForm([], "price", "299", "")).toMatch(/at least one component/);
    });

    it("rejects components without quantities", () => {
      expect(
        validateBundleForm([{ variantId: "1", quantity: "0" }], "price", "299", ""),
      ).toMatch(/at least one component/);
    });

    it("rejects a zero or missing bundle price", () => {
      expect(validateBundleForm(valid, "price", "", "")).toMatch(/greater than zero/);
      expect(validateBundleForm(valid, "price", "0", "")).toMatch(/greater than zero/);
    });

    it("rejects out-of-range percent", () => {
      expect(validateBundleForm(valid, "percent", "", "0")).toMatch(/1 and 100/);
      expect(validateBundleForm(valid, "percent", "", "101")).toMatch(/1 and 100/);
    });
  });

  describe("buildBundleRule", () => {
    it("emits exactly one price mode", () => {
      expect(buildBundleRule("price", "299", "10", "")).toEqual({ bundlePrice: 299 });
      expect(buildBundleRule("percent", "", "15", "")).toEqual({ discountPercent: 15 });
    });

    it("includes maxApplications only when positive", () => {
      expect(buildBundleRule("price", "299", "", "3")).toEqual({
        bundlePrice: 299,
        maxApplications: 3,
      });
      expect(buildBundleRule("price", "299", "", "")).toEqual({ bundlePrice: 299 });
      expect(buildBundleRule("price", "299", "", "0")).toEqual({ bundlePrice: 299 });
    });
  });

  describe("bundleNormalTotalOf", () => {
    it("sums price × quantity over known variants", () => {
      expect(
        bundleNormalTotalOf(
          [
            { variantId: "1", quantity: "5" },
            { variantId: "2", quantity: "3" },
          ],
          prices,
        ),
      ).toBe(590); // 5×100 + 3×30
    });

    it("ignores unknown variants and non-positive quantities", () => {
      expect(
        bundleNormalTotalOf(
          [
            { variantId: "", quantity: "5" },
            { variantId: "1", quantity: "0" },
            { variantId: "2", quantity: "2" },
          ],
          prices,
        ),
      ).toBe(60);
    });
  });
});
