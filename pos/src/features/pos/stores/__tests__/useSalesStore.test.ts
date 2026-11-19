import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression contracts after Phase 6 Feature 1: the sales LIST moved to
// useSalesQuery (TanStack Query); the store keeps the checkout/refund
// actions. The historical ExchangeDialog regression (selecting the
// nonexistent getSalesData, which surfaced a committed exchange as an error
// toast) stays pinned.

vi.mock("../../../../api/axios.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  getActiveBusinessId: () => 1,
  getActiveLocationId: () => 2,
}));

const { invalidateQueries } = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
}));
vi.mock("@/lib/queryClient", () => ({
  queryClient: { invalidateQueries: invalidateQueries },
}));

vi.mock("@/features/products/hooks/useProducts.js", () => ({
  productKeys: { all: ["products"], catalog: () => ["products", 1, 2, "catalog"] },
  readProductsCache: () => [],
}));

vi.mock("../hooks/useSellUnits.js", () => ({
  clearSellUnitsCache: vi.fn(),
  sellUnitsKeys: { all: ["sell-units"] },
}));

import axios from "../../../../api/axios.js";
import { getErrorMessage } from "@/utils/getErrorMessage.js";
import { voidSaleApi } from "../../sales.api.js";
import { useSalesStore } from "../useSalesStore.js";
import { saleKeys } from "../../hooks/useSales.js";

const mockedPost = vi.mocked(axios.post);

describe("useSalesStore (actions after the list moved to TanStack Query)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateQueries.mockResolvedValue(undefined);
  });

  it("exposes the checkout/refund actions and never getSales/getSalesData", () => {
    expect(typeof useSalesStore.getState().createSale).toBe("function");
    expect(typeof useSalesStore.getState().returnProducts).toBe("function");
    expect(typeof useSalesStore.getState().returnSingleItems).toBe("function");
    expect(
      (useSalesStore.getState() as unknown as Record<string, unknown>).getSales,
    ).toBeUndefined();
    expect(
      (useSalesStore.getState() as unknown as Record<string, unknown>)
        .getSalesData,
    ).toBeUndefined();
  });

  it("createSale's list refresh stays best-effort: a failed invalidate must not reject the sale", async () => {
    mockedPost.mockResolvedValueOnce({
      data: { sale: { id: 1, invoiceNumber: "INV-1" } },
    } as never);
    invalidateQueries.mockRejectedValueOnce(new Error("network down"));
    await expect(
      useSalesStore.getState().createSale({} as never),
    ).resolves.toBeDefined();
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: saleKeys.list(),
    });
  });

  it("returnProducts keeps the strict refresh: a failed invalidate rejects (as the old list refetch did)", async () => {
    mockedPost.mockResolvedValueOnce({ data: {} } as never);
    invalidateQueries.mockRejectedValueOnce(new Error("network down"));
    await expect(
      useSalesStore.getState().returnProducts(5, {} as never),
    ).rejects.toThrow("network down");
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: saleKeys.list(),
    });
  });
});

describe("void sale contract (R3-005 — the 403→approval→token retry loop)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a policy-403 rejects with the exact message the UI regex matches", async () => {
    // Real axios rejects 4xx through its interceptors — simulate the shape
    // the UI's catch actually sees.
    const rejection = {
      isAxiosError: true,
      response: {
        status: 403,
        data: {
          success: false,
          message: "A manager approval is required to void a sale.",
        },
      },
    };
    mockedPost.mockRejectedValueOnce(rejection);
    // The API call rejects with the axios-shaped error...
    await expect(voidSaleApi(9, "duplicate")).rejects.toEqual(rejection);
    // ...and the message the UI extracts (Sales.tsx's catch) matches the
    // approval regex that opens the dialog.
    expect(getErrorMessage(rejection)).toMatch(/manager approval is required/i);
    expect(mockedPost).toHaveBeenCalledWith("/sales/9/cancel", {
      reason: "duplicate",
    });
  });

  it("the retry carries the minted approval token", async () => {
    mockedPost.mockResolvedValueOnce({
      status: 200,
      data: { success: true, data: { saleId: 9, status: "cancelled" } },
    });
    await voidSaleApi(9, "duplicate", "tok_abc123");
    expect(mockedPost).toHaveBeenCalledWith("/sales/9/cancel", {
      reason: "duplicate",
      approvalToken: "tok_abc123",
    });
  });
});
