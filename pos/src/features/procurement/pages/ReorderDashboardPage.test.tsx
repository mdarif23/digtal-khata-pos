import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReorderDashboard } from "../api/procurement.api";
import { ReorderDashboardPage } from "./ReorderDashboardPage";

vi.mock("../hooks/useProcurement", () => ({
  procurementKeys: { all: ["procurement"] },
  useReorderDashboard: vi.fn(),
  useConvertSuggestions: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

const { useReorderDashboard, useConvertSuggestions } = await import(
  "../hooks/useProcurement"
);

const dashboard: ReorderDashboard = {
  summary: {
    outOfStock: 1,
    lowStock: 0,
    needsReorder: 2,
    attentionCount: 3,
    noSupplierCount: 1,
    missingPriceCount: 1,
    totalEstimatedValue: 700,
    supplierCount: 1,
  },
  suppliers: [
    {
      supplierId: 5,
      supplierName: "Distributor A",
      itemCount: 1,
      totalQuantity: 4,
      estimatedValue: 200,
      minimumOrderValue: 10000,
      targetOrderValue: null,
      orderStatus: "below_minimum",
      amountRemaining: 9800,
    },
  ],
  data: [
    {
      variantId: 42,
      productId: 7,
      productName: "Rice 25 KG",
      sku: "SKU-RICE",
      categoryName: "Grocery",
      unitName: "Bag",
      currentStock: 0,
      reservedQuantity: 0,
      outstandingOnOrder: 0,
      inTransitQuantity: 0,
      availableQuantity: 0,
      reorderPoint: null,
      reorderQuantity: null,
      alertQuantity: 3,
      status: "out_of_stock",
      suggestedQuantity: null,
      lastUnitCost: null,
      estimatedValue: null,
      lastSupplierId: null,
      lastSupplierName: null,
    },
    {
      variantId: 43,
      productId: 8,
      productName: "Oil 5 L",
      sku: "SKU-OIL",
      categoryName: "Grocery",
      unitName: "Bottle",
      currentStock: 6,
      reservedQuantity: 0,
      outstandingOnOrder: 0,
      inTransitQuantity: 0,
      availableQuantity: 6,
      reorderPoint: 10,
      reorderQuantity: null,
      alertQuantity: 0,
      status: "needs_reorder",
      suggestedQuantity: 4,
      lastUnitCost: 50,
      estimatedValue: 200,
      lastSupplierId: 5,
      lastSupplierName: "Distributor A",
    },
  ],
  total: 2,
  page: 1,
  limit: 20,
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/procurement/reorder"]}>
        <ReorderDashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ReorderDashboardPage", () => {
  beforeEach(() => {
    vi.mocked(useReorderDashboard).mockReset();
    vi.mocked(useReorderDashboard).mockReturnValue({
      data: dashboard,
      isLoading: false,
      isError: false,
      error: null,
    } as never);
  });

  it("renders summary metrics, supplier groups, and product rows", async () => {
    renderPage();

    expect(await screen.findByText("Smart Reorder Planning")).toBeInTheDocument();
    // Supplier name appears in both the group table and the product row.
    expect(screen.getAllByText("Distributor A").length).toBeGreaterThan(0);
    expect(screen.getByText(/10,?000\.00|10,000/)).toBeInTheDocument(); // min order
    expect(screen.getByText("Rice 25 KG")).toBeInTheDocument();
    // Status labels double as metric card labels — assert multiplicity.
    expect(screen.getAllByText("Out of stock").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Needs reorder").length).toBeGreaterThan(0);
    expect(screen.getByText(/700\.00/)).toBeInTheDocument(); // estimated value summary
  });

  it("lets the buyer select a product, adjust the quantity, and see the draft dialog", async () => {
    const user = userEvent.setup();
    renderPage();

    const checkbox = await screen.findByLabelText(/Select Oil 5 L/);
    expect(checkbox).not.toBeDisabled();
    await user.click(checkbox);

    // Rice has no suggested quantity (no reorder config) → not selectable.
    // Base UI Checkbox signals disabled via aria-disabled, not the attribute.
    expect(screen.getByLabelText(/Select Rice 25 KG/)).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    const createButton = screen.getByRole("button", { name: /Create draft POs \(1\)/ });
    await user.click(createButton);

    expect(await screen.findByText(/One unpaid draft per supplier/)).toBeInTheDocument();
    expect(screen.getAllByText(/Distributor A/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Create 1 draft/)).toBeInTheDocument();
  });

  it("shows an error alert when the dashboard fails to load", async () => {
    vi.mocked(useReorderDashboard).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("boom"),
    } as never);
    renderPage();

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("keeps the convert mutation untouched until the buyer confirms", async () => {
    const mutateAsync = vi.fn();
    vi.mocked(useConvertSuggestions).mockReturnValue({
      mutateAsync,
      isPending: false,
    } as never);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByLabelText(/Select Oil 5 L/));
    expect(mutateAsync).not.toHaveBeenCalled(); // nothing auto-submits
    await user.click(screen.getByRole("button", { name: /Create draft POs \(1\)/ }));
    expect(mutateAsync).not.toHaveBeenCalled(); // still only a preview dialog
  });
});
