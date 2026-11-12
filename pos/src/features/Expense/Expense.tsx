import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  CalendarDays,
  Download,
  ReceiptText,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ContactListLayout } from "@/features/Contacts/components/ContactListLayout";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { exportToCsv } from "@/features/reports/utils/reportUtils";
import { getErrorMessage } from "@/utils/getErrorMessage";
import { useSessionStore } from "@/auth/sessionStore";
import { ExpenseDialog } from "./components/ExpenseDialog";
import { ExpenseCategoriesDialog } from "./components/ExpenseCategoriesDialog";
import { RecurringTemplatesDialog } from "./components/RecurringTemplatesDialog";
import { ExpenseAnalyticsPanel } from "./components/ExpenseAnalyticsPanel";
import { ExpensesTable, EXPENSE_SORT_OPTIONS } from "./components/ExpensesTable";
import type {
  ExpenseListFilters,
  ExpensePaymentMethod,
  ExpensePaymentStatus,
  ExpenseRecord,
} from "./expense.type";
import { useExportExpenses, useExpensesList, useExpenseCategories } from "./hooks/useExpenses";

type SortField = (typeof EXPENSE_SORT_OPTIONS)[number]["field"];

const PAGE_SIZE = 25;

interface FilterState {
  search: string;
  category: string;
  status: string;
  method: string;
  dateFrom: string;
  dateTo: string;
  locationId: string;
}

const EMPTY_FILTERS: FilterState = {
  search: "",
  category: "all",
  status: "all",
  method: "all",
  dateFrom: "",
  dateTo: "",
  locationId: "all",
};

function buildFilters(
  filters: FilterState,
  deferredSearch: string,
  sort: SortField,
  sortDir: ExpenseListFilters["sortDir"],
  page: number,
): ExpenseListFilters {
  return {
    page,
    pageSize: PAGE_SIZE,
    search: deferredSearch || undefined,
    categoryId:
      filters.category === "all"
        ? undefined
        : filters.category === "none"
          ? "none"
          : Number(filters.category),
    paymentStatus:
      filters.status === "all"
        ? undefined
        : (filters.status as ExpensePaymentStatus),
    paymentMethod:
      filters.method === "all" ? undefined : (filters.method as ExpensePaymentMethod),
    dateFrom: filters.dateFrom || undefined,
    dateTo: filters.dateTo || undefined,
    locationId:
      filters.locationId === "all" ? undefined : Number(filters.locationId),
    sort,
    sortDir,
  };
}

function getCsvValue(value: string | number) {
  let text = String(value);
  // Formula-injection guard: neutralise cells that spreadsheet apps may
  // execute, including whitespace-prefixed attempts like "  =cmd".
  if (/^[\t\r ]*[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

export function Expense() {
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [sort, setSort] = useState<SortField>("expense_date");
  const [sortDir, setSortDir] = useState<ExpenseListFilters["sortDir"]>("desc");
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);

  const deferredSearch = useDeferredValue(filters.search);
  const queryFilters = useMemo(
    () => buildFilters(filters, deferredSearch, sort, sortDir, page),
    [filters, deferredSearch, sort, sortDir, page],
  );

  const list = useExpensesList(queryFilters);
  const categoriesQuery = useExpenseCategories();
  const exportMutation = useExportExpenses();

  const locations = useSessionStore((state) => state.locations);

  // Any filter change resets pagination.
  useEffect(() => {
    setPage(1);
  }, [deferredSearch, filters.category, filters.status, filters.method, filters.dateFrom, filters.dateTo, filters.locationId]);

  const invalidDateRange = Boolean(
    filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo,
  );

  const expenses = list.data?.data ?? [];
  const meta = list.data?.meta;
  const summary = meta?.summary;

  const hasFilters =
    filters.search !== "" ||
    filters.category !== "all" ||
    filters.status !== "all" ||
    filters.method !== "all" ||
    filters.dateFrom !== "" ||
    filters.dateTo !== "" ||
    filters.locationId !== "all";

  const clearFilters = useCallback(() => {
    setFilters(EMPTY_FILTERS);
  }, []);

  function handleSortChange(field: SortField) {
    if (field === sort) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSort(field);
      setSortDir("desc");
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      const rows = await exportMutation.mutateAsync(queryFilters);
      exportExpenseRows(rows);
    } catch (exportError: unknown) {
      setActionError(getErrorMessage(exportError));
    } finally {
      setExporting(false);
    }
  }

  const metrics = [
    {
      label: "Total recorded",
      value:
        list.isError || !summary
          ? "—"
          : list.isLoading
            ? "…"
            : String(meta?.total ?? 0),
      description: "Active expense records matching your filters",
    },
    {
      label: "Total amount",
      value:
        list.isError || !summary
          ? "—"
          : list.isLoading
            ? "…"
            : `৳${summary.totalAmount.toFixed(2)}`,
      description: "Cost incurred across matching expenses",
    },
    {
      label: "Outstanding",
      value:
        list.isError || !summary
          ? "—"
          : list.isLoading
            ? "…"
            : `৳${summary.totalDue.toFixed(2)}`,
      description: `${summary ? summary.unpaidCount + summary.partialCount : 0} unpaid or partial expense(s)`,
    },
  ];

  return (
    <ContactListLayout
      title="Expenses"
      description="Track business spending, review payment status, and keep your records organized."
      action={
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={exporting || !expenses.length}
            onClick={() => void handleExport()}
          >
            <Download />
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
          <ExpenseCategoriesDialog />
          <RecurringTemplatesDialog categories={categoriesQuery.data ?? []} />
          <ExpenseDialog categories={categoriesQuery.data ?? []} />
        </div>
      }
      metrics={metrics}
      search={filters.search}
      onSearchChange={(value) => setFilters((f) => ({ ...f, search: value }))}
      searchPlaceholder="Search title, payee, category, or reference"
      resultCount={list.isError ? "—" : meta ? `${meta.total}` : "…"}
      filter={
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <Select
            value={filters.category}
            onValueChange={(value) => value && setFilters((f) => ({ ...f, category: value }))}
          >
            <SelectTrigger
              aria-label="Filter expenses by category"
              className="w-full sm:w-40"
            >
              <SelectValue>
                {filters.category === "all"
                  ? "All categories"
                  : filters.category === "none"
                    ? "Uncategorized"
                    : (categoriesQuery.data ?? []).find(
                        (category) => String(category.id) === filters.category,
                      )?.categoryName ?? "All categories"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              <SelectItem value="none">Uncategorized</SelectItem>
              {(categoriesQuery.data ?? []).map((category) => (
                <SelectItem key={category.id} value={String(category.id)}>
                  {category.categoryName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filters.status}
            onValueChange={(value) => value && setFilters((f) => ({ ...f, status: value }))}
          >
            <SelectTrigger
              aria-label="Filter expenses by payment status"
              className="w-full sm:w-36"
            >
              <SelectValue>
                {filters.status === "all"
                  ? "All statuses"
                  : filters.status === "paid"
                    ? "Paid"
                    : filters.status === "partial"
                      ? "Partial"
                      : "Unpaid"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="partial">Partial</SelectItem>
              <SelectItem value="unpaid">Unpaid</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={filters.method}
            onValueChange={(value) => value && setFilters((f) => ({ ...f, method: value }))}
          >
            <SelectTrigger
              aria-label="Filter expenses by payment method"
              className="w-full sm:w-36"
            >
              <SelectValue>
                {filters.method === "all" ? "All methods" : filters.method}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All methods</SelectItem>
              <SelectItem value="Cash">Cash</SelectItem>
              <SelectItem value="Mobile">Mobile</SelectItem>
              <SelectItem value="Card">Card</SelectItem>
            </SelectContent>
          </Select>
          {locations.length > 1 ? (
            <Select
              value={filters.locationId}
              onValueChange={(value) =>
                value && setFilters((f) => ({ ...f, locationId: value }))
              }
            >
              <SelectTrigger
                aria-label="Filter expenses by location"
                className="w-full sm:w-44"
              >
                <SelectValue>
                  {filters.locationId === "all"
                    ? "All locations"
                    : (locations.find(
                        (location) => String(location.id) === filters.locationId,
                      )?.name ?? "All locations")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All locations</SelectItem>
                {locations.map((location) => (
                  <SelectItem key={location.id} value={String(location.id)}>
                    {location.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <label className="relative">
            <span className="sr-only">Expenses from date</span>
            <CalendarDays
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Expenses from date"
              type="date"
              value={filters.dateFrom}
              onChange={(event) =>
                setFilters((f) => ({ ...f, dateFrom: event.target.value }))
              }
              className="pl-9 sm:w-36"
            />
          </label>
          <label className="relative">
            <span className="sr-only">Expenses to date</span>
            <CalendarDays
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Expenses to date"
              type="date"
              value={filters.dateTo}
              onChange={(event) =>
                setFilters((f) => ({ ...f, dateTo: event.target.value }))
              }
              className="pl-9 sm:w-36"
            />
          </label>
          {hasFilters ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilters}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="space-y-3">
        {invalidDateRange ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          >
            The start date must be on or before the end date.
          </p>
        ) : null}
        {list.isError ? (
          <div
            role="alert"
            className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="text-sm text-destructive">
              Could not load expenses.{" "}
              {list.error instanceof Error ? list.error.message : ""}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void list.refetch()}
            >
              <RefreshCw />
              Try again
            </Button>
          </div>
        ) : null}
        {categoriesQuery.isError ? (
          <div
            role="alert"
            className="flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="text-sm text-amber-800 dark:text-amber-300">
              Could not load expense categories.{" "}
              {categoriesQuery.error instanceof Error
                ? categoriesQuery.error.message
                : ""}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void categoriesQuery.refetch()}
            >
              <RefreshCw />
              Try again
            </Button>
          </div>
        ) : null}
        {!list.isLoading && !list.isError && !(meta?.total ?? 0) ? (
          <Card className="border-dashed shadow-none">
            <CardContent className="items-center py-10 text-center">
              <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <ReceiptText />
              </div>
              <h2 className="font-medium">
                {hasFilters ? "No expenses match your filters" : "No expenses recorded yet"}
              </h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                {hasFilters
                  ? "Try adjusting or clearing the filters above."
                  : "Add your first expense to start tracking where your business money goes."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <ExpensesTable
            expenses={invalidDateRange ? [] : expenses}
            meta={meta}
            categories={categoriesQuery.data ?? []}
            loading={list.isLoading || invalidDateRange}
            sortField={sort}
            sortDir={sortDir}
            onSortChange={handleSortChange}
            onPageChange={setPage}
          />
        )}
        <ExpenseAnalyticsPanel
          dateFrom={filters.dateFrom || undefined}
          dateTo={filters.dateTo || undefined}
          locationId={
            filters.locationId === "all"
              ? undefined
              : Number(filters.locationId) || undefined
          }
          categoryOptions={categoriesQuery.data ?? []}
        />
      </div>
    </ContactListLayout>
  );
}

function exportExpenseRows(expenses: ExpenseRecord[]) {
  const headers = [
    "Date",
    "Title",
    "Category",
    "Payee",
    "Location",
    "Payment method",
    "Payment status",
    "Total",
    "Paid",
    "Due",
    "Reference",
    "Note",
  ];
  const rows = expenses.map((expense) => {
    const amount = Number(expense.amount) || 0;
    const paid = Number(expense.paidAmount) || 0;
    return [
      expense.expenseDate,
      expense.title,
      expense.categoryName ?? "Uncategorized",
      expense.payee ?? "",
      expense.locationName ?? "",
      expense.paymentMethod ?? "",
      expense.paymentStatus,
      amount.toFixed(2),
      paid.toFixed(2),
      (amount - paid).toFixed(2),
      expense.referenceNo ?? "",
      expense.note ?? "",
    ];
  });
  exportToCsv("expenses", headers, rows);
}
