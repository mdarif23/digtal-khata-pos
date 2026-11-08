import { useState } from "react";
import { CheckCircle2, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ReportMetricCard } from "@/features/reports/components/ReportMetricCard";
import { formatCurrency } from "@/features/reports/utils/reportUtils";
import { useBalanceSheet } from "../hooks/useFinance";

/**
 * Balance Sheet & Net Worth — straight from the GL as of a date, with the
 * exact A = L + E identity surfaced as a `balanced` flag.
 */

export function BalanceSheetPage() {
  const [asOf, setAsOf] = useState("");
  const balanceSheet = useBalanceSheet(asOf || undefined);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">
            Finance &amp; Growth
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
            Balance Sheet &amp; Net Worth
          </h1>
          <div className="mt-2 flex items-center gap-3">
            <div className="w-44">
              <Label className="text-xs text-slate-500">As of (optional)</Label>
              <Input
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
              />
            </div>
            {balanceSheet.data && (
              <Badge
                variant="outline"
                className={
                  balanceSheet.data.balanced
                    ? "mt-4 gap-1 border-emerald-300 text-emerald-700"
                    : "mt-4 gap-1 border-amber-300 text-amber-700"
                }
              >
                {balanceSheet.data.balanced ? (
                  <>
                    <CheckCircle2 className="size-3.5" /> Assets = Liabilities + Equity
                  </>
                ) : (
                  <>
                    <TriangleAlert className="size-3.5" /> Out of balance — investigate
                  </>
                )}
              </Badge>
            )}
          </div>
        </div>
        <div className="grid w-full max-w-md grid-cols-2 gap-4">
          <ReportMetricCard
            title="Net Worth"
            value={balanceSheet.data?.netWorth}
            icon={CheckCircle2}
            accent="bg-emerald-50 text-emerald-700"
          />
          <ReportMetricCard
            title="Total Assets"
            value={balanceSheet.data?.assets.total}
            icon={TriangleAlert}
            accent="bg-sky-50 text-sky-700"
          />
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard
          title="Assets"
          lines={balanceSheet.data?.assets.lines ?? []}
          total={balanceSheet.data?.assets.total}
          footnote={
            balanceSheet.data
              ? `Net fixed assets: ${formatCurrency(balanceSheet.data.assets.netFixedAssets)}`
              : undefined
          }
        />
        <SectionCard
          title="Liabilities"
          lines={balanceSheet.data?.liabilities.lines ?? []}
          total={balanceSheet.data?.liabilities.total}
        />
        <SectionCard
          title="Equity"
          lines={balanceSheet.data?.equity.lines ?? []}
          total={balanceSheet.data?.equity.total}
          footnote={
            balanceSheet.data
              ? `Current earnings: ${formatCurrency(balanceSheet.data.equity.currentEarnings)}`
              : undefined
          }
        />
      </div>
    </div>
  );
}

function SectionCard({
  title,
  lines,
  total,
  footnote,
}: {
  title: string;
  lines: { code: string; name: string; balance: string }[];
  total?: string;
  footnote?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 text-sm">
        {lines.length === 0 && <p className="text-slate-400">Nothing to show.</p>}
        {lines.map((line) => (
          <div key={line.code} className="flex items-center justify-between gap-2">
            <span className="min-w-0 text-slate-600">
              <span className="mr-1.5 font-mono text-xs text-slate-400">{line.code}</span>
              {line.name}
            </span>
            <span className="shrink-0 font-medium">{formatCurrency(line.balance)}</span>
          </div>
        ))}
        <div className="flex items-center justify-between border-t pt-2 font-semibold">
          <span>Total {title.toLowerCase()}</span>
          <span>{formatCurrency(total ?? "0")}</span>
        </div>
        {footnote && <p className="pt-1 text-xs text-slate-400">{footnote}</p>}
      </CardContent>
    </Card>
  );
}
