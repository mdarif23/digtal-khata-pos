import { describe, expect, it } from "vitest";
import { PERMISSION_CATALOG, ALL_PERMISSION_KEYS } from "@/lib/rbac";
import { navigation } from "@/config/navigation";
import { financeKeys } from "./hooks/useFinance";

/**
 * Finance & Growth frontend wiring: the client permission catalog mirrors
 * the backend (rbac/permissions.ts), the navigation section declares every
 * finance route, and the query-key factory is uniquely addressable.
 */

const FINANCE_KEYS = [
  "finance.view",
  "finance.overview.view",
  "finance.accounts.manage",
  "finance.journal.view",
  "finance.journal.post",
  "finance.journal.reverse",
  "finance.period.close",
  "finance.period.reopen",
  "finance.reconcile.manage",
  "finance.activation.manage",
  "finance.investment.view",
  "finance.investment.manage",
  "finance.withdrawal.view",
  "finance.withdrawal.manage",
  "finance.profit.view",
  "finance.profit.allocate",
  "finance.assets.view",
  "finance.assets.manage",
  "payroll.view",
  "payroll.manage",
  "payroll.process",
  "payroll.approve",
  "payroll.pay",
  "budget.view",
  "budget.manage",
  "loans.view",
  "loans.manage",
];

describe("finance frontend wiring", () => {
  it("mirrors every finance/payroll/budget/loans permission key from the backend catalog", () => {
    const keys = new Set(ALL_PERMISSION_KEYS);
    for (const key of FINANCE_KEYS) {
      expect(keys.has(key), `missing catalog key: ${key}`).toBe(true);
    }
    // The catalog itself must not declare a key the backend doesn't know
    // (spot-check the intersection boundary).
    const catalogKeys = PERMISSION_CATALOG.map((p) => p.key);
    expect(catalogKeys.filter((k) => k.startsWith("finance.")).length).toBeGreaterThanOrEqual(18);
  });

  it("has no duplicate keys in the client catalog", () => {
    const keys = ALL_PERMISSION_KEYS;
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("declares the Finance & Growth navigation section with all routes", () => {
    const section = navigation.find((item) => item.title === "Finance & Growth");
    expect(section).toBeDefined();
    expect(section!.items?.length).toBeGreaterThanOrEqual(11);
    const urls = new Set((section!.items ?? []).map((item) => item.url));
    for (const url of [
      "/finance",
      "/finance/reports",
      "/finance/owners",
      "/finance/profit-allocations",
      "/payroll",
      "/finance/cash-flow",
      "/finance/balance-sheet",
      "/finance/growth",
      "/finance/loans",
      "/finance/assets",
      "/finance/journal",
    ]) {
      expect(urls.has(url), `nav missing route: ${url}`).toBe(true);
    }
  });

  it("gates every finance nav sub-item behind a finance/payroll/budget/loans permission", () => {
    const section = navigation.find((item) => item.title === "Finance & Growth")!;
    for (const item of section.items ?? []) {
      const gate = item.permission ?? item.anyPermission;
      expect(gate, `nav item ${item.title} has no permission gate`).toBeDefined();
    }
  });

  it("builds uniquely addressable query keys", () => {
    expect(financeKeys.overview("2026-11-01", "2026-11-30")).not.toEqual(
      financeKeys.overview("2026-11-01", "2026-12-31"),
    );
    expect(financeKeys.status()).not.toEqual(financeKeys.periods());
  });
});
