import React from "react";
import type { LucideIcon } from "lucide-react";
import { formatCurrency, formatNumber } from "../utils/reportUtils";

interface ReportMetricCardProps {
  title: string;
  value: number | string | null | undefined;
  isCurrency?: boolean;
  isCount?: boolean;
  isPercentage?: boolean;
  subtitle?: string | undefined;
  icon?: LucideIcon;
  accent?: string;
  valueClassName?: string | undefined;
}

export function ReportMetricCard({
  title,
  value,
  isCurrency = true,
  isCount = false,
  isPercentage = false,
  subtitle,
  icon: Icon,
  accent = "bg-slate-50 text-slate-700",
  valueClassName = "",
}: ReportMetricCardProps) {
  let displayValue = "—";
  if (value !== null && value !== undefined) {
    if (isPercentage) {
      displayValue = `${Number(value).toFixed(2)}%`;
    } else if (isCount) {
      displayValue = formatNumber(value);
    } else if (isCurrency) {
      displayValue = formatCurrency(value);
    } else {
      displayValue = String(value);
    }
  }

  return (
    <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-500">{title}</p>
          <p
            className={`mt-2 truncate text-2xl font-semibold tracking-tight text-slate-950 ${valueClassName}`}
          >
            {displayValue}
          </p>
        </div>
        {Icon && (
          <span className={`rounded-xl p-2.5 ${accent}`}>
            <Icon aria-hidden="true" className="size-5" />
          </span>
        )}
      </div>
      {subtitle && <p className="mt-2 text-xs text-slate-400">{subtitle}</p>}
    </article>
  );
}

