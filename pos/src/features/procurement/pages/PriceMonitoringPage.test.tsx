import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaginatedPriceOverview } from "../api/procurement.api";
import { PriceMonitoringPage } from "./PriceMonitoringPage";

vi.mock("../hooks/useProcurement", () => ({
  procurementKeys: {
    all: ["procurement"],
    priceOverview: (filters: unknown) => ["procurement", "price-overview", filters],
    variantPriceHistory: (id: number, filters: unknown) =>
      ["procurement", "variant-price-history", id, filters],
  },
  usePriceOverview: vi.fn(),
}));

const { usePriceOverview } = await import("../hooks/useProcurement");

const overviewRow: PaginatedPriceOverview = {
  data: [
    {
      variantId: 42,
      sku: "SKU-000042",
      productId: 7,
      productName: "Rice 25 KG",
      categoryName: "Grocery",
      unitName: "Bag",
      latestPrice: 120,
      previousPrice: 100,
      lowestPrice: 95,
      highestPrice: 130,
      averagePrice: 108.33,
      purchaseCount: 6,
      totalReceivedQuantity: 120,
      lastPurchaseDate: "2026-11-01T10:00:00.000Z",
      lastSupplierId: 3,
      lastSupplierName: "Wholesale A",
      priceChangePercent: 20,
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
      <MemoryRouter initialEntries={["/procurement/prices"]}>
        <PriceMonitoringPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PriceMonitoringPage", () => {
  beforeEach(() => {
    vi.mocked(usePriceOverview).mockReset();
  });

  it("renders the price overview rows with formatted money and change", async () => {
    vi.mocked(usePriceOverview).mockReturnValue({
      data: overviewRow,
      isLoading: false,
      isError: false,
      error: null,
    } as never);
    renderPage();

    expect(await screen.findByText("Rice 25 KG")).toBeInTheDocument();
    // Locale rendering of BDT differs between Node ICU (BDT 120.00) and
    // browsers (৳ 120.00) — assert the amount, not the currency symbol.
    expect(screen.getByText(/120\.00/)).toBeInTheDocument();
    expect(screen.getByText("+20.00%")).toBeInTheDocument();
    expect(screen.getByText("Wholesale A")).toBeInTheDocument();
  });

  it("shows the empty state when no variants have received purchases", async () => {
    vi.mocked(usePriceOverview).mockReturnValue({
      data: { data: [], total: 0, page: 1, limit: 20 },
      isLoading: false,
      isError: false,
      error: null,
    } as never);
    renderPage();

    expect(
      await screen.findByText(/No price history yet/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Prices appear here once purchases are received/i),
    ).toBeInTheDocument();
  });

  it("shows an error alert when the query fails", async () => {
    vi.mocked(usePriceOverview).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("boom"),
    } as never);
    renderPage();

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
