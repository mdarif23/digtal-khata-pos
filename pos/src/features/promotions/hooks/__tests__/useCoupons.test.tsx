import { QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { couponKeys, useCouponsQuery } from "../useCoupons.js";
import { queryClient } from "@/lib/queryClient.js";

vi.mock("../../../../api/axios.js", () => ({
  // R3-001: coupon keys are business-scoped — the mock needs the helper.
  getActiveBusinessId: () => 1,
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

import axios from "../../../../api/axios.js";

const mockedGet = vi.mocked(axios.get);

function Probe() {
  const query = useCouponsQuery();
  if (query.isPending) return <div>loading</div>;
  if (query.error) return <div>error</div>;
  return <div>{(query.data ?? []).map((c) => c.code).join("|")}</div>;
}

function renderProbe() {
  return rtlRender(
    <QueryClientProvider client={queryClient}>
      <Probe />
    </QueryClientProvider>,
  );
}

describe("useCouponsQuery (Phase 6 Feature 1 — coupons domain)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    queryClient.setDefaultOptions({ queries: { retry: false } });
  });

  it("loads the coupon list (unwraps { data }) and renders codes", async () => {
    mockedGet.mockResolvedValueOnce({
      data: { data: [{ id: 1, code: "SAVE10" }, { id: 2, code: "WELCOME5" }] },
    } as never);
    renderProbe();
    await waitFor(() =>
      expect(screen.getByText("SAVE10|WELCOME5")).toBeInTheDocument(),
    );
    expect(mockedGet).toHaveBeenCalledWith("/coupons");
  });

  it("surfaces failures as the error state (the page toasts + renders empty)", async () => {
    mockedGet.mockRejectedValue(new Error("coupons down"));
    renderProbe();
    await waitFor(() => expect(screen.getByText("error")).toBeInTheDocument());
  });

  it("keys the list", () => {
    expect(couponKeys.all).toEqual(["coupons"]);
    // R3-001: keys carry the active business id.
    expect(couponKeys.list()).toEqual(["coupons", 1, "list"]);
  });
});
