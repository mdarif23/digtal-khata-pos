import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Wallet } from "lucide-react";
import { formatCurrency as currency } from "@/lib/format";

/**
 * Dashboard presentational primitives (Phase 6 Feature 2, extracted
 * verbatim from Dashboard.tsx). Fully prop-driven; no behavior change.
 */

export function MetricCard({
  title,
  amount,
  growth,
  comparison,
  growthIsGood = true,
  detail,
  icon: Icon,
  accent,
}: {
  title: string;
  amount: number;
  growth?: number | null;
  comparison: string;
  growthIsGood?: boolean;
  detail: string;
  icon: typeof Wallet;
  accent: string;
}) {
  const growthUp = growth !== null && growth !== undefined && growth >= 0;
  const growthGood = growthUp === growthIsGood;
  const GrowthIcon = growthUp ? ArrowUpRight : ArrowDownRight;
  return (
    <article className="min-w-0 rounded-xl border border-border bg-card p-5 shadow-xs">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <p className="mt-3 truncate text-2xl font-semibold tracking-tight text-foreground">
            {currency(amount)}
          </p>
        </div>
        <span className={`rounded-xl p-2.5 ${accent}`}>
          <Icon aria-hidden="true" className="size-5" />
        </span>
      </div>
      <div className="mt-4 flex min-h-5 items-center justify-between gap-2">
        {growth === null || growth === undefined ? (
          <span className="text-xs text-muted-foreground">{detail}</span>
        ) : (
          <>
            <span
              className={`inline-flex items-center gap-1 text-xs font-medium ${
                growthGood ? "text-success" : "text-destructive"
              }`}
            >
              <GrowthIcon aria-hidden="true" className="size-3.5" />
              {Math.abs(growth).toLocaleString("en-BD")}% {comparison}
            </span>
            <span className="truncate text-xs text-muted-foreground/80">{detail}</span>
          </>
        )}
      </div>
    </article>
  );
}

export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <h2 className="font-semibold text-foreground">{title}</h2>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-36 items-center justify-center rounded-xl border border-dashed border-border px-4 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
