import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { userKeys, useUsersQuery } from "../useUsers.js";
import { roleKeys, useRolesListQuery } from "@/features/roles/hooks/useRoles.js";
import { locationKeys, useLocationsQuery } from "@/features/locations/hooks/useLocations.js";
import { queryClient } from "@/lib/queryClient.js";

vi.mock("@/api/axios.js", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn() },
  getActiveBusinessId: () => 1,
}));

import axios from "@/api/axios.js";

const mockedGet = vi.mocked(axios.get);

function Probe() {
  const users = useUsersQuery();
  const roles = useRolesListQuery();
  const locations = useLocationsQuery();
  const pending =
    users.isPending || roles.isPending || locations.isPending;
  if (pending) return <div>loading</div>;
  if (users.error) return <div>error</div>;
  return (
    <div>
      {[
        (users.data ?? []).map((m) => m.fullName).join("|"),
        (roles.data ?? []).map((r) => r.name).join("|"),
        (locations.data ?? []).map((l) => l.name).join("|"),
      ].join(" / ")}
    </div>
  );
}

describe("users/roles/locations queries (Phase 6 Feature 1 — users domain)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    queryClient.setDefaultOptions({ queries: { retry: false } });
  });

  it("loads the three lists in parallel and renders them", async () => {
    mockedGet.mockImplementation(async (url: string) => {
      if (String(url).includes("/users"))
        return { data: { success: true, data: [{ userId: 1, fullName: "Manager One" }] } } as never;
      if (String(url).includes("/roles"))
        return { data: { success: true, data: [{ id: 5, name: "Cashier" }] } } as never;
      if (String(url).includes("/locations"))
        return { data: { success: true, data: [{ id: 9, name: "Main Store" }] } } as never;
      throw new Error("unexpected GET " + String(url));
    });
    render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByText("Manager One / Cashier / Main Store"),
      ).toBeInTheDocument(),
    );
  });

  it("roles/locations failures soft-fail to empty (users outage semantics preserved)", async () => {
    mockedGet.mockImplementation(async (url: string) => {
      if (String(url).includes("/users"))
        return { data: { success: true, data: [{ userId: 1, fullName: "Manager One" }] } } as never;
      if (String(url).includes("/roles")) throw new Error("roles down");
      if (String(url).includes("/locations")) throw new Error("locations down");
      throw new Error("unexpected GET " + String(url));
    });
    render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText("Manager One / /")).toBeInTheDocument(),
    );
  });

  it("invalidate-on-signal (session version) refetches the users list", async () => {
    mockedGet.mockImplementation(async (url: string) => {
      if (String(url).includes("/users"))
        return { data: { success: true, data: [{ userId: 1, fullName: "Manager One" }] } } as never;
      if (String(url).includes("/roles")) return { data: [] } as never;
      if (String(url).includes("/locations")) return { data: [] } as never;
      throw new Error("unexpected GET " + String(url));
    });
    render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText("Manager One / /")).toBeInTheDocument(),
    );

    mockedGet.mockImplementation(async (url: string) => {
      if (String(url).includes("/users"))
        return {
          data: {
            success: true,
            data: [
              { userId: 1, fullName: "Manager One" },
              { userId: 2, fullName: "Manager Two" },
            ],
          },
        } as never;
      if (String(url).includes("/roles")) return { data: [] } as never;
      if (String(url).includes("/locations")) return { data: [] } as never;
      throw new Error("unexpected GET " + String(url));
    });
    await queryClient.invalidateQueries({ queryKey: userKeys.all });
    await waitFor(() =>
      expect(screen.getByText("Manager One|Manager Two / /")).toBeInTheDocument(),
    );
  });

  it("keys the three lists by business scope", () => {
    expect(userKeys.all).toEqual(["users"]);
    expect(userKeys.list()).toEqual(["users", 1, "list"]);
    expect(roleKeys.list()).toEqual(["roles", 1, "list"]);
    expect(locationKeys.list()).toEqual(["locations", 1, "list"]);
  });
});
