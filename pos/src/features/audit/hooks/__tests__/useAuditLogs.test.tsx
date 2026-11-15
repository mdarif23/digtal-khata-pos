import { QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { auditLogKeys, useAuditLogsQuery } from "../useAuditLogs.js";
import { queryClient } from "@/lib/queryClient.js";

vi.mock("../../../../api/axios.js", () => ({
  default: { get: vi.fn(), post: vi.fn() },
  getActiveBusinessId: () => 1,
}));

import axios from "../../../../api/axios.js";

const mockedGet = vi.mocked(axios.get);

function Probe({ filters }: { filters: Parameters<typeof getAuditLogApi>[0] }) {
  const query = useAuditLogsQuery(filters);
  if (query.isPending) return <div>loading</div>;
  if (query.error) return <div>error</div>;
  return <div>{(query.data?.rows ?? []).map((r) => r.id).join("|")}</div>;
}

// getAuditLogApi lives in audit.api — re-exported for the filter type above.
import { getAuditLogApi } from "../../audit.api";

function renderProbe(filters: Parameters<typeof getAuditLogApi>[0]) {
  return rtlRender(
    <QueryClientProvider client={queryClient}>
      <Probe filters={filters} />
    </QueryClientProvider>,
  );
}

describe("useAuditLogsQuery (Phase 6 Feature 1 — audit logs domain)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    queryClient.setDefaultOptions({ queries: { retry: false } });
  });

  it("loads a page of audit rows with the filter params", async () => {
    mockedGet.mockResolvedValueOnce({
      data: { success: true, data: { rows: [{ id: 3 }, { id: 8 }], total: 42 } },
    } as never);
    renderProbe({ limit: 50, offset: 0 });
    await waitFor(() => expect(screen.getByText("3|8")).toBeInTheDocument());
    const call = mockedGet.mock.calls[0];
    expect(String(call?.[0])).toContain("audit");
  });

  it("keys the list by business scope and full filters", () => {
    expect(auditLogKeys.all).toEqual(["audit-logs"]);
    expect(auditLogKeys.list({ limit: 50, offset: 0 })[3]).toEqual({
      limit: 50,
      offset: 0,
    });
  });

  it("surfaces failures as the error state (page toasts + empty list)", async () => {
    mockedGet.mockRejectedValue(new Error("audit down"));
    renderProbe({ limit: 50, offset: 0 });
    await waitFor(() => expect(screen.getByText("error")).toBeInTheDocument());
  });
});
