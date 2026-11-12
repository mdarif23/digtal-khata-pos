import { useMemo, useState, type ReactNode } from "react";
import {
  CalendarDays,
  Package,
  ReceiptText,
  Printer,
  RefreshCw,
  RotateCcw,
  Search,
  TrendingUp,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getErrorMessage } from "@/utils/getErrorMessage";
import { usePermissions } from "@/hooks/usePermissions";
import { useSalesStore } from "../stores/useSalesStore.js";
import type {
  AllSoldProduct,
  SaleRefundRequest,
  SalesStoreType,
} from "../types/sales.types.js";
import { SalesDataTable } from "../components/sales/SalesDataTable.js";
import { getSaleReceiptApi } from "../sales.api.js";
import type { SaleReceiptData } from "../types/receipt.types.js";
import { ReceiptPrintDialog } from "../components/receipt/ReceiptPrintDialog.js";
import { ExchangeDialog } from "../components/pos/ExchangeDialog.js";
import { PaymentIntentDialog } from "../components/pos/PaymentIntentDialog.js";
import { LocationRequiredNotice } from "@/components/common/LocationRequiredNotice.js";

const DATE_RANGES = ["all", "today", "7-days", "30-days"] as const;
type DateRange = (typeof DATE_RANGES)[number];
const REFUND_REASONS = [
  "customer_request",
  "wrong_item",
  "damaged",
  "quality_issue",
  "other",
] as const satisfies readonly SaleRefundRequest["reason"][];
const REFUND_DISPOSITIONS = [
  "restock",
  "inspection",
  "damaged",
] as const satisfies readonly SaleRefundRequest["disposition"][];

function isDateRange(value: string | null): value is DateRange {
  return DATE_RANGES.some((range) => range === value);
}

function isRefundReason(
  value: string | null,
): value is SaleRefundRequest["reason"] {
  return REFUND_REASONS.some((reason) => reason === value);
}

function isRefundDisposition(
  value: string | null,
): value is SaleRefundRequest["disposition"] {
  return REFUND_DISPOSITIONS.some(
    (disposition) => disposition === value,
  );
}

const REFUND_REASON_LABELS: Record<SaleRefundRequest["reason"], string> = {
  customer_request: "Customer changed their mind",
  wrong_item: "Wrong item",
  damaged: "Damaged item",
  quality_issue: "Quality issue",
  other: "Other",
};

const REFUND_DISPOSITION_LABELS: Record<
  SaleRefundRequest["disposition"],
  string
> = {
  restock: "Restock — return to available stock",
  inspection: "Needs inspection — keep out of available stock",
  damaged: "Damaged — do not restock",
};

const currencyFormatter = new Intl.NumberFormat("en-BD", {
  style: "currency",
  currency: "BDT",
  maximumFractionDigits: 2,
});

function formatCurrency(value: number) {
  return currencyFormatter.format(value);
}

function formatDate(
  value: string | null,
  options: Intl.DateTimeFormatOptions,
) {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Invalid date"
    : date.toLocaleString(undefined, options);
}

function summarizeSales(items: SalesStoreType[]): AllSoldProduct[] {
  const grouped = new Map<number, SalesStoreType[]>();
  for (const item of items) {
    const saleItems = grouped.get(item.saleId) ?? [];
    saleItems.push(item);
    grouped.set(item.saleId, saleItems);
  }

  return Array.from(grouped, ([id, saleItems]) => ({
    id,
    invoiceNumber: saleItems[0]?.invoiceNumber ?? `#${id}`,
    items: saleItems,
    createdAt: saleItems[0]?.createdAt ?? null,
    totalQuantity: saleItems.reduce(
      (total, item) => total + Number(item.soldQuantity),
      0,
    ),
    totalAmount:
      saleItems[0]?.saleTotal == null
        ? saleItems.reduce((total, item) => total + Number(item.lineTotal), 0)
        : Number(saleItems[0].saleTotal),
    paymentStatus: saleItems[0]?.paymentStatus ?? "unpaid",
    saleStatus: saleItems[0]?.saleStatus ?? "completed",
    customerName: saleItems[0]?.customerName ?? null,
  })).sort(
    (first, second) =>
      new Date(second.createdAt ?? 0).getTime() -
      new Date(first.createdAt ?? 0).getTime(),
  );
}

function isInDateRange(sale: AllSoldProduct, range: DateRange) {
  if (range === "all") return true;
  if (!sale.createdAt) return false;
  const date = new Date(sale.createdAt);
  if (Number.isNaN(date.getTime())) return false;

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  if (range === "today") return date >= start && date < end;

  const days = range === "7-days" ? 7 : 30;
  start.setDate(start.getDate() - (days - 1));
  return date >= start && date <= now;
}

/** Refund states a sale can be filtered by. The backend flips `saleStatus`
 *  to "refunded" only when EVERY line is fully returned; anything returned
 *  on a completed sale is a partial refund (per-line returnedQuantity). */
type RefundFilter = "all" | "completed" | "partial" | "refunded";

const REFUND_FILTERS: RefundFilter[] = ["all", "completed", "partial", "refunded"];

function isRefundFilter(value: string | null): value is RefundFilter {
  return (REFUND_FILTERS as string[]).includes(value as string);
}

function refundStateOf(sale: AllSoldProduct): Exclude<RefundFilter, "all"> {
  if (sale.saleStatus === "refunded") return "refunded";
  const hasReturn = sale.items.some(
    (item) => Number(item.returnedQuantity) > 0,
  );
  return hasReturn ? "partial" : "completed";
}

/** Units still returnable on a line: sold − already returned. */
function remainingOf(item: SalesStoreType): number {
  return Math.max(
    0,
    Number(item.soldQuantity) - Number(item.returnedQuantity),
  );
}

export function Sales() {
  const { hasPermission } = usePermissions();
  const sales = useSalesStore((state) => state.sales);
  const loading = useSalesStore((state) => state.loading);
  const error = useSalesStore((state) => state.error);
  const getSales = useSalesStore((state) => state.getSales);
  const returnProducts = useSalesStore((state) => state.returnProducts);
  const returnSingleItems = useSalesStore((state) => state.returnSingleItems);
  const [query, setQuery] = useState("");
  const [dateRange, setDateRange] = useState<DateRange>("all");
  const [refundFilter, setRefundFilter] = useState<RefundFilter>("all");
  const [selectedSaleId, setSelectedSaleId] = useState<number | null>(null);
  const [busySaleId, setBusySaleId] = useState<number | null>(null);
  const [refundTarget, setRefundTarget] = useState<
    | { type: "sale"; sale: AllSoldProduct }
    | { type: "item"; item: SalesStoreType }
    | null
  >(null);
  const [refundReason, setRefundReason] = useState<
    SaleRefundRequest["reason"] | null
  >(null);
  const [refundDisposition, setRefundDisposition] = useState<
    SaleRefundRequest["disposition"] | null
  >(null);
  const [refundNotes, setRefundNotes] = useState("");
  const [refundMethod, setRefundMethod] = useState<
    "cash" | "store_credit" | "original_payment"
  >("cash");
  // Per-line return quantities (saleItemId → units coming back). Prefilled
  // with each line's full remaining quantity; the cashier lowers a value to
  // return only part of a line ("customer bought 3, returns 1").
  const [refundQuantities, setRefundQuantities] = useState<
    Record<number, number>
  >({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeReceipt, setActiveReceipt] = useState<SaleReceiptData | null>(null);
  const [isReceiptModalOpen, setIsReceiptModalOpen] = useState(false);
  const [isFetchingReceipt, setIsFetchingReceipt] = useState(false);
  const [exchangeTarget, setExchangeTarget] = useState<SalesStoreType | null>(null);
  const [paymentTarget, setPaymentTarget] = useState<SalesStoreType | null>(null);

  const handlePrintReceipt = async (saleId: number) => {
    try {
      setIsFetchingReceipt(true);
      const receipt = await getSaleReceiptApi(saleId);
      setActiveReceipt(receipt);
      setIsReceiptModalOpen(true);
    } catch (err) {
      console.error("Failed to fetch receipt:", err);
      setActionError(getErrorMessage(err));
    } finally {
      setIsFetchingReceipt(false);
    }
  };

  const allSales = useMemo(() => summarizeSales(sales), [sales]);
  const visibleSales = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return allSales.filter((sale) => {
      if (!isInDateRange(sale, dateRange)) return false;
      if (refundFilter !== "all" && refundStateOf(sale) !== refundFilter) {
        return false;
      }
      if (!normalizedQuery) return true;
      return (
        String(sale.id).includes(normalizedQuery) ||
        sale.invoiceNumber.toLocaleLowerCase().includes(normalizedQuery) ||
        sale.items.some((item) =>
          item.productName.toLocaleLowerCase().includes(normalizedQuery) ||
          (item.variantName ?? "").toLocaleLowerCase().includes(normalizedQuery) ||
          (item.sku ?? "").toLocaleLowerCase().includes(normalizedQuery),
        )
      );
    });
  }, [allSales, dateRange, refundFilter, query]);
  const selectedSale =
    allSales.find((sale) => sale.id === selectedSaleId) ?? null;

  const totalUnits = visibleSales.reduce(
    (total, sale) => total + sale.totalQuantity,
    0,
  );
  const totalAmount = visibleSales.reduce(
    (total, sale) => total + sale.totalAmount,
    0,
  );

  const openSaleRefund = (sale: AllSoldProduct) => {
    setActionError(null);
    setRefundReason(null);
    setRefundDisposition(null);
    setRefundNotes("");
    setRefundQuantities(
      Object.fromEntries(
        sale.items
          .filter((item) => remainingOf(item) > 0)
          .map((item) => [item.saleItemsId, remainingOf(item)]),
      ),
    );
    setRefundTarget({ type: "sale", sale });
  };

  const openItemRefund = (item: SalesStoreType) => {
    setActionError(null);
    setRefundReason(null);
    setRefundDisposition(null);
    setRefundNotes("");
    if (remainingOf(item) > 0) {
      setRefundQuantities({ [item.saleItemsId]: remainingOf(item) });
    }
    setRefundTarget({ type: "item", item });
  };

  const submitRefund = async () => {
    if (!refundTarget || !refundReason || !refundDisposition) return;
    const reason = refundReason;
    const disposition = refundDisposition;
    const saleId =
      refundTarget.type === "sale"
        ? refundTarget.sale.id
        : refundTarget.item.saleId;
    // Lines the cashier actually wants back, with their quantities.
    const targetLines =
      refundTarget.type === "sale"
        ? refundTarget.sale.items.filter((item) => remainingOf(item) > 0)
        : [refundTarget.item];
    const chosen = targetLines
      .map((item) => ({
        item,
        quantity: refundQuantities[item.saleItemsId] ?? remainingOf(item),
      }))
      .filter((entry) => entry.quantity > 0);
    if (chosen.length === 0) {
      setActionError("Set a return quantity on at least one line.");
      return;
    }
    const isWholeSaleReturn =
      chosen.length === targetLines.length &&
      chosen.every((entry) => entry.quantity === remainingOf(entry.item));
    setActionError(null);
    setBusySaleId(saleId);
    try {
      const options: SaleRefundRequest = {
        reason,
        disposition,
        ...(refundNotes.trim() ? { notes: refundNotes.trim() } : {}),
        refundMethod,
      };
      if (isWholeSaleReturn) {
        // Nothing customized — one legacy whole-line request (the backend
        // defaults absent quantities to each line's full remaining).
        if (refundTarget.type === "sale") {
          await returnProducts(refundTarget.sale.id, options);
          setSelectedSaleId((current) =>
            current === refundTarget.sale.id ? null : current,
          );
        } else {
          await returnSingleItems(refundTarget.item, options);
          const remainingItems = selectedSale?.items.filter(
            (item) => item.saleItemsId !== refundTarget.item.saleItemsId,
          );
          if (selectedSale?.id === refundTarget.item.saleId && remainingItems?.length === 0) {
            setSelectedSaleId(null);
          }
        }
      } else {
        // Partial return: the backend's whole-sale endpoint defaults every
        // line to its full remainder, so per-line selections go through the
        // single-item endpoint, one request per returned line.
        for (const { item, quantity } of chosen) {
          if (item.trackingType === "serial") {
            // Full remainder only — partial serial returns need a serial
            // selection the sales list doesn't provide.
            await returnSingleItems(item, options);
          } else {
            await returnSingleItems(item, {
              ...options,
              quantities: [
                { saleItemId: item.saleItemsId, quantity },
              ],
            });
          }
        }
        if (refundTarget.type === "sale") {
          setSelectedSaleId((current) =>
            current === refundTarget.sale.id ? null : current,
          );
        }
      }
      setRefundTarget(null);
    } catch (refundError) {
      setActionError(getErrorMessage(refundError));
    } finally {
      setBusySaleId(null);
    }
  };

  return (
    <main className="container mx-auto space-y-6 p-4 md:p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sales</h1>
          <p className="text-sm text-muted-foreground">
            Review completed transactions and process customer returns.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void getSales()}
          disabled={loading}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
          Refresh
        </Button>
      </header>

      <LocationRequiredNotice error={error} />
      {error && !error.toLowerCase().includes("no locations") && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <span>{error}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void getSales()}
            disabled={loading}
          >
            Try again
          </Button>
        </div>
      )}
      {actionError && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {actionError}
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-3">
        <SummaryCard
          title="Sales value"
          value={formatCurrency(totalAmount)}
          description="Completed sales in this view"
          icon={<TrendingUp className="size-4 text-muted-foreground" />}
        />
        <SummaryCard
          title="Transactions"
          value={visibleSales.length.toLocaleString()}
          description="Completed sale receipts"
          icon={<ReceiptText className="size-4 text-muted-foreground" />}
        />
        <SummaryCard
          title="Units sold"
          value={totalUnits.toLocaleString()}
          description="Total quantity across transactions"
          icon={<Package className="size-4 text-muted-foreground" />}
        />
      </section>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Sales history</CardTitle>
            <CardDescription>
              Search by receipt number or product, then open a sale for its
              itemized details.
            </CardDescription>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search sales"
                placeholder="Search receipt or product..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-9 sm:w-64"
              />
            </div>
            <Select
              value={dateRange}
              onValueChange={(value) => {
                if (isDateRange(value)) setDateRange(value);
              }}
            >
              <SelectTrigger
                aria-label="Filter sales by date"
                className="sm:w-40"
              >
                <CalendarDays className="size-4 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All dates</SelectItem>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="7-days">Last 7 days</SelectItem>
                <SelectItem value="30-days">Last 30 days</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={refundFilter}
              onValueChange={(value) => {
                if (isRefundFilter(value)) setRefundFilter(value);
              }}
            >
              <SelectTrigger
                aria-label="Filter sales by refund status"
                className="sm:w-44"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sales</SelectItem>
                <SelectItem value="completed">No returns</SelectItem>
                <SelectItem value="partial">Partially refunded</SelectItem>
                <SelectItem value="refunded">Fully refunded</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          <SalesDataTable
            data={visibleSales}
            loading={loading}
            onViewSale={setSelectedSaleId}
            onRefundSale={openSaleRefund}
            busySaleId={busySaleId}
            onPrintSale={handlePrintReceipt}
          />
        </CardContent>
      </Card>

      <Dialog
        open={selectedSaleId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedSaleId(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              Sale details
              {selectedSale ? ` — ${selectedSale.invoiceNumber}` : ""}
            </DialogTitle>
            <DialogDescription>
              {selectedSale
                ? `Created ${formatDate(selectedSale.createdAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })} · ${selectedSale.customerName ?? "Walk-in customer"} · ${selectedSale.paymentStatus}`
                : "This sale is no longer available."}
            </DialogDescription>
          </DialogHeader>
          {selectedSale && (
            <>
              <div className="overflow-hidden rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Unit price</TableHead>
                      <TableHead className="text-right">Line total</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selectedSale.items.map((item) => (
                      <TableRow key={item.saleItemsId}>
                        <TableCell>
                          <div className="font-medium">
                            {item.variantName || item.productName}
                          </div>
                          {item.variantOptions && item.variantName ? (
                            <div className="text-xs text-muted-foreground">
                              {item.productName} · {item.variantOptions}
                            </div>
                          ) : null}
                          <div className="text-xs text-muted-foreground">
                            {item.category || "Uncategorized"}
                          </div>
                          {item.returnReason && (
                            <div className="text-xs text-muted-foreground">
                              Return: {item.returnReason}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {item.soldQuantity}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatCurrency(Number(item.soldPrice))}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {formatCurrency(Number(item.lineTotal))}
                        </TableCell>
                        <TableCell>
                          {item.returnedQuantity >= item.soldQuantity
                            ? "Returned"
                            : item.returnedQuantity > 0
                              ? "Partial return"
                              : "Completed"}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={
                              item.returnedQuantity >= item.soldQuantity ||
                              busySaleId !== null
                            }
                            onClick={() => hasPermission("sales.return") && openItemRefund(item)}
                          >
                            <RotateCcw />
                            {item.returnedQuantity >= item.soldQuantity
                              ? "Returned"
                              : "Return item"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow>
                      <TableCell
                        colSpan={3}
                        className="text-right font-semibold"
                      >
                        Sale total
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        {formatCurrency(selectedSale.totalAmount)}
                      </TableCell>
                      <TableCell />
                      <TableCell />
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
              <div className="flex flex-wrap justify-between items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handlePrintReceipt(selectedSale.id)}
                  disabled={isFetchingReceipt}
                >
                  <Printer className="size-4" />
                  {isFetchingReceipt ? "Loading..." : "Print Receipt"}
                </Button>
                <div className="flex gap-2">
                  {selectedSale.paymentStatus !== "paid" && (
                    <Button
                      variant="outline"
                      disabled={busySaleId !== null}
                      onClick={() => {
                        setPaymentTarget(selectedSale);
                        setSelectedSaleId(null);
                      }}
                    >
                      Collect due via QR / Card
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    disabled={
                      busySaleId !== null ||
                      selectedSale.items.every(
                        (item) => item.returnedQuantity >= item.soldQuantity,
                      )
                    }
                    onClick={() => {
                      setExchangeTarget(selectedSale);
                      setSelectedSaleId(null);
                    }}
                  >
                    Exchange items
                  </Button>
                </div>
                <Button
                  variant="destructive"
                  disabled={
                    busySaleId !== null ||
                    selectedSale.items.every(
                      (item) => item.returnedQuantity >= item.soldQuantity,
                    )
                  }
                  onClick={() => hasPermission("sales.return") && openSaleRefund(selectedSale)}
                >
                  <RotateCcw />
                  Refund entire sale
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={refundTarget !== null}
        onOpenChange={(open) => {
          if (!open && busySaleId === null) setRefundTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {refundTarget?.type === "sale"
                ? "Return items from sale"
                : "Return sale item"}
            </DialogTitle>
            <DialogDescription>
              Set how many units of each line come back, then choose a reason
              and stock disposition. Serial-tracked lines are returned whole.
            </DialogDescription>
          </DialogHeader>
          {refundTarget && (
            <div className="space-y-4">
              {(() => {
                const lines =
                  refundTarget.type === "sale"
                    ? refundTarget.sale.items.filter(
                        (item) => remainingOf(item) > 0,
                      )
                    : [refundTarget.item];
                return (
                  <div className="overflow-hidden rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Item</TableHead>
                          <TableHead className="text-right">Sold</TableHead>
                          <TableHead className="text-right">
                            Return qty
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {lines.map((item) => {
                          const remaining = remainingOf(item);
                          const isSerial = item.trackingType === "serial";
                          const value =
                            refundQuantities[item.saleItemsId] ?? remaining;
                          return (
                            <TableRow key={item.saleItemsId}>
                              <TableCell>
                                <div className="font-medium">
                                  {item.variantName || item.productName}
                                </div>
                                {isSerial && (
                                  <div className="text-xs text-muted-foreground">
                                    Serial-tracked — returned whole
                                  </div>
                                )}
                              </TableCell>
                              <TableCell className="text-right">
                                {remaining}
                              </TableCell>
                              <TableCell className="text-right">
                                <Input
                                  aria-label={`Return quantity for ${item.variantName || item.productName}`}
                                  type="number"
                                  min={0}
                                  max={remaining}
                                  step={1}
                                  disabled={isSerial}
                                  value={value}
                                  onChange={(event) => {
                                    const parsed = Math.floor(
                                      Number(event.target.value),
                                    );
                                    if (!Number.isFinite(parsed)) return;
                                    setRefundQuantities((current) => ({
                                      ...current,
                                      [item.saleItemsId]: Math.min(
                                        Math.max(parsed, 0),
                                        remaining,
                                      ),
                                    }));
                                  }}
                                  className="ml-auto h-8 w-20 text-right"
                                />
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                );
              })()}
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="return-reason">
                  Return reason
                </label>
                <Select
                  value={refundReason}
                  onValueChange={(value) => {
                    if (isRefundReason(value)) setRefundReason(value);
                  }}
                >
                  <SelectTrigger id="return-reason" className="w-full">
                    <SelectValue placeholder="Choose a reason" />
                  </SelectTrigger>
                  <SelectContent>
                    {REFUND_REASONS.map((reason) => (
                      <SelectItem key={reason} value={reason}>
                        {REFUND_REASON_LABELS[reason]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label
                  className="text-sm font-medium"
                  htmlFor="return-disposition"
                >
                  Stock disposition
                </label>
                <Select
                  value={refundDisposition}
                  onValueChange={(value) => {
                    if (isRefundDisposition(value)) {
                      setRefundDisposition(value);
                    }
                  }}
                >
                  <SelectTrigger id="return-disposition" className="w-full">
                    <SelectValue placeholder="Choose how to handle stock" />
                  </SelectTrigger>
                  <SelectContent>
                    {REFUND_DISPOSITIONS.map((disposition) => (
                      <SelectItem key={disposition} value={disposition}>
                        {REFUND_DISPOSITION_LABELS[disposition]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="refund-method">
                  Refund method
                </label>
                <Select
                  value={refundMethod}
                  onValueChange={(value) => {
                    if (
                      value === "cash" ||
                      value === "store_credit" ||
                      value === "original_payment"
                    ) {
                      setRefundMethod(value);
                    }
                  }}
                >
                  <SelectTrigger id="refund-method" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">Cash (counter payout)</SelectItem>
                    <SelectItem value="store_credit">
                      Store credit (customer account)
                    </SelectItem>
                    <SelectItem value="original_payment">
                      Original payment (provider refund)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="return-notes">
                  Notes (optional)
                </label>
                <Input
                  id="return-notes"
                  maxLength={500}
                  value={refundNotes}
                  onChange={(event) => setRefundNotes(event.target.value)}
                  placeholder="Add details about this return"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  disabled={busySaleId !== null}
                  onClick={() => setRefundTarget(null)}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={
                    !refundReason ||
                    !refundDisposition ||
                    busySaleId !== null
                  }
                  onClick={() => void submitRefund()}
                >
                  <RotateCcw />
                  {busySaleId !== null ? "Saving return..." : "Record return"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      {exchangeTarget !== null && (
        <ExchangeDialog
          sale={exchangeTarget}
          open={exchangeTarget !== null}
          onOpenChange={(open) => {
            if (!open) setExchangeTarget(null);
          }}
        />
      )}
      {paymentTarget !== null && (
        <PaymentIntentDialog
          sale={paymentTarget}
          open={paymentTarget !== null}
          onOpenChange={(open) => {
            if (!open) setPaymentTarget(null);
          }}
        />
      )}
      <ReceiptPrintDialog
        receipt={activeReceipt}
        open={isReceiptModalOpen}
        onOpenChange={setIsReceiptModalOpen}
      />
    </main>
  );
}

function SummaryCard({
  title,
  value,
  description,
  icon,
}: {
  title: string;
  value: string;
  description: string;
  icon: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-2">
        <div>
          <CardDescription>{title}</CardDescription>
          <CardTitle className="mt-1 text-2xl">{value}</CardTitle>
        </div>
        {icon}
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}
