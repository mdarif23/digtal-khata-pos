import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Expense } from "./Expense";
import type {
  ExpenseListResponse,
  ExpenseRecord,
} from "./expense.type";

vi.mock("@/api/expenses.api", () => ({
  getExpensesApi: vi.fn(() => Promise.resolve(mockedList)),
  getExpenseCategoriesApi: vi.fn(() =>
    Promise.resolve([{ id: 7, categoryName: "Rent" }]),
  ),
  getExpenseApi: vi.fn(),
  getExpenseAnalyticsApi: vi.fn(() =>
    Promise.resolve({
      range: { from: "2025-12-01", to: "2026-11-30", granularity: "month" },
      totals: {
        totalCount: 0,
        totalAmount: 0,
        totalPaid: 0,
        totalDue: 0,
        averageAmount: 0,
        unpaidCount: 0,
        partialCount: 0,
        paidCount: 0,
      },
      comparison: {
        currentMonth: "2026-11-01",
        currentAmount: 0,
        previousAmount: 0,
        growthPercent: null,
      },
      series: [],
      categories: [],
      paymentMethods: [],
      locations: [],
    }),
  ),
  exportExpensesApi: vi.fn(() => Promise.resolve([])),
  createExpenseApi: vi.fn(),
  updateExpenseApi: vi.fn(),
  voidExpenseApi: vi.fn(),
  createExpenseCategoryApi: vi.fn(),
}));

vi.mock("./components/ExpenseDialog", async (importOriginal) => {
  // The dialogs pull in the toast manager — stub the create/edit dialog so
  // this suite only exercises the list page behaviour.
  void importOriginal;
  return {
    ExpenseDialog: () => <button type="button">Add expense</button>,
    ExpenseDialogMockSentinel: true,
  };
});

vi.mock("./components/ExpenseCategoriesDialog", () => ({
  ExpenseCategoriesDialog: () => (
    <button type="button">Categories</button>
  ),
}));

const row = (overrides: Partial<ExpenseRecord>): ExpenseRecord => ({
  id: 1,
  title: "Rent",
  payee: null,
  amount: 1000,
  paidAmount: 1000,
  paymentStatus: "paid",
  paymentMethod: "Cash",
  categoryId: 7,
  categoryName: "Rent",
  locationId: null,
  locationName: null,
  channel: null,
  referenceNo: null,
  note: null,
  expenseDate: "2026-11-01",
  createdAt: null,
  ...overrides,
});

const mockedList: ExpenseListResponse = {
  data: [
    row({ id: 1, title: "Rent", paymentStatus: "paid" }),
    row({
      id: 2,
      title: "Supply bill",
      amount: 500,
      paidAmount: 200,
      paymentStatus: "partial",
    }),
    row({ id: 3, title: "Team lunch", amount: 300, paidAmount: 0, paymentStatus: "unpaid" }),
  ],
  meta: {
    page: 1,
    pageSize: 25,
    total: 3,
    totalPages: 1,
    summary: {
      totalAmount: 1800,
      totalPaid: 1200,
      totalDue: 600,
      unpaidCount: 1,
      partialCount: 1,
      paidCount: 1,
    },
  },
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Expense />
    </QueryClientProvider>,
  );
}

describe("Expense page", () => {
  it("renders overview metrics from the server summary", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("৳1,800.00")).toBeInTheDocument();
    });
    expect(screen.getByText("৳600.00")).toBeInTheDocument();
    expect(screen.getByText("3 expenses · page 1 of 1")).toBeInTheDocument();
  });

  it("renders payment status badges per row", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Supply bill")).toBeInTheDocument();
    });
    expect(screen.getByText("Partial")).toBeInTheDocument();
    expect(screen.getByText("Unpaid")).toBeInTheDocument();
    expect(screen.getAllByText("Paid").length).toBeGreaterThan(0);
  });

  it("requests server-side pagination and default sorting", async () => {
    const { getExpensesApi } = await import("@/api/expenses.api");
    renderPage();
    await waitFor(() => {
      expect(getExpensesApi).toHaveBeenCalled();
    });
    expect(getExpensesApi).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        pageSize: 25,
        sort: "expense_date",
        sortDir: "desc",
      }),
    );
  });
});
