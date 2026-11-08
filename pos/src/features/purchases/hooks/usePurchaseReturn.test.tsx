import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePurchaseReturn } from "./usePurchaseReturn";

vi.mock("@/api/axios", () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));
import axios from "@/api/axios";

// The Zustand stores are compatibility refreshes — stub them so the test
// observes invalidations without dragging the real stores in.
vi.mock("../usePurchaseStore", () => ({
  usePurchasesStore: {
    getState: () => ({
      getPurchases: vi.fn().mockResolvedValue(undefined),
      getPurchaseItems: vi.fn().mockResolvedValue(undefined),
      getPurchasesReturnItems: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));
vi.mock("@/features/products/useProductStore", () => ({
  default: {
    getState: () => ({ getProducts: vi.fn().mockResolvedValue(undefined) }),
  },
}));

const mockedPost = vi.mocked(axios.post);

function Harness({ onDone }: { onDone: () => void }) {
  const mutation = usePurchaseReturn();
  return (
    <button
      type="button"
      onClick={() =>
        mutation
          .mutateAsync({
            orderId: 33,
            changedItems: [{ purchaseItemId: 21, quantity: 1 }],
          })
          .then(onDone)
      }
    >
      submit
    </button>
  );
}

describe("usePurchaseReturn (Phase 6: targeted invalidation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPost.mockResolvedValue({
      data: {
        success: true,
        message: "Purchase return processed successfully.",
        data: {
          purchaseReturnId: 9,
          totalAmount: 100,
          landedCost: { adjusted: false, amount: 0, documentId: null },
          supplierBalance: {
            outstandingBefore: 0,
            goodsCredit: 100,
            outstandingAfter: 0,
            supplierCreditCreated: 100,
          },
          returnedSerials: [],
        },
      },
    });
  });

  it("calls the API directly and invalidates the purchase's queries", async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const onDone = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <Harness onDone={onDone} />
      </QueryClientProvider>,
    );

    await screen.findByRole("button", { name: /submit/i });
    await screen.getByRole("button", { name: /submit/i }).click();

    await waitFor(() => {
      expect(onDone).toHaveBeenCalled();
    });

    // The mutation hit the return endpoint directly (no store indirection).
    expect(mockedPost).toHaveBeenCalledWith("/purchase-return", {
      orderId: 33,
      changedItems: [{ purchaseItemId: 21, quantity: 1 }],
    });

    // Targeted invalidations: THIS purchase's data + the shared surfaces.
    const invalidatedKeys = invalidateSpy.mock.calls.map(
      (call) => (call[0] as { queryKey: readonly unknown[] }).queryKey,
    );
    expect(invalidatedKeys).toContainEqual(["purchases", "detail"]);
    expect(invalidatedKeys).toContainEqual(["purchases", "return-serials", 33]);
    expect(invalidatedKeys).toContainEqual([
      "purchases",
      "return-preview",
      33,
    ]);
    expect(invalidatedKeys).toContainEqual(["landed-cost"]);
    expect(invalidatedKeys).toContainEqual(["due-management"]);
    expect(invalidatedKeys).toContainEqual(["purchases", "list"]);
  });
});
