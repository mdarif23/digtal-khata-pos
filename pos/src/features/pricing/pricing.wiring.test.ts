import { describe, expect, it } from "vitest";
import { ALL_PERMISSION_KEYS } from "@/lib/rbac";
import { navigation } from "@/config/navigation";
import { pricingKeys } from "./hooks/usePricing";

/**
 * Pricing frontend wiring: the client permission catalog mirrors the backend
 * (rbac/permissions.ts — 8 pricing.* keys), the navigation section declares
 * every pricing route behind a pricing permission, and the query-key factory
 * is uniquely addressable.
 */

const PRICING_KEYS = [
  "pricing.view",
  "pricing.manage",
  "pricing.product.manage",
  "pricing.customer_groups.manage",
  "pricing.price_override",
  "pricing.below_minimum_override",
  "pricing.history.view",
  "pricing.bulk_update",
];

describe("pricing frontend wiring", () => {
  it("mirrors every pricing.* permission key from the backend catalog", () => {
    const keys = new Set(ALL_PERMISSION_KEYS);
    for (const key of PRICING_KEYS) {
      expect(keys.has(key), `missing catalog key: ${key}`).toBe(true);
    }
    // No client key beyond the eight the backend declares.
    const extra = ALL_PERMISSION_KEYS.filter(
      (k) => k.startsWith("pricing.") && !PRICING_KEYS.includes(k),
    );
    expect(extra).toEqual([]);
  });

  it("declares the Pricing nav section with every pricing route", () => {
    const section = navigation.find((item) => item.title === "Pricing");
    expect(section).toBeDefined();
    const urls = new Set((section!.items ?? []).map((item) => item.url));
    for (const url of [
      "/pricing/products",
      "/pricing/rules",
      "/pricing/customer-groups",
      "/pricing/promotions",
      "/pricing/history",
      "/pricing/proposals",
      "/pricing/bulk",
      "/pricing/reports",
      "/pricing/settings",
    ]) {
      expect(urls.has(url), `nav missing route: ${url}`).toBe(true);
    }
    expect(section!.permission).toBe("pricing.view");
  });

  it("gates every pricing nav sub-item behind a pricing permission", () => {
    const section = navigation.find((item) => item.title === "Pricing")!;
    for (const item of section.items ?? []) {
      const gate = item.permission ?? item.anyPermission;
      expect(gate, `nav item ${item.title} has no permission gate`).toBeDefined();
      expect(
        gate!.startsWith("pricing.") || gate === "promotions.view",
      ).toBe(true);
    }
  });

  it("builds uniquely addressable query keys", () => {
    expect(pricingKeys.preview([1, 2])).toEqual(pricingKeys.preview([2, 1]));
    expect(pricingKeys.preview([1, 2])).not.toEqual(pricingKeys.preview([1, 3]));
    expect(pricingKeys.settings()).not.toEqual(pricingKeys.rules());
    expect(pricingKeys.effective(5)).not.toEqual(pricingKeys.effective(6));
    expect(pricingKeys.history({ variantId: 1 })).not.toEqual(
      pricingKeys.history({ variantId: 2 }),
    );
  });
});
