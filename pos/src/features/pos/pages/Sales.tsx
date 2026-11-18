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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ManagerApprovalDialog } from "@/features/cashRegisters/components/ManagerApprovalDialog";
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
import { toast } from "@/components/ui/toast";
import { usePermissions } from "@/hooks/usePermissions";
import { useSalesStore } from "../stores/useSalesStore.js";
import { saleKeys, useSalesQuery } from "../hooks/useSales.js";
import { queryClient } from "@/lib/queryClient.js";
import type {
  AllSoldProduct,
  SaleRefundRequest,
  SalesStoreType,
} from "../types/sales.types.js";
import { SalesDataTable } from "../components/sales/SalesDataTable.js";
import { getSaleReceiptApi, voidSaleApi } from "../sales.api.js";
import type { SaleReceiptData } from "../types/receipt.types.js";
import { ReceiptPrintDialog } from "../components/receipt/ReceiptPrintDialog.js";
import { ExchangeDialog } from "../components/pos/ExchangeDialog.js";
import { PaymentIntentDialog } from "../components/pos/PaymentIntentDialog.js";
import { LocationRequiredNotice } from "@/components/common/LocationRequiredNotice.js";
import { SummaryCard } from "@/components/common/SummaryCard";

import { formatCurrency } from "@/lib/format";
import {
  DATE_RANGES,
  formatDate,
  isDateRange,
  isRefundDisposition,
  isRefundFilter,
  isRefundReason,
  isInDateRange,
  REFUND_DISPOSITIONS,
  REFUND_DISPOSITION_LABELS,
  REFUND_FILTERS,
  REFUND_REASONS,
  REFUND_REASON_LABELS,
  refundStateOf,
  remainingOf,
  summarizeSales,
  type DateRange,
  type RefundFilter,
} from "./salesListUtils.js";


export function Sales() {
  const { hasPermission } = usePermissions();
  const salesQuery = useSalesQuery();
  const sales = salesQuery.data ?? [];
  const loading = salesQuery.isPending;
  const error = salesQuery.error
    ? salesQuery.error instanceof Error
      ? salesQuery.error.message
      : String(salesQuery.error)
    : null;
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
  // P3 Phase 3 (E1-003): void flow — reason mandatory; approval_required
  // .sale_cancel surfaces a one-time manager PIN dialog and retries.
  const [voidTarget, setVoidTarget] = useState<AllSoldProduct | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voidError, setVoidError] = useState<string | null>(null);
  const [approvalToken, setApprovalToken] = useState<string | null>(null);
  const [isApprovalOpen, setIsApprovalOpen] = useState(false);
  // E3-009: refund approvals mint a sale.refund token (the void dialog
  // mints sale.cancel — separate op types, separate dialog instance).
  const [isRefundApprovalOpen, setIsRefundApprovalOpen] = useState(false);

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

  /** P3 Phase 3 (E1-003): void the sale — 403 with approval_required
   * .sale_cancel opens the manager PIN dialog; the minted token retries. */
  const submitVoid = async () => {
    if (!voidTarget) return;
    if (voidReason.trim().length < 3) {
      setVoidError("Give a reason of at least 3 characters.");
      return;
    }
    setBusySaleId(voidTarget.id);
    setVoidError(null);
    try {
      await voidSaleApi(voidTarget.id, voidReason.trim(), approvalToken ?? undefined);
      toast.add({
        title: "Sale voided",
        description: `${voidTarget.invoiceNumber} reversed — stock, drawer, loyalty and ledger updated.`,
        type: "success",
      });
      setVoidTarget(null);
      setVoidReason("");
      setApprovalToken(null);
      setSelectedSaleId(null);
      await queryClient
        .invalidateQueries({ queryKey: saleKeys.list() })
        .catch(() => undefined);
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      if (/manager approval is required/i.test(message)) {
        setIsApprovalOpen(true);
        setVoidError(null);
      } else {
        setVoidError(message);
      }
    } finally {
      setBusySaleId(null);
    }
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
        // E3-009: consumed by the sale.refund approval policy on retry.
        ...(approvalToken ? { approvalToken } : {}),
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
      } else if (refundTarget.type === "sale") {
        // E3-010: ONE atomic request — refunds_all accepts a quantity for
        // every refundable line (0 = leave the line). The old loop fired
        // one request per line: a failure mid-way left lines 1..k-1
        // refunded with no rollback and a half-restocked sale.
        await returnProducts(refundTarget.sale.id, {
          ...options,
          quantities: targetLines.map((item) => {
            const picked = chosen.find(
              (c) => c.item.saleItemsId === item.saleItemsId,
            );
            if (!picked || picked.quantity <= 0) {
              return { saleItemId: item.saleItemsId, quantity: 0 };
            }
            // Serial lines are effectively whole — partial serial returns
            // need a serial selection the sales list doesn't provide.
            return {
              saleItemId: item.saleItemsId,
              quantity:
                item.trackingType === "serial"
                  ? remainingOf(item)
                  : picked.quantity,
            };
          }),
        });
        setSelectedSaleId((current) =>
          current === refundTarget.sale.id ? null : current,
        );
      } else {
        // Single-line partial — one request is already atomic.
        await returnSingleItems(refundTarget.item, {
          ...options,
          quantities: [
            { saleItemId: refundTarget.item.saleItemsId, quantity: chosen[0]!.quantity },
          ],
        });
      }
      setRefundTarget(null);
      setApprovalToken(null);
    } catch (refundError) {
      const message = getErrorMessage(refundError);
      // E3-009: mirror the void flow — a manager-approval 403 opens the
      // approval dialog instead of dying as a toast; resubmission carries
      // the token inside `options`.
      if (/manager approval is required/i.test(message)) {
        setIsRefundApprovalOpen(true);
        setActionError(null);
      } else {
        setActionError(message);
      }
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
          onClick={() => void salesQuery.refetch()}
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
            onClick={() => void salesQuery.refetch()}
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
        <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
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
                  variant="warning"
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
                {hasPermission("sales.void") &&
                  selectedSale.saleStatus === "completed" && (
                    <Button
                      variant="destructive"
                      disabled={busySaleId !== null}
                      onClick={() => {
                        setVoidTarget(selectedSale);
                        setVoidReason("");
                        setVoidError(null);
                        setApprovalToken(null);
                      }}
                    >
                      Void sale
                    </Button>
                  )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      {/* P3 Phase 3: void reason dialog */}
      <Dialog
        open={voidTarget !== null}
        onOpenChange={(open) => {
          if (!open && busySaleId === null) {
            setVoidTarget(null);
            setVoidError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Void sale</DialogTitle>
            <DialogDescription>
              {voidTarget?.invoiceNumber} — every reversal happens atomically:
              stock, original batches, serials, drawer cash, loyalty, coupon
              usage and the finance ledger. The invoice number is never
              reused. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Reason (required)</span>
            <Input
              value={voidReason}
              maxLength={500}
              placeholder="Why is this sale being voided?"
              onChange={(e) => setVoidReason(e.target.value)}
            />
          </label>
          {voidError && (
            <p className="text-sm text-destructive">{voidError}</p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busySaleId !== null}
              onClick={() => setVoidTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busySaleId !== null || voidReason.trim().length < 3}
              onClick={() => void submitVoid()}
            >
              {busySaleId !== null ? "Voiding…" : "Void sale"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ManagerApprovalDialog
        open={isApprovalOpen}
        onOpenChange={setIsApprovalOpen}
        opType="sale.cancel"
        opLabel="Void a sale"
        reason={voidReason}
        onApproved={(token) => {
          setApprovalToken(token);
          setIsApprovalOpen(false);
        }}
      />
      {/* E3-009: refunds are approval-gated too — without this the 403
          surfaced as an unactionable toast and the manager could never
          authorize the return. */}
      <ManagerApprovalDialog
        open={isRefundApprovalOpen}
        onOpenChange={setIsRefundApprovalOpen}
        opType="sale.refund"
        opLabel="Refund a sale"
        reason={refundReason ?? undefined}
        onApproved={(token) => {
          setApprovalToken(token);
          setIsRefundApprovalOpen(false);
        }}
      />
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
                  variant="warning"
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


