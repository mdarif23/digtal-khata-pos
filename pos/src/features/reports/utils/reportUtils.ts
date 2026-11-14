import { format, subDays, startOfMonth, endOfMonth, startOfYear, subMonths } from "date-fns";
import type { ReportPeriod, DateRange } from "../types/report.types";

export const currency = new Intl.NumberFormat("en-BD", {
  style: "currency",
  currency: "BDT",
  maximumFractionDigits: 2,
});

export const shortNumber = new Intl.NumberFormat("en-BD", {
  maximumFractionDigits: 0,
});

// Display formatting is canonical app-wide (৳ + grouped decimals, "14 Nov 2026").
import {
  formatCurrency,
  formatNumber,
  formatDate,
  formatDateTime,
} from "@/lib/format";
export { formatCurrency, formatNumber, formatDate, formatDateTime };

export function getPeriodDateRange(period: ReportPeriod): DateRange {
  const today = new Date();
  switch (period) {
    case "today":
      return {
        startDate: format(today, "yyyy-MM-dd"),
        endDate: format(today, "yyyy-MM-dd"),
      };
    case "yesterday": {
      const y = subDays(today, 1);
      return {
        startDate: format(y, "yyyy-MM-dd"),
        endDate: format(y, "yyyy-MM-dd"),
      };
    }
    case "7d":
      return {
        startDate: format(subDays(today, 6), "yyyy-MM-dd"),
        endDate: format(today, "yyyy-MM-dd"),
      };
    case "30d":
      return {
        startDate: format(subDays(today, 29), "yyyy-MM-dd"),
        endDate: format(today, "yyyy-MM-dd"),
      };
    case "this_month":
      return {
        startDate: format(startOfMonth(today), "yyyy-MM-dd"),
        endDate: format(today, "yyyy-MM-dd"),
      };
    case "last_month": {
      const lm = subMonths(today, 1);
      return {
        startDate: format(startOfMonth(lm), "yyyy-MM-dd"),
        endDate: format(endOfMonth(lm), "yyyy-MM-dd"),
      };
    }
    case "this_year":
      return {
        startDate: format(startOfYear(today), "yyyy-MM-dd"),
        endDate: format(today, "yyyy-MM-dd"),
      };
    default:
      return {
        startDate: format(startOfMonth(today), "yyyy-MM-dd"),
        endDate: format(today, "yyyy-MM-dd"),
      };
  }
}

export function exportToCsv(
  filename: string,
  headers: string[],
  rows: (string | number | null | undefined)[][]
) {
  function csvCell(value: string | number | null | undefined): string {
    // Formula-injection guard: neutralise cells spreadsheet apps may execute,
    // including whitespace-prefixed attempts like "  =cmd".
    const s = String(value ?? "").replace(/^[\t\r ]*[=+\-@]/, "'$&");
    return `"${s.replace(/"/g, '""')}"`;
  }
  const lines = [headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
  const url = URL.createObjectURL(
    new Blob(["\uFEFF" + lines], { type: "text/csv;charset=utf-8;" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filename}-${format(new Date(), "yyyy-MM-dd")}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const periodOptions: { value: ReportPeriod; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "Last 7 Days" },
  { value: "30d", label: "Last 30 Days" },
  { value: "this_month", label: "This Month" },
  { value: "last_month", label: "Last Month" },
  { value: "this_year", label: "This Year" },
  { value: "custom", label: "Custom Range" },
];

