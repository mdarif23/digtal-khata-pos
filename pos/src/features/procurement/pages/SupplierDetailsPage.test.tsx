import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaginatedPriceOverview, SupplierDetail } from "../api/procurement.api";
import { SupplierDetailsPage } from "./SupplierDetailsPage";

vi.mock("../hooks/useProcurement", () => ({
  procurementKeys: { all: ["procurement"] },
  useSupplierDetail: vi.fn(),
  useSupplierPriceHistory: vi.fn(),
  useSupplierVariantTrend: vi.fn(() => ({ data: [], isLoading: false })),
}));

const { useSupplierDetail, useSupplierPriceHistory } = await import(
  "../hooks/useProcurement"
);

const supplierDetail: SupplierDetail = {
  supplier: {
    id: 11,
    name: "Distributor A",
    phone: "+8801711000021",
    email: null,
    address: "Karwan Bazar",
    status: "active",
    minimumOrderValue: null,
    targetOrderValue: null,
    orderSettingsEnabled: false,
    orderSettingsNotes: null,
  },
  stats: {
    purchaseCount: 5,
    totalReceivedValue: 2760,
    productCount: 1,
    lastPurchaseDate: "2026-11-04T10:00:00.000Z",
  },
};

const historyRows: PaginatedPriceOverview = {
  data: [
    {
      variantId: 42,
      sku: "SKU-ALERT",
      productId: 7,
      productName: "Alert Widget",
      categoryName: "General",
      unitName: "Box",
      latestPrice: 100,
      previousPrice: 140,
      lowestPrice: 100,
      highestPrice: 140,
      averagePrice: 115,
      purchaseCount: 5,
      totalReceivedQuantity: 24,
      lastPurchaseDate: "2026-11-04T10:00:00.000Z",
      lastSupplierId: 11,
      lastSupplierName: "Distributor A",
      priceChangePercent: -28.57,
      latestQuotation: 150,
      lastObservationDate: "2026-11-04T09:00:00.000Z",
    },
  ],
  total: 1,
  page: 1,
  limit: 20,
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/procurement/suppliers/11"]}>
        <SupplierDetailsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SupplierDetailsPage", () => {
  beforeEach(() => {
    vi.mocked(useSupplierDetail).mockReset();
    vi.mocked(useSupplierPriceHistory).mockReset();
    vi.mocked(useSupplierDetail).mockReturnValue({
      data: supplierDetail,
      isLoading: false,
      isError: false,
      error: null,
    } as never);
    vi.mocked(useSupplierPriceHistory).mockReturnValue({
      data: historyRows,
      isLoading: false,
      isError: false,
      error: null,
    } as never);
  });

  it("renders supplier info, stats, and the price history table", async () => {
    renderPage();

    expect(await screen.findByText("Distributor A")).toBeInTheDocument();
    // Address shares a line with phone/email — match a fragment.
    expect(screen.getByText(/Karwan Bazar/)).toBeInTheDocument();
    expect(screen.getByText("Alert Widget")).toBeInTheDocument();
    // Latest quotation column and change badge render.
    expect(screen.getByText(/150\.00/)).toBeInTheDocument();
    expect(screen.getByText("−28.57%")).toBeInTheDocument();
    // Purchase count appears in the stats card and the table column.
    expect(screen.getAllByText("5").length).toBeGreaterThan(0);
  });

  it("shows an error alert when the supplier cannot be loaded", async () => {
    vi.mocked(useSupplierDetail).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("boom"),
    } as never);
    renderPage();

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
