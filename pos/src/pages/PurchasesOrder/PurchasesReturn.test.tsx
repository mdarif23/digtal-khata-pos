import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PurchaseViewItems } from "./PurchasesReturn";

vi.mock("@/api/axios", () => ({ default: { get: vi.fn(), post: vi.fn() } }));
import axios from "@/api/axios";

// The scan handler is captured so tests can fire scans directly.
let scanResolve: ((match: any) => void) | null = null;
vi.mock("@/features/barcodes/scanning/useBarcodeScanner", () => ({
  useBarcodeScanner: (options: { onResolve: (match: any) => void }) => {
    scanResolve = options.onResolve;
    return { scanner: {}, state: { status: "idle" as const } };
  },
}));
vi.mock("@/features/barcodes/scanning/useScanFailureToast", () => ({
  useScanFailureToast: () => {},
}));
vi.mock("@/features/barcodes/scanning/BarcodeScannerInput", () => ({
  BarcodeScannerInput: () => null,
}));
vi.mock("@/features/barcodes/scanning/BarcodeScanFeedback", () => ({
  BarcodeScanFeedback: () => null,
}));

const mockedGet = vi.mocked(axios.get);
const mockedPost = vi.mocked(axios.post);

const purchaseDetail = {
  purchase: {
    id: 33,
    purchaseOrderNumber: "PO-2026-000033",
    purchaseDate: "2026-11-08T00:00:00.000Z",
    supplierId: 7,
    supplierName: "Acme Traders",
    supplierPhone: "+8801711000000",
    status: "received" as const,
    returnStatus: null,
    landedCostStatus: "allocated" as const,
    subtotal: 1000,
    discount: 0,
    tax: 0,
    shippingCost: 0,
    totalAmount: 1000,
    paidAmount: 1000,
    dueAmount: 0,
    paymentStatus: "paid" as const,
    notes: null,
  },
  items: [
    {
      id: 21,
      purchaseId: 33,
      variantId: 5,
      productId: 2,
      productName: "Steel Bolt",
      variantSku: "BOLT-1",
      variantName: "Steel Bolt",
      variantOptions: undefined,
      productUnit: "Pcs",
      trackingType: "none",
      quantity: 10,
      receivedQuantity: 10,
      rejectedQuantity: 0,
      cancelledQuantity: 0,
      unitCost: 100,
      discount: 0,
      tax: 0,
      sellingPrice: 150,
      availableStock: 10,
    },
  ],
  returnContext: {
    locationId: 1,
    locationName: "Main Store",
    canReturn: true,
    reason: null,
    items: [
      {
        purchaseItemId: 21,
        orderedQuantity: 10,
        receivedQuantity: 10,
        returnedQuantity: 0,
        availableStock: 10,
      },
    ],
  },
};

const previewPayload = {
  purchaseId: 33,
  canSubmit: true,
  issues: [],
  quantities: [
    {
      purchaseItemId: 21,
      orderedQuantity: 10,
      receivedQuantity: 10,
      previouslyReturned: 0,
      eligibleQuantity: 10,
      availableStock: 10,
      requestedQuantity: 5,
      remainingAfterReturn: 5,
    },
  ],
  goodsCredit: {
    total: 500,
    lineCredits: [{ purchaseItemId: 21, quantity: 5, goodsCredit: 500 }],
  },
  landedCost: {
    applies: true,
    state: "posted" as const,
    expectedReversal: 50,
    pendingAllocation: 0,
    reason: null,
  },
  inventory: {
    valuationReduction: 550,
    batchBreakdown: [
      { batchId: 1, quantity: 5, unitCost: 100, unitAdditionalCost: 10 },
    ],
  },
  supplierBalance: {
    outstandingBefore: 0,
    goodsCredit: 500,
    outstandingAfter: 0,
    supplierCreditCreated: 500,
  },
};

const twoLineDetail = {
  ...purchaseDetail,
  items: [
    { ...purchaseDetail.items[0], id: 21, quantity: 3, receivedQuantity: 3 },
    { ...purchaseDetail.items[0], id: 22, quantity: 4, receivedQuantity: 4 },
  ] as typeof purchaseDetail.items,
  returnContext: {
    ...purchaseDetail.returnContext,
    items: [
      {
        purchaseItemId: 21,
        orderedQuantity: 3,
        receivedQuantity: 3,
        returnedQuantity: 0,
        availableStock: 10,
      },
      {
        purchaseItemId: 22,
        orderedQuantity: 4,
        receivedQuantity: 4,
        returnedQuantity: 0,
        availableStock: 10,
      },
    ],
  },
};

function renderPage(
  detail = purchaseDetail,
  returnSerials?: { data: { data: unknown } },
) {
  mockedGet.mockImplementation((url: string) => {
    if (String(url).endsWith("/purchases/33")) {
      return Promise.resolve({ data: detail });
    }
    if (returnSerials && String(url).endsWith("/purchases/33/return-serials")) {
      return Promise.resolve(returnSerials);
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/purchase-return/33"]}>
        <Routes>
          <Route path="/purchase-return/:id" element={<PurchaseViewItems />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PurchaseViewItems (return page, Phase 2 preview)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/purchases/33")) {
        return Promise.resolve({ data: purchaseDetail });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    mockedPost.mockImplementation((url: string) => {
      if (String(url).endsWith("/purchases/33/return-preview")) {
        return Promise.resolve({ data: { data: previewPayload } });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
  });

  it("preselects serials from the quantity and syncs checkbox changes (Phase 5)", async () => {
    const serialDetail = {
      ...purchaseDetail,
      items: [
        { ...purchaseDetail.items[0], trackingType: "serial", quantity: 2, receivedQuantity: 2 },
      ] as typeof purchaseDetail.items,
      returnContext: {
        ...purchaseDetail.returnContext,
        items: [
          {
            purchaseItemId: 21,
            orderedQuantity: 2,
            receivedQuantity: 2,
            returnedQuantity: 0,
            availableStock: 2,
          },
        ],
      },
    };
    const user = userEvent.setup();
    renderPage(serialDetail, {
      data: {
        data: {
          purchaseId: 33,
          items: [
            {
              purchaseItemId: 21,
              serials: [
                { id: 501, serialNumber: "SN-1" },
                { id: 502, serialNumber: "SN-2" },
                { id: 503, serialNumber: "SN-3" },
              ],
            },
          ],
        },
      },
    });
    await screen.findByText("PO-2026-000033");

    const picker = await screen.findByTestId("serial-picker-21");
    expect(picker).toHaveTextContent(/SN-1/);
    expect(picker).toHaveTextContent(/SN-3/);

    // Typing the quantity preselects the first N eligible serials.
    const input = screen.getByLabelText(/Return quantity for Steel Bolt/i);
    await user.type(input, "2");
    await waitFor(() => {
      const boxes = within(picker).getAllByRole("checkbox");
      expect(boxes[0]).toBeChecked();
      expect(boxes[1]).toBeChecked();
      expect(boxes[2]).not.toBeChecked();
    });

    // Unchecking a box syncs the quantity to the selection.
    const secondBox = within(picker).getAllByRole("checkbox")[1]!;
    await user.click(secondBox);
    await waitFor(() => {
      expect(input).toHaveValue(1);
      expect(within(picker).getAllByRole("checkbox")[0]).toBeChecked();
      expect(within(picker).getAllByRole("checkbox")[1]).not.toBeChecked();
    });
  });

  it("shows the server-authoritative preview instead of estimates", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("PO-2026-000033");

    const input = screen.getByLabelText(/Return quantity for Steel Bolt/i);
    await user.type(input, "5");

    // The preview fires with the debounced selection and its numbers
    // replace every estimate.
    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith(
        "/purchases/33/return-preview",
        { changedItems: [{ purchaseItemId: 21, quantity: 5 }] },
      );
    });
    expect(await screen.findByText("Expected goods credit")).toBeVisible();
    // SummaryCard renders "৳ <amount>" as one text node (currency symbol
    // unified with the rest of the purchases UI).
    // Goods credit AND the supplier-credit card both show ৳ 500.00.
    expect(screen.getAllByText("৳500.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Landed-cost reversal")).toBeVisible();
    expect(screen.getByText("৳50.00")).toBeInTheDocument();
    expect(
      screen.getByText("Total expected supplier credit"),
    ).toBeVisible();
    expect(screen.getByText("৳550.00")).toBeInTheDocument();
    // Fully paid purchase → the credit surfaces as supplier credit.
    expect(screen.getByText("Supplier credit balance created")).toBeVisible();
    // The disclaimer note.
    expect(
      screen.getByText(/Final amounts are recalculated during submission/),
    ).toBeInTheDocument();
    // The table line shows the authoritative credit (no estimate asterisk)
    // — scoped to the item's row.
    const row = screen.getByText("Steel Bolt").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row!).getByText(/500\.00/)).toBeInTheDocument();
    expect(within(row!).queryByText(/\*/)).toBeNull();
  });

  it("labels the landed-cost card with the server's state when not applicable (Phase 7)", async () => {
    mockedPost.mockImplementation((url: string) => {
      if (String(url).endsWith("/purchases/33/return-preview")) {
        return Promise.resolve({
          data: {
            data: {
              ...previewPayload,
              landedCost: {
                applies: false,
                state: "draft" as const,
                expectedReversal: 0,
                pendingAllocation: 150,
                reason: "The landed-cost document is a draft.",
              },
            },
          },
        });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("PO-2026-000033");
    const input = screen.getByLabelText(/Return quantity for Steel Bolt/i);
    await user.type(input, "2");

    // The card carries the state label + pending allocation, no amount.
    expect(
      await screen.findByText(
        /Draft — nothing capitalized to reverse · ৳150 pending allocation/,
      ),
    ).toBeInTheDocument();
  });

  it("reports preview issues and disables submission when invalid", async () => {
    mockedPost.mockImplementation((url: string) => {
      if (String(url).endsWith("/purchases/33/return-preview")) {
        return Promise.resolve({
          data: {
            data: {
              ...previewPayload,
              canSubmit: false,
              issues: [
                "Cannot return 12 of item 21; only 10 received units remain eligible.",
              ],
            },
          },
        });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("PO-2026-000033");

    const input = screen.getByLabelText(/Return quantity for Steel Bolt/i);
    await user.type(input, "12");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/only 10 received units remain eligible/);
    const submit = screen.getByRole("button", {
      name: /Process purchase return/i,
    });
    expect(submit).toBeDisabled();
  });
});

describe("PurchaseViewItems (Phase 4: scans across sibling lines)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scanResolve = null;
    mockedGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/purchases/33")) {
        return Promise.resolve({ data: twoLineDetail });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    mockedPost.mockImplementation((url: string) => {
      if (String(url).endsWith("/purchases/33/return-preview")) {
        return Promise.resolve({ data: { data: previewPayload } });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
  });

  it("fills line 1 to capacity, then line 2, and labels the rows", async () => {
    renderPage(twoLineDetail);
    await screen.findByText("PO-2026-000033");
    expect(screen.getByText("Line 1")).toBeInTheDocument();
    expect(screen.getByText("Line 2")).toBeInTheDocument();

    const match = { variantId: 5 };
    // Line 1 receives 3 — scans 1-3 land there; scans 4-7 fill line 2;
    // scan 8 finds nothing eligible and fails (the hook surfaces it).
    for (let i = 0; i < 7; i += 1) {
      scanResolve!(match);
    }
    const inputs = screen.getAllByLabelText(/Return quantity for Steel Bolt/i);
    await waitFor(() => {
      expect((inputs[0] as HTMLInputElement).value).toBe("3");
      expect((inputs[1] as HTMLInputElement).value).toBe("4");
    });

    // Both lines exhausted → the next scan throws the explicit failure.
    expect(() => scanResolve!(match)).toThrow(
      /no remaining returnable quantity in this purchase/,
    );
    // Quantities unchanged by the failed scan.
    expect(
      (screen.getAllByLabelText(/Return quantity for Steel Bolt/i)[0] as HTMLInputElement).value,
    ).toBe("3");
  });

  it("rejects a scan for an item that is not on the purchase", async () => {
    renderPage();
    await screen.findByText("PO-2026-000033");
    expect(() => scanResolve!({ variantId: 999 })).toThrow(
      /not on this purchase order/,
    );
  });
});

describe("PurchaseViewItems (Phase 6: purchase-specific data only)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scanResolve = null;
    mockedGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/purchases/33")) {
        return Promise.resolve({ data: purchaseDetail });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    mockedPost.mockImplementation((url: string) => {
      if (String(url).endsWith("/purchases/33/return-preview")) {
        return Promise.resolve({ data: { data: previewPayload } });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
  });

  it("mounts WITHOUT any business-wide Zustand-era fetches", async () => {
    renderPage();
    await screen.findByText("PO-2026-000033");
    await waitFor(() => {
      // The serials query has settled (resolved or rejected) — all page
      // fetches are done.
      expect(mockedGet.mock.calls.length).toBeGreaterThan(0);
    });
    const calledUrls = mockedGet.mock.calls.map((call) => String(call[0]));
    expect(calledUrls).not.toContain("/purchases");
    expect(calledUrls).not.toContain("/purchases/items");
    expect(calledUrls).not.toContain("/purchases/return-items");
    // The only purchase fetches are purchase-specific.
    for (const url of calledUrls) {
      expect(url.startsWith("/purchases/")).toBe(true);
    }
  });
});
