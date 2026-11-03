import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "@/auth/sessionStore";
import type { PaginatedObservations } from "../api/procurement.api";
import { PriceCheckPage } from "./PriceCheckPage";

vi.mock("../hooks/useProcurement", () => ({
  procurementKeys: { all: ["procurement"] },
  usePriceCheckObservations: vi.fn(),
  useCreateObservation: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useUpdateObservation: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useDeleteObservation: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

vi.mock("@/features/Contacts/useContactStore", () => ({
  useContactStore: () => ({
    suppliers: [{ id: 3, name: "Market Shop B" }],
    getSuppliers: vi.fn(),
  }),
}));

vi.mock("@/features/products/useProductStore", () => ({
  default: (selector: (state: unknown) => unknown) =>
    selector({
      products: [
        {
          id: 7,
          name: "Rice 25 KG",
          unitId: 2,
          variants: [{ id: 42, sku: "SKU-RICE-25" }],
        },
      ],
      productSelectOptions: {
        units: [{ value: 2, label: "Kg" }],
        categories: [],
        suppliers: [],
      },
    }),
}));

const { usePriceCheckObservations } = await import("../hooks/useProcurement");

const observations: PaginatedObservations = {
  data: [
    {
      id: 1,
      variantId: 42,
      productName: "Rice 25 KG",
      sku: "SKU-RICE-25",
      unitName: "Kg",
      supplierId: 3,
      supplierName: "Market Shop B",
      quotedPrice: 1500,
      packageQuantity: 25,
      unitPrice: 60,
      observationDate: "2026-11-03",
      notes: "sack price",
      createdAt: "2026-11-03T00:00:00.000Z",
      updatedAt: "2026-11-03T00:00:00.000Z",
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
      <MemoryRouter initialEntries={["/procurement/price-check"]}>
        <PriceCheckPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PriceCheckPage", () => {
  beforeEach(() => {
    useSessionStore.setState({ permissions: [], version: (useSessionStore.getState().version ?? 0) + 1 });
  });

  afterEach(() => {
    useSessionStore.setState({ permissions: [] });
  });

  it("renders recorded quotations with the per-unit price", async () => {
    vi.mocked(usePriceCheckObservations).mockReturnValue({
      data: observations,
      isLoading: false,
      isError: false,
      error: null,
    } as never);
    renderPage();

    expect(await screen.findByText("Rice 25 KG")).toBeInTheDocument();
    expect(screen.getByText("Market Shop B")).toBeInTheDocument();
    // Per-unit normalization is shown as a badge.
    expect(screen.getByText(/60\.00/)).toBeInTheDocument();
  });

  it("hides the recording form and row actions without purchases.price_check", async () => {
    vi.mocked(usePriceCheckObservations).mockReturnValue({
      data: observations,
      isLoading: false,
      isError: false,
      error: null,
    } as never);
    renderPage();

    expect(await screen.findByText("Rice 25 KG")).toBeInTheDocument();
    expect(screen.queryByText("Record observation")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Edit observation/)).not.toBeInTheDocument();
  });

  it("shows the recording form and actions with purchases.price_check", async () => {
    useSessionStore.setState({
      permissions: ["purchases.view", "purchases.price_check"],
      version: (useSessionStore.getState().version ?? 0) + 1,
    });
    vi.mocked(usePriceCheckObservations).mockReturnValue({
      data: observations,
      isLoading: false,
      isError: false,
      error: null,
    } as never);
    renderPage();

    expect(await screen.findByText("Record observation")).toBeInTheDocument();
    expect(screen.getByLabelText(/Edit observation/)).toBeInTheDocument();
  });
});
