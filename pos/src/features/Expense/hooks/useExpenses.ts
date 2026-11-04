import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  archiveExpenseCategoryApi,
  createExpenseApi,
  createExpenseCategoryApi,
  exportExpensesApi,
  getExpenseApi,
  getExpenseCategoriesApi,
  getExpensesApi,
  recordExpensePaymentApi,
  restoreExpenseCategoryApi,
  updateExpenseApi,
  updateExpenseCategoryApi,
  voidExpenseApi,
  voidExpensePaymentApi,
} from "@/api/expenses.api";
import type {
  ExpenseDraft,
  ExpenseListFilters,
} from "../expense.type";
import type { ExpensePaymentPayload } from "@/api/expenses.api";

/** Query-key factory — follows the online-orders/due-management convention. */
export const expenseKeys = {
  all: ["expenses"] as const,
  list: (filters: ExpenseListFilters) =>
    [...expenseKeys.all, "list", filters] as const,
  detail: (id: number) => [...expenseKeys.all, "detail", id] as const,
  categories: (includeArchived: boolean) =>
    [...expenseKeys.all, "categories", includeArchived] as const,
};

export function useExpensesList(filters: ExpenseListFilters) {
  return useQuery({
    queryKey: expenseKeys.list(filters),
    queryFn: () => getExpensesApi(filters),
    placeholderData: keepPreviousData,
  });
}

export function useExpenseDetail(id: number) {
  return useQuery({
    queryKey: expenseKeys.detail(id),
    queryFn: () => getExpenseApi(id),
    enabled: id > 0,
  });
}

export function useExpenseCategories(includeArchived = false) {
  return useQuery({
    queryKey: expenseKeys.categories(includeArchived),
    queryFn: () => getExpenseCategoriesApi(includeArchived),
  });
}

function useInvalidateExpenses() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: expenseKeys.all });
  };
}

export function useCreateExpense() {
  const invalidate = useInvalidateExpenses();
  return useMutation({
    mutationFn: (draft: ExpenseDraft) => createExpenseApi(draft),
    onSuccess: invalidate,
  });
}

export function useUpdateExpense() {
  const invalidate = useInvalidateExpenses();
  return useMutation({
    mutationFn: (input: { id: number; draft: ExpenseDraft }) =>
      updateExpenseApi(input.id, input.draft),
    onSuccess: invalidate,
  });
}

export function useVoidExpense() {
  const invalidate = useInvalidateExpenses();
  return useMutation({
    mutationFn: (input: { id: number; reason?: string }) =>
      voidExpenseApi(input.id, input.reason),
    onSuccess: invalidate,
  });
}

/** Record a settlement against an expense (expenses.pay permission). */
export function useRecordExpensePayment() {
  const invalidate = useInvalidateExpenses();
  return useMutation({
    mutationFn: (input: { expenseId: number; payload: ExpensePaymentPayload }) =>
      recordExpensePaymentApi(input.expenseId, input.payload),
    onSuccess: invalidate,
  });
}

/** Corrective void of a settlement (expenses.delete permission). */
export function useVoidExpensePayment() {
  const invalidate = useInvalidateExpenses();
  return useMutation({
    mutationFn: (input: { expenseId: number; paymentId: number }) =>
      voidExpensePaymentApi(input.expenseId, input.paymentId),
    onSuccess: invalidate,
  });
}

export interface CategoryWritePayload {
  categoryName: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
}

export function useCreateExpenseCategory() {
  const invalidate = useInvalidateExpenses();
  return useMutation({
    mutationFn: (payload: CategoryWritePayload) =>
      createExpenseCategoryApi(payload),
    onSuccess: invalidate,
  });
}

/** Category lifecycle — all gated server-side by expenses.edit. */
export function useUpdateExpenseCategory() {
  const invalidate = useInvalidateExpenses();
  return useMutation({
    mutationFn: (input: { id: number; payload: CategoryWritePayload }) =>
      updateExpenseCategoryApi(input.id, input.payload),
    onSuccess: invalidate,
  });
}

export function useArchiveExpenseCategory() {
  const invalidate = useInvalidateExpenses();
  return useMutation({
    mutationFn: (id: number) => archiveExpenseCategoryApi(id),
    onSuccess: invalidate,
  });
}

export function useRestoreExpenseCategory() {
  const invalidate = useInvalidateExpenses();
  return useMutation({
    mutationFn: (id: number) => restoreExpenseCategoryApi(id),
    onSuccess: invalidate,
  });
}

/** CSV export uses the same server filters, so the file matches the view. */
export function useExportExpenses() {
  return useMutation({
    mutationFn: (filters: ExpenseListFilters) => exportExpensesApi(filters),
  });
}
