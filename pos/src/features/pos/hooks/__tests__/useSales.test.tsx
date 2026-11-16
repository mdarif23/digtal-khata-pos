import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { saleKeys, useSalesQuery } from "../useSales.js";
import { queryClient } from "@/lib/queryClient.js";

vi.mock("@/api/axios.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  getActiveBusinessId: () => 1,
  getActiveLocationId: () => 2,
}));

import axios from "@/api/axios.js";

const mockedGet = vi.mocked(axios.get);

function Probe() {
  const query = useSalesQuery();
  if (query.isPending) return <div>loading</div>;
  if (query.error) return <div>error</div>;
  return <div>{(query.data ?? []).map((s) => s.id).join("|")}</div>;
}

function renderProbe() {
  // The library singleton queryClient — cleared between tests.
  queryClient.setDefaultOptions({ queries: { retry: false } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Probe />
    </QueryClientProvider>,
  );
}

describe("useSalesQuery (Phase 6 Feature 1 — sales list domain)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    queryClient.setDefaultOptions({ queries: { retry: false } });
  });

  it("loads the sold-products list and renders it", async () => {
    mockedGet.mockResolvedValueOnce({
      data: [{ id: 1 }, { id: 2 }],
    } as never);
    renderProbe();
    await waitFor(() => expect(screen.getByText("1|2")).toBeInTheDocument());
    expect(mockedGet).toHaveBeenCalledWith("/sold_products");
  });

  it("invalidate-on-signal refetches the list", async () => {
    mockedGet
      .mockResolvedValueOnce({ data: [{ id: 1 }] } as never)
      .mockResolvedValueOnce({ data: [{ id: 1 }, { id: 2 }] } as never);
    renderProbe();
    await waitFor(() => expect(screen.getByText("1")).toBeInTheDocument());

    await queryClient.invalidateQueries({ queryKey: saleKeys.all });

    await waitFor(() => expect(screen.getByText("1|2")).toBeInTheDocument());
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it("keys the list by business + location scope", () => {
    expect(saleKeys.all).toEqual(["sales"]);
    expect(saleKeys.list()).toEqual(["sales", 1, 2, "list"]);
  });
});
