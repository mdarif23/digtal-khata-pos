import type { AllSoldProduct, SaleRefundRequest, SalesStoreType } from "../types/sales.types.js";

/**
 * Pure sales-list plumbing (Phase 6 Feature 2, extracted verbatim from
 * Sales.tsx): date-range/refund filter consts and guards, the sold-
 * products summarizer and the refund-state helpers. No behavior change.
 */

export const DATE_RANGES = ["all", "today", "7-days", "30-days"] as const;
export type DateRange = (typeof DATE_RANGES)[number];
export const REFUND_REASONS = [
  "customer_request",
  "wrong_item",
  "damaged",
  "quality_issue",
  "other",
] as const satisfies readonly SaleRefundRequest["reason"][];
export const REFUND_DISPOSITIONS = [
  "restock",
  "inspection",
  "damaged",
] as const satisfies readonly SaleRefundRequest["disposition"][];

export function isDateRange(value: string | null): value is DateRange {
  return DATE_RANGES.some((range) => range === value);
}

export function isRefundReason(
  value: string | null,
): value is SaleRefundRequest["reason"] {
  return REFUND_REASONS.some((reason) => reason === value);
}

export function isRefundDisposition(
  value: string | null,
): value is SaleRefundRequest["disposition"] {
  return REFUND_DISPOSITIONS.some(
    (disposition) => disposition === value,
  );
}

export const REFUND_REASON_LABELS: Record<SaleRefundRequest["reason"], string> = {
  customer_request: "Customer changed their mind",
  wrong_item: "Wrong item",
  damaged: "Damaged item",
  quality_issue: "Quality issue",
  other: "Other",
};

export const REFUND_DISPOSITION_LABELS: Record<
  SaleRefundRequest["disposition"],
  string
> = {
  restock: "Restock — return to available stock",
  inspection: "Needs inspection — keep out of available stock",
  damaged: "Damaged — do not restock",
};


export function formatDate(
  value: string | null,
  options: Intl.DateTimeFormatOptions,
) {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Invalid date"
    : date.toLocaleString(undefined, options);
}

export function summarizeSales(items: SalesStoreType[]): AllSoldProduct[] {
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

export function isInDateRange(sale: AllSoldProduct, range: DateRange) {
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
export type RefundFilter = "all" | "completed" | "partial" | "refunded";

export const REFUND_FILTERS: RefundFilter[] = ["all", "completed", "partial", "refunded"];

export function isRefundFilter(value: string | null): value is RefundFilter {
  return (REFUND_FILTERS as string[]).includes(value as string);
}

export function refundStateOf(sale: AllSoldProduct): Exclude<RefundFilter, "all"> {
  if (sale.saleStatus === "refunded") return "refunded";
  const hasReturn = sale.items.some(
    (item) => Number(item.returnedQuantity) > 0,
  );
  return hasReturn ? "partial" : "completed";
}

/** Units still returnable on a line: sold − already returned. */
export function remainingOf(item: SalesStoreType): number {
  return Math.max(
    0,
    Number(item.soldQuantity) - Number(item.returnedQuantity),
  );
}

