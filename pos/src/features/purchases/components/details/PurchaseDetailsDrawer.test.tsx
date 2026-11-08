import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PurchaseDetailsDrawer } from "./PurchaseDetailsDrawer";

vi.mock("@/api/axios", () => ({ default: { get: vi.fn() } }));
import axios from "@/api/axios";

const mockedGet = vi.mocked(axios.get);

function axiosError(status: number) {
  return Object.assign(new Error("request failed"), {
    isAxiosError: true,
    response: { status },
  });
}

const purchaseDetail = {
  purchase: {
    id: 11,
    purchaseOrderNumber: "PO-2026-000011",
    purchaseDate: "2026-11-07T00:00:00.000Z",
    supplierId: 3,
    supplierName: "Acme Traders",
    supplierPhone: "+8801711000000",
    status: "received" as const,
    returnStatus: null,
    landedCostStatus: "allocated" as const,
    subtotal: 1000,
    discount: 50,
    tax: 30,
    shippingCost: 100,
    totalAmount: 1080,
    paidAmount: 400,
    dueAmount: 680,
    paymentStatus: "partial" as const,
    notes: null,
    supplierCreditBalance: 1200,
  },
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
        availableStock: 8,
      },
    ],
  },
  items: [
    {
      id: 21,
      purchaseId: 11,
      variantId: 5,
      productId: 2,
      productName: "Steel Bolt",
      variantSku: "BOLT-1",
      variantName: "Steel Bolt",
      variantOptions: undefined,
      trackingType: "none",
      productUnit: "Pcs",
      quantity: 10,
      receivedQuantity: 10,
      rejectedQuantity: 0,
      cancelledQuantity: 0,
      unitCost: 100,
      discount: 0,
      tax: 0,
      sellingPrice: 150,
      availableStock: 8,
    },
  ],
};

const landedContext = {
  purchase: { id: 11, purchaseOrderNumber: "PO-2026-000011" },
  lines: [],
  existingStatus: "posted",
  existingDocumentId: 55,
};

const landedDocument = {
  document: {
    id: 55,
    purchaseId: 11,
    status: "adjusted",
    allocationMethod: "quantity",
    totalExpenseAmount: "500",
    totalCapitalizableAmount: "500",
    totalAllocatedAmount: "500",
    pendingAllocationAmount: "0",
  },
  expenses: [
    {
      id: 71,
      expenseType: "shipping",
      amount: 100,
      sourceType: "purchase" as const,
      sourceKey: "shipping_cost",
    },
    {
      id: 72,
      expenseType: "customs",
      amount: 400,
      sourceType: "additional_expense" as const,
      sourceKey: null,
    },
  ],
  allocations: [],
  adjustments: [],
  auditLogs: [],
  postings: [
    {
      id: 91,
      postingType: "capitalization" as const,
      amount: "500",
      paymentSource: "supplier_payable",
      paymentReferenceType: null,
      paymentReferenceId: null,
      description: "customs → inventory",
      expenseId: 72,
      expenseType: "customs",
      expenseSourceType: "additional_expense",
      expenseSourceKey: null,
      expenseDescription: null,
    },
    {
      id: 92,
      postingType: "reversal" as const,
      amount: "-100",
      paymentSource: "unpaid",
      paymentReferenceType: null,
      paymentReferenceId: null,
      description: "Landed cost of returned units",
      expenseId: null,
      expenseType: null,
      expenseSourceType: null,
      expenseSourceKey: null,
      expenseDescription: null,
    },
  ],
  accounting: {
    postingsByType: {
      capitalization: 500,
      expense: 0,
      cogsAdjustment: 0,
      reversal: -100,
    },
    netInInventory: 400,
    soldUnitsLanded: 0,
    periodExpensed: 0,
    attributedAmount: 500,
    unattributedAmount: 100,
    capitalizationTiesOut: true,
  },
};

function renderDrawer() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PurchaseDetailsDrawer
          purchaseId={11}
          open
          onOpenChange={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PurchaseDetailsDrawer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/purchases/11")) {
        // Raw body = the payload (the detail hook reads body directly).
        return Promise.resolve({ data: purchaseDetail });
      }
      if (String(url).endsWith("/purchases/11/landed-cost")) {
        // Unwrapped convention: body = { success, data }.
        return Promise.resolve({ data: { success: true, data: landedContext } });
      }
      if (String(url).endsWith("/landed-costs/55")) {
        return Promise.resolve({ data: { success: true, data: landedDocument } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
  });

  it("renders the financial picture: cost summary, items and payment facts", async () => {
    renderDrawer();
    // The title carries the PO number once the detail query resolves.
    expect(
      await screen.findByText("PO-2026-000011"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Acme Traders/)).toBeInTheDocument();
    // Cost summary block: grand total + due.
    expect(screen.getByText("Purchase grand total")).toBeInTheDocument();
    expect(screen.getByText("1,080.00")).toBeInTheDocument(); // cost summary (plain format)
    expect(screen.getByText(/680\.00/)).toBeInTheDocument();
    // Phase 3: the supplier credit balance is visible on the detail even
    // while the purchase still has an outstanding due.
    expect(screen.getByText("Supplier credit balance")).toBeInTheDocument();
    expect(screen.getByText(/1,200\.00/)).toBeInTheDocument();
    expect(
      screen.getByText(/not a cash refund/),
    ).toBeInTheDocument();
    // Item line with its unit cost (scoped to the row).
    expect(screen.getByText("Steel Bolt")).toBeInTheDocument();
    expect(screen.getByText("BOLT-1")).toBeInTheDocument();
    const row = screen.getByText("Steel Bolt").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row!).getByText(/100\.00/)).toBeInTheDocument();
  });

  it("shows the landed-cost accounting panel with source identity and tie-out", async () => {
    renderDrawer();
    // The auto supplier-shipping row is distinguishable from manual entries.
    expect(
      await screen.findByTestId("purchase-origin-badge"),
    ).toBeInTheDocument();
    const accounting = screen.getByTestId("landed-accounting");
    expect(within(accounting).getByText("Net in inventory")).toBeInTheDocument();
    expect(within(accounting).getByText(/400\.00/)).toBeInTheDocument();
    expect(
      screen.getByText(/Ledger reconciles with the document/),
    ).toBeInTheDocument();
  });

  it("hides the landed-cost panel for purchases nothing has been received on", async () => {
    mockedGet.mockImplementation((url: string) => {
      if (String(url).endsWith("/purchases/11")) {
        return Promise.resolve({
          data: {
            ...purchaseDetail,
            purchase: {
              ...purchaseDetail.purchase,
              status: "ordered" as const,
              landedCostStatus: null,
            },
          },
        });
      }
      if (String(url).endsWith("/purchases/11/landed-cost")) {
        return Promise.reject(axiosError(400));
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderDrawer();
    await waitFor(() => {
      expect(mockedGet).toHaveBeenCalledWith("/purchases/11");
    });
    expect(
      await screen.findByText(
        /Receive at least one quantity before allocating landed costs/,
      ),
    ).toBeInTheDocument();
    // The landed-cost panel never fetched a document and the drawer
    // rendered the guidance without crashing.
    expect(mockedGet).not.toHaveBeenCalledWith(
      expect.stringContaining("/landed-costs/"),
    );
  });
});
