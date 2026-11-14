import { useState } from "react";
import { CheckCircle2, TriangleAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/common/StatusBadge";
import { SummaryCard } from "@/components/common/SummaryCard";
import { PageContainer } from "@/components/common/PageContainer";
import { PageHeader } from "@/components/common/PageHeader";
import { formatCurrency } from "@/lib/format";
import { useBalanceSheet } from "../hooks/useFinance";

/**
 * Balance Sheet & Net Worth — straight from the GL as of a date, with the
 * exact A = L + E identity surfaced as a `balanced` flag.
 */

export function BalanceSheetPage() {
  const [asOf, setAsOf] = useState("");
  const balanceSheet = useBalanceSheet(asOf || undefined);

  return (
    <PageContainer>
      <PageHeader title="Balance Sheet & Net Worth" />

      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="w-44">
            <Label className="text-xs text-muted-foreground">As of (optional)</Label>
            <Input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
            />
          </div>
          {balanceSheet.data && (
            <StatusBadge
              tone={balanceSheet.data.balanced ? "success" : "warning"}
              dot={false}
              className="gap-1"
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
            </StatusBadge>
          )}
        </div>
        <div className="grid w-full max-w-md grid-cols-2 gap-4">
          <SummaryCard
            title="Net Worth"
            value={balanceSheet.data ? formatCurrency(balanceSheet.data.netWorth) : "—"}
            icon={<CheckCircle2 className="size-4 text-muted-foreground" />}
          />
          <SummaryCard
            title="Total Assets"
            value={balanceSheet.data ? formatCurrency(balanceSheet.data.assets.total) : "—"}
            icon={<TriangleAlert className="size-4 text-muted-foreground" />}
          />
        </div>
      </div>

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
    </PageContainer>
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
        {lines.length === 0 && <p className="text-muted-foreground">Nothing to show.</p>}
        {lines.map((line) => (
          <div key={line.code} className="flex items-center justify-between gap-2">
            <span className="min-w-0 text-foreground">
              <span className="mr-1.5 font-mono text-xs text-muted-foreground">{line.code}</span>
              {line.name}
            </span>
            <span className="shrink-0 font-medium tabular-nums">{formatCurrency(line.balance)}</span>
          </div>
        ))}
        <div className="flex items-center justify-between border-t pt-2 font-semibold">
          <span>Total {title.toLowerCase()}</span>
          <span className="tabular-nums">{formatCurrency(total ?? "0")}</span>
        </div>
        {footnote && <p className="pt-1 text-xs text-muted-foreground">{footnote}</p>}
      </CardContent>
    </Card>
  );
}
