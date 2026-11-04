import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExpenseDetailsDrawer } from "./components/ExpenseDetailsDrawer";
import type { ExpenseDetail } from "./expense.type";

vi.mock("@/api/expenses.api", () => ({
  getExpenseApi: vi.fn(() => Promise.resolve(mockDetail)),
  recordExpensePaymentApi: vi.fn(),
  voidExpensePaymentApi: vi.fn(),
  getCurrentRegisterSessionApi: vi.fn(() => Promise.resolve(null)),
}));

// The test session holds no permissions — render guarded buttons directly so
// this suite exercises drawer behaviour, not the permission snapshot.
vi.mock("@/components/common/PermissionGuard", () => ({
  PermissionButton: ({
    children,
    ...props
  }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  PermissionGuard: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
  RequirePermission: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("./components/ExpensePaymentDialog", () => ({
  ExpensePaymentDialog: () => (
    <div data-testid="payment-dialog-sentinel">payment dialog</div>
  ),
}));

const detail = (overrides: Partial<ExpenseDetail>): ExpenseDetail => ({
  id: 1,
  title: "Supply bill",
  payee: null,
  amount: 500,
  paidAmount: 200,
  paymentStatus: "partial",
  paymentMethod: "Cash",
  categoryId: null,
  categoryName: null,
  locationId: null,
  locationName: null,
  channel: null,
  referenceNo: null,
  note: null,
  expenseDate: "2026-11-01",
  createdAt: null,
  dueAmount: 300,
  payments: [],
  createdBy: null,
  updatedBy: null,
  deletedAt: null,
  voidReason: null,
  ...overrides,
});

const mockDetail = detail({
  payments: [
    {
      id: 11,
      amount: 200,
      paymentMethod: "Cash",
      paymentDate: "2026-11-02",
      referenceNo: null,
      note: null,
      recordedBy: null,
      registerSessionId: null,
      createdAt: null,
    },
  ],
});

function renderDrawer() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ExpenseDetailsDrawer
        expenseId={1}
        open
        onOpenChange={() => undefined}
      />
    </QueryClientProvider>,
  );
}

describe("ExpenseDetailsDrawer", () => {
  it("renders the balance and settlement history for a partially paid expense", async () => {
    renderDrawer();
    await waitFor(() => {
      expect(screen.getByText("Supply bill")).toBeInTheDocument();
    });
    expect(screen.getAllByText(/300\.00/).length).toBeGreaterThan(0); // due
    expect(screen.getAllByText(/200\.00/).length).toBeGreaterThan(0); // settlement row
    expect(screen.getByText("Record payment")).toBeInTheDocument();
    expect(screen.getByTestId("payment-dialog-sentinel")).toBeInTheDocument();
  });

  it("hides the record-payment action once the expense is fully settled", async () => {
    vi.mocked(
      (await import("@/api/expenses.api")).getExpenseApi,
    ).mockResolvedValueOnce(
      detail({
        paidAmount: 500,
        paymentStatus: "paid",
        dueAmount: 0,
        payments: [
          {
            id: 12,
            amount: 500,
            paymentMethod: "Card",
            paymentDate: "2026-11-02",
            referenceNo: null,
            note: null,
            recordedBy: null,
            registerSessionId: null,
            createdAt: null,
          },
        ],
      }),
    );
    renderDrawer();
    await waitFor(() => {
      expect(screen.getByText("Supply bill")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByText("Record payment")).not.toBeInTheDocument();
    });
  });
});
