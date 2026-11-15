import { QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  roleKeys,
  usePermissionCatalogQuery,
  useRoleUsersQuery,
  useRolesListQuery,
} from "../useRoles.js";
import { queryClient } from "@/lib/queryClient.js";

vi.mock("@/api/axios.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn() },
  getActiveBusinessId: () => 1,
}));

import axios from "@/api/axios.js";

const mockedGet = vi.mocked(axios.get);

function RolesProbe({ softFail = true }: { softFail?: boolean }) {
  const query = useRolesListQuery({ softFail });
  if (query.isPending) return <div>loading</div>;
  if (query.error) return <div>roles-error</div>;
  return <div>{(query.data ?? []).map((r) => r.name).join("|")}</div>;
}

function CatalogProbe() {
  const query = usePermissionCatalogQuery();
  if (query.isPending) return <div>loading</div>;
  if (query.isError) return <div>catalog-error</div>;
  return <div>{(query.data ?? []).length} entries</div>;
}

function RoleUsersProbe({ roleId }: { roleId: number | null }) {
  const query = useRoleUsersQuery(roleId);
  if (!roleId) return <div>disabled</div>;
  if (query.isPending) return <div>loading</div>;
  if (query.isError) return <div>role-users-error</div>;
  return <div>{(query.data ?? []).length} users</div>;
}

function renderProbe(ui: React.ReactElement) {
  return rtlRender(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>,
  );
}

describe("roles hooks (Phase 6 Feature 1 — roles domain)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    queryClient.setDefaultOptions({ queries: { retry: false } });
  });

  it("hard-fails on the Roles page contract: a roles outage surfaces as an error", async () => {
    mockedGet.mockRejectedValue({
      response: { status: 500, data: { message: "roles down" } },
    });
    renderProbe(<RolesProbe softFail={false} />);
    await waitFor(() =>
      expect(screen.getByText("roles-error")).toBeInTheDocument(),
    );
  });

  it("soft-fails to an empty list on the Users page contract", async () => {
    mockedGet.mockRejectedValue(new Error("roles down"));
    const { container } = renderProbe(<RolesProbe softFail />);
    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.textContent).toBe(""));
    expect(screen.queryByText("roles-error")).not.toBeInTheDocument();
  });

  it("loads the server permission catalog and keys it globally", async () => {
    mockedGet.mockResolvedValueOnce({
      data: { success: true, data: [{ key: "users.edit", module: "users" }] },
    } as never);
    renderProbe(<CatalogProbe />);
    await waitFor(() =>
      expect(screen.getByText("1 entries")).toBeInTheDocument(),
    );
    expect(
      mockedGet.mock.calls.some(([url]) => String(url).includes("permission")),
    ).toBe(true);
    expect(roleKeys.permissionCatalog()).toEqual(["permissions-catalog"]);
  });

  it("role-users query stays disabled until the dialog opens", async () => {
    renderProbe(<RoleUsersProbe roleId={null} />);
    expect(screen.getByText("disabled")).toBeInTheDocument();
    expect(mockedGet).not.toHaveBeenCalled();

    mockedGet.mockResolvedValueOnce({
      data: {
        success: true,
        data: [{ userId: 1, fullName: "A", email: "a@x", isActive: true }],
      },
    } as never);
    renderProbe(<RoleUsersProbe roleId={7} />);
    await waitFor(() => expect(screen.getByText("1 users")).toBeInTheDocument());
    expect(roleKeys.users(7)).toEqual(["roles", 1, 7, "users"]);
  });
});
