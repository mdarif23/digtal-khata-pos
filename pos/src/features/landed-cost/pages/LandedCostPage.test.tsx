import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { LandedCostPage } from "./LandedCostPage";
import type { LandedCostContext, LandedCostPreview } from "../landedCost.api";

vi.mock("../landedCost.api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../landedCost.api")>();
  return {
    ...actual,
    landedCostApi: {
      ...actual.landedCostApi,
      getContext: vi.fn(),
      preview: vi.fn(),
      getDocument: vi.fn(),
    },
  };
});

import { landedCostApi } from "../landedCost.api";

const context: LandedCostContext = {
  purchase: {
    id: 1,
    purchaseOrderNumber: "PO-2026-000001",
    status: "partially_received",
    supplierId: null,
    locationId: 1,
  },
  lines: [
    {
      purchaseItemId: 11,
      variantId: 110,
      productName: "Football",
      variantName: "Football (Small)",
      sku: "FB-S",
      unitCost: 100,
      discount: 0,
      receivedQuantity: 10,
      orderedQuantity: 20,
      variantWeight: 2,
      variantWeightUnit: "kg",
      productDefaultWeightKg: 5,
      batches: [
        { batchId: 7, batchNumber: "AUTO-11-1", quantityReceived: 10, quantityRemaining: 10 },
      ],
    },
  ],
  existingStatus: null,
  existingDocumentId: null,
};

const preview: LandedCostPreview = {
  totalExpenseAmount: 400,
  totalCapitalizableAmount: 400,
  totalNonCapitalizableAmount: 0,
  allocation: {
    lines: [
      {
        purchaseItemId: 11,
        variantId: 110,
        batches: [
          {
            batchId: 7,
            batchNumber: "AUTO-11-1",
            quantitySnapshot: 10,
            basisValue: 10,
            allocatedAmount: 200,
            allocatedPerUnit: 20,
            weightSnapshot: null,
          },
        ],
        lineAllocatedAmount: 200,
        lineTotalTargetAmount: 400,
        lineReceivedTargetAmount: 200,
        orderedQuantity: 20,
        receivedQuantity: 10,
      },
    ],
    allocatedTotal: 200,
    pendingTotal: 200,
  },
  accountingImpact: {
    capitalizableToInventory: 400,
    periodExpenses: 0,
    bySettlement: [{ settlementType: "unpaid", amount: 400 }],
  },
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/purchases/landed-cost/1"]}>
        <LandedCostPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("LandedCostPage", () => {
  beforeEach(() => {
    vi.mocked(landedCostApi.preview).mockResolvedValue(preview);
  });

  it("shows the Part F pending reserve for a partially received purchase", async () => {
    vi.mocked(landedCostApi.getContext).mockResolvedValue(context);
    renderPage();
    expect(
      await screen.findByText("Landed cost — PO-2026-000001"),
    ).toBeInTheDocument();
    // Entering an expense triggers the allocation preview.
    fireEvent.change(await screen.findByLabelText("Expense 1 amount"), {
      target: { value: "400" },
    });
    expect(await screen.findByText("Pending (unreceived)")).toBeInTheDocument();
    // ৳200.00 appears in both the allocated and the pending cards.
    expect(
      screen.getAllByText((_, element) => element?.textContent === "৳200.00").length,
    ).toBeGreaterThan(0);
  });

  it("shows the allocation preview with per-batch landed unit cost", async () => {
    vi.mocked(landedCostApi.getContext).mockResolvedValue(context);
    renderPage();
    fireEvent.change(await screen.findByLabelText("Expense 1 amount"), {
      target: { value: "400" },
    });
    expect(await screen.findByText("AUTO-11-1")).toBeInTheDocument();
    // landed per unit = 100 original + 20 allocated
    expect(
      screen.getByText((_, element) => element?.textContent === "৳120.00"),
    ).toBeInTheDocument();
  });

  it("renders the posted history view when a document is posted", async () => {
    vi.mocked(landedCostApi.getContext).mockResolvedValue({
      ...context,
      existingStatus: "posted",
      existingDocumentId: 5,
    });
    vi.mocked(landedCostApi.getDocument).mockResolvedValue({
      document: {
        id: 5,
        purchaseId: 1,
        status: "posted",
        allocationMethod: "quantity",
        totalExpenseAmount: "400.00",
        totalCapitalizableAmount: "400.00",
        totalAllocatedAmount: "200.00",
        pendingAllocationAmount: "200.00",
      },
      expenses: [],
      allocations: [
        {
          id: 1,
          purchaseItemId: 11,
          inventoryBatchId: 7,
          variantId: 110,
          allocatedAmount: "200.0000",
          allocatedPerUnit: "20.000000",
          quantitySnapshot: "10.000",
          createdAt: new Date().toISOString(),
        },
      ],
      adjustments: [],
      auditLogs: [],
      postings: [
        {
          id: 1,
          postingType: "capitalization",
          amount: "200.00",
          paymentSource: "unpaid",
          paymentReferenceType: null,
          paymentReferenceId: null,
          description: "shipping → inventory",
        },
      ],
    });
    renderPage();
    expect(await screen.findByText("Allocations (immutable)")).toBeInTheDocument();
    expect(screen.getByText("Accounting postings")).toBeInTheDocument();
  });
});
