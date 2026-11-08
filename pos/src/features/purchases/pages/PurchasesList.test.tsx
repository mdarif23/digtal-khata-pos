import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PurchasesList } from "./PurchasesList";

vi.mock("@/api/axios", () => ({ default: { get: vi.fn() } }));
import axios from "@/api/axios";

const mockedGet = vi.mocked(axios.get);

const cannedPage = {
  data: [
    {
      id: 11,
      purchaseOrderNumber: "PO-2026-000011",
      purchaseDate: "2026-11-07T00:00:00.000Z",
      supplierId: 3,
      supplierName: "Acme Traders",
      supplierPhone: "+8801711000000",
      receivingStatus: "received",
      returnStatus: null,
      fullyCancelled: false,
      totalItems: 2,
      orderedQuantity: 10,
      acceptedReceivedQuantity: 10,
      rejectedQuantity: 0,
      cancelledQuantity: 0,
      returnedQuantity: 0,
      outstandingQuantity: 0,
      subtotal: 1000,
      discount: 0,
      tax: 0,
      shippingCost: 0,
      landedCostStatus: null,
      totalAmount: 1000,
      paidAmount: 400,
      dueAmount: 600,
      paymentStatus: "partial",
      notes: null,
      createdAt: "2026-11-07T00:00:00.000Z",
      updatedAt: "2026-11-07T00:00:00.000Z",
    },
    {
      id: 12,
      purchaseOrderNumber: "PO-2026-000012",
      purchaseDate: "2026-11-06T00:00:00.000Z",
      supplierId: 3,
      supplierName: "Acme Traders",
      supplierPhone: "+8801711000000",
      receivingStatus: "partially_received",
      returnStatus: "Partially returned",
      fullyCancelled: false,
      totalItems: 1,
      orderedQuantity: 10,
      acceptedReceivedQuantity: 6,
      rejectedQuantity: 0,
      cancelledQuantity: 0,
      returnedQuantity: 2,
      outstandingQuantity: 4,
      subtotal: 1000,
      discount: 0,
      tax: 0,
      shippingCost: 0,
      landedCostStatus: "pending",
      totalAmount: 1000,
      paidAmount: 0,
      dueAmount: 1000,
      paymentStatus: "unpaid",
      notes: null,
      createdAt: "2026-11-06T00:00:00.000Z",
      updatedAt: "2026-11-06T00:00:00.000Z",
    },
  ],
  pagination: { page: 1, pageSize: 25, totalItems: 2, totalPages: 1 },
  counts: {
    all: 2,
    ordered: 0,
    partially_received: 1,
    received: 1,
    partially_returned: 1,
    returned: 0,
    cancelled: 0,
  },
  summary: {
    totalPurchases: 2,
    awaitingReceipt: 1,
    outstandingBalance: 1600,
  },
};

function renderList(route = "/purchases-list") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <PurchasesList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedGet.mockReset();
  mockedGet.mockResolvedValue({ data: cannedPage });
});

describe("PurchasesList (server-driven, Phase 6-8)", () => {
  it("renders tab labels with SERVER counts and the purchase rows", async () => {
    renderList();

    await waitFor(() =>
      expect(screen.getByText("PO-2026-000011")).toBeInTheDocument(),
    );
    // Server counts drive the tab badges (scoped to the tab buttons —
    // row badges share label text).
    expect(screen.getByRole("button", { name: /All orders/ })).toHaveTextContent(
      "2",
    );
    expect(
      screen.getByRole("button", { name: /Partially received/ }),
    ).toHaveTextContent("1");
    expect(
      screen.getByRole("button", { name: /Partially returned/ }),
    ).toHaveTextContent("1");
    // Two-dimension display: receiving badge + return badge coexist on a row.
    const rowBadges = screen.getAllByText("Partially returned");
    expect(rowBadges.length).toBeGreaterThanOrEqual(2); // tab + row badge
    // Summary cards come from the server summary.
    expect(screen.getByText("৳ 1,600.00")).toBeInTheDocument(); // outstanding balance
  });

  it("issues exactly ONE list request on mount (no duplicates)", async () => {
    renderList();
    await waitFor(() =>
      expect(screen.getByText("PO-2026-000011")).toBeInTheDocument(),
    );
    const listCalls = mockedGet.mock.calls.filter(([url]) =>
      String(url).includes("/purchases/list"),
    );
    expect(listCalls).toHaveLength(1);
  });

  it("shows the loading skeleton before data arrives", async () => {
    let resolve!: (value: { data: unknown }) => void;
    mockedGet.mockImplementation(
      () =>
        new Promise((res) => {
          resolve = res as typeof resolve;
        }),
    );
    renderList();
    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();

    resolve({ data: cannedPage });
    await waitFor(() =>
      expect(screen.getByText("PO-2026-000011")).toBeInTheDocument(),
    );
  });

  it("shows the request error independently of the empty state", async () => {
    mockedGet.mockRejectedValue(new Error("Network down"));
    renderList();
    await waitFor(() => expect(screen.getByText("Network down")).toBeInTheDocument());
    expect(screen.queryByText("No purchase orders yet")).not.toBeInTheDocument();
  });

  it("distinguishes filtered-empty from no-orders-at-all", async () => {
    const empty = {
      ...cannedPage,
      data: [],
      counts: {
        all: 0,
        ordered: 0,
        partially_received: 0,
        received: 0,
        partially_returned: 0,
        returned: 0,
        cancelled: 0,
      },
      summary: { totalPurchases: 0, awaitingReceipt: 0, outstandingBalance: 0 },
    };
    // A tab filter is active via the URL → "no matching" copy.
    mockedGet.mockResolvedValue({ data: empty });
    renderList("/purchases-list?tab=returned");
    await waitFor(() =>
      expect(screen.getByText("No matching purchase orders")).toBeInTheDocument(),
    );

    // No filters at all → "no orders yet" + create CTA.
    renderList();
    await waitFor(() =>
      expect(screen.getByText("No purchase orders yet")).toBeInTheDocument(),
    );
  });

  it("debounces search into a single request and hits the server param", async () => {
    const user = userEvent.setup();
    renderList();
    await waitFor(() =>
      expect(screen.getByText("PO-2026-000011")).toBeInTheDocument(),
    );
    const callsBefore = mockedGet.mock.calls.length;

    await user.type(screen.getByLabelText("Search purchase orders"), "acme");
    // Debounced: the trailing request carries the trimmed search param.
    await waitFor(() => {
      const last = mockedGet.mock.calls.at(-1)?.[0] as string;
      expect(last).toContain("search=acme");
    });
    // One debounced request for the whole typing burst (not per keystroke).
    const listCalls = mockedGet.mock.calls.filter(([url]) =>
      String(url).includes("/purchases/list"),
    );
    expect(listCalls.length).toBeLessThanOrEqual(callsBefore + 2);
  });

  it("paginates server-side: Next requests page 2", async () => {
    const user = userEvent.setup();
    // More than one page from the start so Next is enabled.
    mockedGet.mockResolvedValue({
      data: {
        ...cannedPage,
        pagination: { page: 1, pageSize: 25, totalItems: 30, totalPages: 2 },
      },
    });
    renderList();
    await waitFor(() =>
      expect(screen.getByText("PO-2026-000011")).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => {
      const last = mockedGet.mock.calls.at(-1)?.[0] as string;
      expect(last).toContain("page=2");
    });
  });
});
