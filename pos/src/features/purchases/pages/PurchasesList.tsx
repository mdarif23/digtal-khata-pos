import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  ClipboardList,
  FilterX,
  PackageCheck,
  Plus,
  Search,
  Wallet,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/features/purchases/utils/formatCurrency";
import { formatQty } from "../utils/uom";
import {
  LandedCostAdjustmentNotice,
  LandedCostReversalNotice,
} from "../components/receiving/LandedCostAdjustmentNotice";
import type { LandedCostFeedback } from "../purchase.types";
import {
  PURCHASE_FILTERS,
  type PurchaseFilter,
} from "../utils/purchaseListFilters";
import { usePurchaseList } from "../hooks/usePurchaseList";
import { PurchaseDetailsDrawer } from "../components/details/PurchaseDetailsDrawer";
import useProductStore from "@/features/products/useProductStore";
import type { PurchaseListItem } from "../purchase.types";

type PurchaseNoticeState = {
  receiveNotice?: {
    purchaseId: number;
    landedCost: LandedCostFeedback;
  };
  returnNotice?: {
    purchaseId: number;
    landedCost: LandedCostFeedback;
    supplierBalance?: {
      outstandingBefore: number;
      goodsCredit: number;
      outstandingAfter: number;
      supplierCreditCreated: number;
    };
    returnedSerials?: string[];
  };
} | null;

function formatDate(value: Date | string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("en-BD", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }).format(date);
}

/** 300 ms debounce — the search input stays responsive without firing a
 *  request per keystroke. */
function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export const PurchasesList = () => {
  const location = useLocation();
  // Filters seed from the URL (Phase 8: they survive navigating away to a
  // purchase's receive/landed-cost pages and back) and every change is
  // written back with replace:true so history stays clean.
  const initialParams = useMemo(
    () => new URLSearchParams(location.search),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [filter, setFilter] = useState<PurchaseFilter>(
    () =>
      (PURCHASE_FILTERS.find(
        (entry) => entry.value === initialParams.get("tab"),
      )?.value ?? "all") as PurchaseFilter,
  );
  const [search, setSearch] = useState(initialParams.get("q") ?? "");
  const [page, setPage] = useState(
    Math.max(1, Number(initialParams.get("page")) || 1),
  );
  const [pageSize, setPageSize] = useState(
    Math.max(1, Number(initialParams.get("pageSize")) || 25),
  );
  const [sortBy, setSortBy] = useState<
    "purchaseDate" | "totalAmount" | "dueAmount" | "purchaseOrderNumber"
  >(
    () =>
      (initialParams.get("sortBy") as
        | "purchaseDate"
        | "totalAmount"
        | "dueAmount"
        | "purchaseOrderNumber"
        | null) ?? "purchaseDate",
  );
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">(
    () =>
      (initialParams.get("sortOrder") as "asc" | "desc" | null) ?? "desc",
  );
  const [supplierId, setSupplierId] = useState(
    initialParams.get("supplierId") ?? "",
  );
  const [dateFrom, setDateFrom] = useState(initialParams.get("from") ?? "");
  const [dateTo, setDateTo] = useState(initialParams.get("to") ?? "");
  const debouncedSearch = useDebouncedValue(search);
  const navigate = useNavigate();
  // Landed-cost feedback handed over from a just-completed receive/return.
  const noticeState = (location.state as PurchaseNoticeState) ?? null;
  const receiveNotice = noticeState?.receiveNotice ?? null;
  const returnNotice = noticeState?.returnNotice ?? null;

  // Details drawer (Phase 11): the PO-number cell opens the authoritative
  // financial picture of the purchase.
  const [detailsId, setDetailsId] = useState<number | null>(null);
  const openDetails = useCallback((purchaseId: number) => {
    setDetailsId(purchaseId);
  }, []);
  const closeDetails = useCallback(() => {
    setDetailsId(null);
  }, []);

  // Server-side list (Phase 6): one request carries filters + pagination;
  // the browser never loads item lines or return aggregates.
  const activeTab = PURCHASE_FILTERS.find((entry) => entry.value === filter);
  const list = usePurchaseList({
    page,
    pageSize,
    sortBy,
    sortOrder,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(supplierId ? { supplierId: Number(supplierId) } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
    ...(activeTab?.params ?? {}),
  });

  const suppliers = useProductStore(
    (state) => state.productSelectOptions.suppliers,
  );

  const rows = list.data?.data ?? [];
  const counts = list.data?.counts;
  const summary = list.data?.summary;
  const pagination = list.data?.pagination;

  const hasActiveFilters =
    filter !== "all" ||
    Boolean(search.trim()) ||
    Boolean(supplierId) ||
    Boolean(dateFrom) ||
    Boolean(dateTo);
  const clearAllFilters = () => {
    setFilter("all");
    setSearch("");
    setSupplierId("");
    setDateFrom("");
    setDateTo("");
    setSortBy("purchaseDate");
    setSortOrder("desc");
    setPage(1);
  };

  // Reset to the first page whenever the filters change.
  useEffect(() => {
    setPage(1);
  }, [
    filter,
    debouncedSearch,
    sortBy,
    sortOrder,
    pageSize,
    supplierId,
    dateFrom,
    dateTo,
  ]);

  // Filter state persists in the URL (replace — no history spam).
  useEffect(() => {
    const params = new URLSearchParams();
    if (filter !== "all") params.set("tab", filter);
    if (search.trim()) params.set("q", search.trim());
    if (page > 1) params.set("page", String(page));
    if (pageSize !== 25) params.set("pageSize", String(pageSize));
    if (sortBy !== "purchaseDate") params.set("sortBy", sortBy);
    if (sortOrder !== "desc") params.set("sortOrder", sortOrder);
    if (supplierId) params.set("supplierId", supplierId);
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    const qs = params.toString();
    navigate(
      { pathname: location.pathname, search: qs ? `?${qs}` : "" },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filter,
    debouncedSearch,
    page,
    pageSize,
    sortBy,
    sortOrder,
    supplierId,
    dateFrom,
    dateTo,
    location.pathname,
    navigate,
  ]);

  return (
    <div className="min-h-[calc(100vh-1rem)] bg-muted/30 p-4 md:p-6">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              Inventory / Purchases
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              Purchase orders
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Track supplier orders, receiving progress, and outstanding
              balances.
            </p>
          </div>
          <Button nativeButton={false} render={<Link to="/purchases" />}>
            <Plus /> New purchase
          </Button>
        </header>

        {(receiveNotice || returnNotice) && (
          <div className="space-y-3">
            {receiveNotice && (
              <LandedCostAdjustmentNotice
                purchaseId={receiveNotice.purchaseId}
                landedCost={receiveNotice.landedCost}
                onDismiss={() =>
                  navigate(location.pathname, { replace: true, state: null })
                }
              />
            )}
            {returnNotice && (
              <LandedCostReversalNotice
                purchaseId={returnNotice.purchaseId}
                landedCost={returnNotice.landedCost}
                supplierBalance={returnNotice.supplierBalance ?? undefined}
                returnedSerials={returnNotice.returnedSerials ?? undefined}
                onDismiss={() =>
                  navigate(location.pathname, { replace: true, state: null })
                }
              />
            )}
          </div>
        )}

        <section className="grid gap-4 sm:grid-cols-3">
          <SummaryCard
            title="Total purchase orders"
            value={String(summary?.totalPurchases ?? 0)}
            icon={<ClipboardList />}
          />
          <SummaryCard
            title="Awaiting receipt"
            value={String(summary?.awaitingReceipt ?? 0)}
            icon={<PackageCheck />}
          />
          <SummaryCard
            title="Outstanding balance"
            value={`৳ ${formatCurrency(summary?.outstandingBalance ?? 0)}`}
            icon={<Wallet />}
          />
        </section>

        <section className="overflow-hidden rounded-xl border bg-background shadow-sm">
          <div className="space-y-4 border-b p-4 md:p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="font-semibold">Orders</h2>
                <p className="text-sm text-muted-foreground">
                  {pagination
                    ? `${pagination.totalItems} order${pagination.totalItems === 1 ? "" : "s"} · page ${pagination.page} of ${Math.max(pagination.totalPages, 1)}`
                    : "Loading orders…"}
                </p>
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 md:w-auto md:justify-end">
                <div className="relative min-w-52 flex-1 md:max-w-xs">
                  <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search order, supplier, phone, product, or SKU..."
                    aria-label="Search purchase orders"
                    className="pl-9"
                  />
                </div>
                <select
                  value={supplierId}
                  onChange={(event) => setSupplierId(event.target.value)}
                  aria-label="Filter by supplier"
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="">All suppliers</option>
                  {suppliers.map((supplier) => (
                    <option key={supplier.value} value={supplier.value}>
                      {supplier.label}
                    </option>
                  ))}
                </select>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(event) => setDateFrom(event.target.value)}
                  aria-label="From date"
                  className="h-9 w-36"
                />
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(event) => setDateTo(event.target.value)}
                  aria-label="To date"
                  className="h-9 w-36"
                />
              </div>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {PURCHASE_FILTERS.map((item) => {
                const count = counts?.[item.value] ?? 0;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setFilter(item.value)}
                    className={`shrink-0 rounded-full px-3 py-1.5 text-sm transition-colors ${
                      filter === item.value
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-muted/70"
                    }`}
                  >
                    {item.label}{" "}
                    <span className="ml-1 opacity-70">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {hasActiveFilters && (
            <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs md:px-5">
              <span className="text-muted-foreground">Active filters:</span>
              {filter !== "all" && (
                <button
                  type="button"
                  onClick={() => setFilter("all")}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 hover:bg-muted/70"
                >
                  {PURCHASE_FILTERS.find((entry) => entry.value === filter)
                    ?.label ?? filter}
                  <FilterX className="size-3" />
                </button>
              )}
              {search.trim() && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 hover:bg-muted/70"
                >
                  “{search.trim()}”
                  <FilterX className="size-3" />
                </button>
              )}
              {supplierId && (
                <button
                  type="button"
                  onClick={() => setSupplierId("")}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 hover:bg-muted/70"
                >
                  {suppliers.find(
                    (supplier: { value: number; label: string }) =>
                      String(supplier.value) === supplierId,
                  )?.label ?? "Supplier"}
                  <FilterX className="size-3" />
                </button>
              )}
              {(dateFrom || dateTo) && (
                <button
                  type="button"
                  onClick={() => {
                    setDateFrom("");
                    setDateTo("");
                  }}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 hover:bg-muted/70"
                >
                  {dateFrom || "…"} → {dateTo || "…"}
                  <FilterX className="size-3" />
                </button>
              )}
              <button
                type="button"
                onClick={clearAllFilters}
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium text-destructive hover:bg-destructive/10"
              >
                <FilterX className="size-3" /> Clear all
              </button>
            </div>
          )}

          {list.isError && (
            <p
              role="alert"
              className="m-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
            >
              {list.error.message}
            </p>
          )}

          {!list.isError && (list.isPending ? (
            <div className="space-y-3 p-5">
              {Array.from({ length: 5 }, (_, index) => (
                <div
                  key={index}
                  className="h-12 animate-pulse rounded-md bg-muted"
                />
              ))}
            </div>
          ) : rows.length ? (
            <>
              <PurchaseOrderTable
                purchases={rows}
                sortBy={sortBy}
                sortOrder={sortOrder}
                onOpenDetails={openDetails}
                onSort={(column) => {
                  if (column === sortBy) {
                    setSortOrder((current) =>
                      current === "asc" ? "desc" : "asc",
                    );
                  } else {
                    setSortBy(column);
                    setSortOrder(
                      column === "purchaseOrderNumber" ? "asc" : "desc",
                    );
                  }
                }}
              />
              {pagination && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t p-4 text-sm">
                  <p className="text-muted-foreground">
                    Page {pagination.page} of {Math.max(pagination.totalPages, 1)}
                    {" · "}
                    {pagination.totalItems} order
                    {pagination.totalItems === 1 ? "" : "s"}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1.5 text-muted-foreground">
                      Rows
                      <select
                        value={pageSize}
                        onChange={(event) =>
                          setPageSize(Number(event.target.value) || 25)
                        }
                        className="h-8 rounded-md border border-input bg-background px-2"
                        aria-label="Rows per page"
                      >
                        {[10, 25, 50, 100].map((size) => (
                          <option key={size} value={size}>
                            {size}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Button
                      nativeButton={false}
                      size="sm"
                      variant="outline"
                      disabled={pagination.page <= 1 || list.isFetching}
                      onClick={() => setPage((current) => current - 1)}
                    >
                      <ArrowLeft /> Previous
                    </Button>
                    <Button
                      nativeButton={false}
                      size="sm"
                      variant="outline"
                      disabled={
                        pagination.page >= pagination.totalPages ||
                        list.isFetching
                      }
                      onClick={() => setPage((current) => current + 1)}
                    >
                      Next <ArrowRight />
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
              <ClipboardList className="size-10 text-muted-foreground/50" />
              <p className="mt-3 font-medium">
                {hasActiveFilters
                  ? "No matching purchase orders"
                  : "No purchase orders yet"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {list.isFetching
                  ? "Checking for orders…"
                  : hasActiveFilters
                    ? "Change or clear your filters and try again."
                    : "Create a purchase order to start tracking stock from suppliers."}
              </p>
              {!hasActiveFilters && (
                <Button
                  nativeButton={false}
                  className="mt-4"
                  variant="outline"
                  render={<Link to="/purchases" />}
                >
                  <Plus /> Create purchase
                </Button>
              )}
            </div>
          ))}

        </section>
      </div>
      <PurchaseDetailsDrawer
        purchaseId={detailsId}
        open={detailsId !== null}
        onOpenChange={(next) => {
          if (!next) closeDetails();
        }}
      />
    </div>
  );
};

function SummaryCard({
  title,
  value,
  icon,
}: {
  title: string;
  value: string;
  icon: ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 rounded-xl border bg-background p-4 shadow-sm">
      <div className="rounded-lg bg-primary/10 p-2.5 text-primary">{icon}</div>
      <div>
        <p className="text-sm text-muted-foreground">{title}</p>
        <p className="mt-1 text-xl font-semibold">{value}</p>
      </div>
    </div>
  );
}

const PurchaseOrderTable = memo(function PurchaseOrderTable({
  purchases,
  sortBy,
  sortOrder,
  onSort,
  onOpenDetails,
}: {
  purchases: PurchaseListItem[];
  sortBy: "purchaseDate" | "totalAmount" | "dueAmount" | "purchaseOrderNumber";
  sortOrder: "asc" | "desc";
  onSort: (
    column: "purchaseDate" | "totalAmount" | "dueAmount" | "purchaseOrderNumber",
  ) => void;
  onOpenDetails: (purchaseId: number) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1120px] text-left text-sm">
        <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
          {/* Header order MUST match PurchaseOrderRow's <td> order — a
              mismatch silently labels the wrong columns. */}
          <SortableHeader
            column="purchaseOrderNumber"
            label="Order"
            sortBy={sortBy}
            sortOrder={sortOrder}
            onSort={onSort}
            align="left"
          />
          <th className="px-4 py-3 font-medium">Supplier</th>
          <SortableHeader
            column="purchaseDate"
            label="Date"
            sortBy={sortBy}
            sortOrder={sortOrder}
            onSort={onSort}
            align="left"
          />
          <th className="px-4 py-3 text-right font-medium">Lines</th>
          <th className="px-4 py-3 text-right font-medium">
            Outstanding qty
          </th>
          <SortableHeader
            column="totalAmount"
            label="Total"
            sortBy={sortBy}
            sortOrder={sortOrder}
            onSort={onSort}
            align="right"
          />
          <th className="px-4 py-3 text-right font-medium">Paid</th>
          <SortableHeader
            column="dueAmount"
            label="Due"
            sortBy={sortBy}
            sortOrder={sortOrder}
            onSort={onSort}
            align="right"
          />
          <th className="px-4 py-3 font-medium">Payment</th>
          <th className="px-4 py-3 font-medium">Receiving</th>
          <th className="px-4 py-3 font-medium">Return status</th>
          <th className="px-5 py-3 text-right font-medium">Actions</th>
        </thead>
        <tbody className="divide-y">
          {purchases.map((purchase) => (
            <PurchaseOrderRow
              key={purchase.id}
              purchase={purchase}
              onOpenDetails={onOpenDetails}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
});

function SortableHeader({
  column,
  label,
  sortBy,
  sortOrder,
  onSort,
  align,
}: {
  column: "purchaseDate" | "totalAmount" | "dueAmount" | "purchaseOrderNumber";
  label: string;
  sortBy: string;
  sortOrder: "asc" | "desc";
  onSort: (
    column: "purchaseDate" | "totalAmount" | "dueAmount" | "purchaseOrderNumber",
  ) => void;
  align: "left" | "right";
}) {
  const active = sortBy === column;
  return (
    <th
      className={`px-4 py-3 ${align === "right" ? "text-right" : "text-left"}`}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-foreground ${
          active ? "text-foreground" : ""
        }`}
        aria-label={`Sort by ${label}`}
      >
        {label}
        {active && <span aria-hidden="true">{sortOrder === "asc" ? "↑" : "↓"}</span>}
      </button>
    </th>
  );
}

const PurchaseOrderRow = memo(function PurchaseOrderRow({
  purchase,
  onOpenDetails,
}: {
  purchase: PurchaseListItem;
  onOpenDetails: (purchaseId: number) => void;
}) {
  const receivingStyles: Record<
    PurchaseListItem["receivingStatus"],
    string
  > = {
    ordered: "bg-sky-100 text-sky-800",
    partially_received: "bg-amber-100 text-amber-800",
    received: "bg-emerald-100 text-emerald-800",
  };
  const paymentStyles: Record<PurchaseListItem["paymentStatus"], string> = {
    unpaid: "bg-rose-100 text-rose-800",
    partial: "bg-amber-100 text-amber-800",
    paid: "bg-emerald-100 text-emerald-800",
  };

  return (
    <tr className="hover:bg-muted/30">
      <td className="px-5 py-4">
        <button
          type="button"
          data-testid={`purchase-details-${purchase.id}`}
          onClick={() => onOpenDetails(purchase.id)}
          className="text-left font-medium underline-offset-2 hover:underline"
          title="View purchase details"
        >
          {purchase.purchaseOrderNumber}
        </button>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Updated {formatDate(purchase.updatedAt)}
        </p>
      </td>
      <td className="px-4 py-4">
        <span className="font-medium">
          {purchase.supplierName || "Walk-in purchase"}
        </span>
      </td>
      <td className="px-4 py-4 text-muted-foreground">
        {formatDate(purchase.purchaseDate)}
      </td>
      <td className="px-4 py-4 text-right">{purchase.totalItems}</td>
      <td className="px-4 py-4 text-right">
        {formatQty(purchase.outstandingQuantity)}
        {purchase.fullyCancelled && (
          <span className="ml-1 text-xs text-muted-foreground">
            (cancelled)
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-right font-medium">
        ৳ {formatCurrency(purchase.totalAmount)}
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-right">
        ৳ {formatCurrency(purchase.paidAmount)}
      </td>
      <td className="whitespace-nowrap px-4 py-4 text-right">
        ৳ {formatCurrency(purchase.dueAmount)}
      </td>
      <td className="px-4 py-4">
        <StatusBadge
          label={purchase.paymentStatus.replace("_", " ")}
          className={paymentStyles[purchase.paymentStatus]}
        />
      </td>
      <td className="px-4 py-4">
        <StatusBadge
          label={
            purchase.fullyCancelled
              ? "cancelled"
              : purchase.receivingStatus.replace("_", " ")
          }
          className={
            purchase.fullyCancelled
              ? "bg-slate-200 text-slate-700"
              : receivingStyles[purchase.receivingStatus]
          }
        />
        {/* Landed-cost indicator — only shown when a document exists and
            hasn't been fully reversed (backend sends null otherwise). */}
        {purchase.landedCostStatus && (
          <p className="mt-1 text-xs text-muted-foreground">
            {purchase.landedCostStatus === "pending"
              ? "Landed cost pending"
              : "Landed cost allocated"}
          </p>
        )}
      </td>
      <td className="px-4 py-4">
        {purchase.returnStatus ? (
          <StatusBadge
            label={purchase.returnStatus}
            className="bg-violet-100 text-violet-800"
          />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-5 py-4">
        <div className="flex justify-end gap-2">
          {purchase.receivingStatus !== "received" && (
            <Button
              nativeButton={false}
              size="sm"
              variant="outline"
              render={<Link to={`/receive-items/${purchase.id}`} />}
            >
              Receive
            </Button>
          )}
          {purchase.receivingStatus !== "ordered" && (
            <Button
              nativeButton={false}
              size="sm"
              variant="outline"
              render={<Link to={`/purchases/landed-cost/${purchase.id}`} />}
            >
              Landed cost
            </Button>
          )}
          {purchase.receivingStatus !== "ordered" &&
            purchase.supplierId !== null && (
              <Button
                nativeButton={false}
                size="sm"
                variant="outline"
                render={<Link to={`/purchase-return/${purchase.id}`} />}
              >
                <ArrowUpRight /> Return
              </Button>
            )}
        </div>
      </td>
    </tr>
  );
});

function StatusBadge({
  label,
  className,
}: {
  label: string;
  className: string;
}) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium capitalize ${className}`}
    >
      {label}
    </span>
  );
}
