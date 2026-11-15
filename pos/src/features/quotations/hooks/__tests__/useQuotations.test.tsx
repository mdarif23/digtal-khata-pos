import { QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  quotationKeys,
  useQuotationsQuery,
  type QuotationListFilters,
} from "../useQuotations.js";
import { queryClient } from "@/lib/queryClient.js";

vi.mock("../../../../api/axios.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  getActiveBusinessId: () => 1,
}));

import axios from "../../../../api/axios.js";

const mockedGet = vi.mocked(axios.get);

function Probe({ filters }: { filters: QuotationListFilters }) {
  const query = useQuotationsQuery(filters);
  if (query.isPending) return <div>loading</div>;
  if (query.error) return <div>error</div>;
  return (
    <div>
      {(query.data?.rows ?? []).map((r) => r.id).join("|")} / {query.data?.total}
    </div>
  );
}

function renderProbe(filters: QuotationListFilters) {
  return rtlRender(
    <QueryClientProvider client={queryClient}>
      <Probe filters={filters} />
    </QueryClientProvider>,
  );
}

describe("useQuotationsQuery (Phase 6 Feature 1 — quotations domain)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    queryClient.setDefaultOptions({ queries: { retry: false } });
  });

  it("loads the filtered list (rows + total) and renders them", async () => {
    mockedGet.mockResolvedValueOnce({
      data: { success: true, data: { rows: [{ id: 4 }, { id: 9 }], total: 2 } },
    } as never);
    renderProbe({});
    await waitFor(() =>
      expect(screen.getByText("4|9 / 2")).toBeInTheDocument(),
    );
    expect(mockedGet).toHaveBeenCalledWith("/quotations", expect.anything());
  });

  it("passes status/search filters through in the fetch and the key", async () => {
    mockedGet.mockResolvedValueOnce({
      data: { success: true, data: { rows: [{ id: 4 }], total: 1 } },
    } as never);
    renderProbe({ status: "sent" as const, search: "acme" });
    await waitFor(() => expect(screen.getByText("4 / 1")).toBeInTheDocument());
    expect(String(mockedGet.mock.calls[0]?.[0])).toContain("/quotations");
    expect(mockedGet.mock.calls[0]?.[1]).toEqual({
      params: { status: "sent", search: "acme" },
    });
    expect(quotationKeys.list({ status: "sent" })[3]).toEqual({
      status: "sent",
    });
  });

  it("surfaces failures as the error state (page toasts via the error-effect)", async () => {
    mockedGet.mockRejectedValue(new Error("quotations down"));
    renderProbe({});
    await waitFor(() => expect(screen.getByText("error")).toBeInTheDocument());
  });
});
