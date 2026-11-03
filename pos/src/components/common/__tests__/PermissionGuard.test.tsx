import { render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "@/auth/sessionStore";
import { usePermissions } from "@/hooks/usePermissions";
import {
  PermissionButton,
  PermissionGuard,
  RequirePermission,
} from "../PermissionGuard";

// UX-only shaping of the interface — the backend re-verifies every request.
// These tests pin what the UI promises, nothing about security.

const cashierPermissions = ["pos.view", "pos.create_sale"];

function loginAs(permissions: string[]) {
  useSessionStore.getState().setSession({
    user: { id: 1, fullName: "Cashier", email: "cashier@example.test" },
    businessId: 1,
    roleSlug: "cashier",
    roleName: "Cashier",
    roles: [],
    permissions,
  });
}

beforeEach(() => {
  loginAs(cashierPermissions);
});

describe("usePermissions", () => {
  it("matches exact permissions", () => {
    const { result } = renderHook(() => usePermissions());
    expect(result.current.hasPermission("pos.create_sale")).toBe(true);
    expect(result.current.hasPermission("products.view_cost")).toBe(false);
  });

  it("treats the wildcard as every permission", () => {
    loginAs(["*"]);
    const { result } = renderHook(() => usePermissions());
    expect(result.current.hasPermission("anything.at.all")).toBe(true);
  });

  it("evaluates any/all combinations (empty any passes)", () => {
    const { result } = renderHook(() => usePermissions());
    expect(
      result.current.hasAnyPermission(["products.view_cost", "pos.create_sale"]),
    ).toBe(true);
    expect(result.current.hasAnyPermission(["products.view_cost"])).toBe(false);
    expect(result.current.hasAnyPermission([])).toBe(true);
    expect(
      result.current.hasAllPermissions(["pos.view", "pos.create_sale"]),
    ).toBe(true);
    expect(
      result.current.hasAllPermissions(["pos.view", "products.view_cost"]),
    ).toBe(false);
  });
});

describe("RequirePermission", () => {
  it("renders the route when the permission is held", () => {
    render(
      <MemoryRouter initialEntries={["/pos"]}>
        <Routes>
          <Route
            path="/pos"
            element={
              <RequirePermission permission="pos.create_sale">
                <div>guarded page</div>
              </RequirePermission>
            }
          />
          <Route path="/403" element={<div>forbidden</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("guarded page")).toBeInTheDocument();
    expect(screen.queryByText("forbidden")).not.toBeInTheDocument();
  });

  it("redirects to /403 when the permission is missing", () => {
    render(
      <MemoryRouter initialEntries={["/reports"]}>
        <Routes>
          <Route
            path="/reports"
            element={
              <RequirePermission permission="reports.profit.view">
                <div>guarded page</div>
              </RequirePermission>
            }
          />
          <Route path="/403" element={<div>forbidden</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByText("guarded page")).not.toBeInTheDocument();
    expect(screen.getByText("forbidden")).toBeInTheDocument();
  });

  it("denies unless ALL allPermissions are held", () => {
    render(
      <MemoryRouter initialEntries={["/x"]}>
        <Routes>
          <Route
            path="/x"
            element={
              <RequirePermission
                allPermissions={["pos.view", "products.view_cost"]}
              >
                <div>guarded page</div>
              </RequirePermission>
            }
          />
          <Route path="/403" element={<div>forbidden</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("forbidden")).toBeInTheDocument();
  });
});

describe("PermissionGuard", () => {
  it("renders children when allowed and the fallback when denied", () => {
    render(
      <>
        <PermissionGuard permission="pos.create_sale" fallback={<div>nope</div>}>
          <div>allowed section</div>
        </PermissionGuard>
        <PermissionGuard
          permission="products.view_cost"
          fallback={<div>nope</div>}
        >
          <div>cost section</div>
        </PermissionGuard>
      </>,
    );
    expect(screen.getByText("allowed section")).toBeInTheDocument();
    expect(screen.queryByText("cost section")).not.toBeInTheDocument();
    expect(screen.getByText("nope")).toBeInTheDocument();
  });

  it("renders when every permission in anyPermission is held", () => {
    render(
      <PermissionGuard anyPermission={["pos.view", "pos.create_sale"]}>
        <div>both-held section</div>
      </PermissionGuard>,
    );
    expect(screen.getByText("both-held section")).toBeInTheDocument();
  });

  it("BUG PIN: anyPermission is evaluated with ALL semantics, not ANY", () => {
    // PermissionGuard.tsx passes every prop through hasAllPermissions, so a
    // multi-item anyPermission requires ALL of them. The cashier below holds
    // pos.create_sale but not products.view_cost — the section stays hidden
    // even though one permission matches. If the component is ever corrected
    // to true ANY semantics, this test must flip with it.
    render(
      <PermissionGuard anyPermission={["products.view_cost", "pos.create_sale"]}>
        <div>either section</div>
      </PermissionGuard>,
    );
    expect(screen.queryByText("either section")).not.toBeInTheDocument();
  });

  it("renders when a single-item anyPermission matches", () => {
    render(
      <PermissionGuard anyPermission={["pos.create_sale"]}>
        <div>single section</div>
      </PermissionGuard>,
    );
    expect(screen.getByText("single section")).toBeInTheDocument();
  });
});

describe("PermissionButton", () => {
  it("renders and fires when the permission is held", async () => {
    const onClick = vi.fn();
    render(
      <PermissionButton permission="pos.create_sale" onClick={onClick}>
        Save sale
      </PermissionButton>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save sale" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when the permission is missing", () => {
    render(
      <PermissionButton permission="products.view_cost">
        Delete product
      </PermissionButton>,
    );
    expect(
      screen.queryByRole("button", { name: "Delete product" }),
    ).not.toBeInTheDocument();
  });
});
