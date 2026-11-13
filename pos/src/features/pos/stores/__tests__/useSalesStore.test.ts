import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression contract for ExchangeDialog's post-exchange refresh: the store
// exposes getSales (an earlier revision of the dialog selected the
// nonexistent getSalesData, so the committed exchange surfaced as an error
// toast and the dialog never closed). These tests pin the selector the
// dialog relies on.

vi.mock("../../../../api/axios.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

vi.mock("@/lib/queryClient", () => ({
  queryClient: { invalidateQueries: vi.fn() },
}));

vi.mock("@/features/products/useProductStore.js", () => ({
  default: { getState: () => ({ getProducts: vi.fn() }) },
}));

import axios from "../../../../api/axios.js";
import { useSalesStore } from "../useSalesStore.js";

const mockedGet = vi.mocked(axios.get);

describe("useSalesStore (ExchangeDialog refresh contract)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSalesStore.setState({ sales: [], loading: false, error: null });
  });

  it("exposes getSales as a callable store action", () => {
    const action = useSalesStore.getState().getSales;
    expect(typeof action).toBe("function");
    // The broken selector the dialog must never go back to:
    expect(
      (useSalesStore.getState() as unknown as Record<string, unknown>)
        .getSalesData,
    ).toBeUndefined();
  });

  it("getSales loads the sales list and never throws on API failure", async () => {
    mockedGet.mockResolvedValueOnce({ data: [{ id: 1 }] });
    await useSalesStore.getState().getSales();
    expect(useSalesStore.getState().sales).toEqual([{ id: 1 }]);
    expect(useSalesStore.getState().error).toBeNull();

    // A refresh failure must not reject — the dialog awaits it AFTER the
    // exchange committed, so a rejection would present success as failure.
    mockedGet.mockRejectedValueOnce(new Error("network down"));
    await expect(useSalesStore.getState().getSales()).resolves.toBeUndefined();
    expect(useSalesStore.getState().error).toBe("network down");
  });
});
