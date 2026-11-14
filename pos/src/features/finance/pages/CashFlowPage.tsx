import { useState } from "react";
import { ArrowDownRight, ArrowUpRight, Scale } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SummaryCard } from "@/components/common/SummaryCard";
import { PageContainer } from "@/components/common/PageContainer";
import { PageHeader } from "@/components/common/PageHeader";
import { ReportDateFilter } from "@/features/reports/components/ReportDateFilter";
import { ReportTrendChart } from "@/features/reports/components/ReportChart";
import { ReportTable, type ReportColumn } from "@/features/reports/components/ReportTable";
import { formatCurrency } from "@/lib/format";
import type { ReportFilters } from "@/features/reports/types/report.types";
import { useCashFlow } from "../hooks/useFinance";

/**
 * Direct-method cash flow: every journal line on a cash-equivalent GL
 * account, classified by the posting hooks. The invariant — net movement
 * equals the change in cash balances — is asserted server-side.
 */

export function CashFlowPage() {
  const [filters, setFilters] = useState<ReportFilters>({
    period: "this_month",
  } as ReportFilters);
  const dateRange = filters.dateRange ?? {
    startDate: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
      .toISOString()
      .slice(0, 10),
    endDate: new Date().toISOString().slice(0, 10),
  };
  const cashFlow = useCashFlow(dateRange.startDate, dateRange.endDate);

  const sourceColumns: ReportColumn<{ sourceType: string; category: string; inflow: string; outflow: string; net: string }>[] = [
    { key: "sourceType", header: "Source", render: (row) => <span className="capitalize">{row.sourceType.replace(/_/g, " ")}</span> },
    { key: "category", header: "Category", render: (row) => <span className="capitalize">{row.category}</span> },
    {
      key: "inflow",
      header: "Inflow",
      render: (row) => <span className="text-success tabular-nums">{formatCurrency(row.inflow)}</span>,
      className: "text-right tabular-nums",
      headerClassName: "text-right",
    },
    {
      key: "outflow",
      header: "Outflow",
      render: (row) => <span className="text-destructive tabular-nums">{formatCurrency(row.outflow)}</span>,
      className: "text-right tabular-nums",
      headerClassName: "text-right",
    },
    {
      key: "net",
      header: "Net",
      render: (row) => <strong>{formatCurrency(row.net)}</strong>,
      className: "text-right tabular-nums",
      headerClassName: "text-right",
    },
  ];

  const series =
    cashFlow.data?.series.map((point) => ({
      date: point.date,
      inflow: Number(point.inflow),
      outflow: Number(point.outflow),
      net: Number(point.net),
    })) ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="Cash Flow"
        description="Direct method from the cash GL accounts. Credit sales appear only when collected. Net movement must equal the change in cash balances — it does by construction."
        actions={
          <ReportDateFilter filters={filters} onFiltersChange={setFilters} showLocationFilter={false} />
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <SummaryCard
          title="Cash Inflow"
          value={cashFlow.data ? formatCurrency(cashFlow.data.totals.inflow) : "—"}
          icon={<ArrowUpRight className="size-4 text-muted-foreground" />}
        />
        <SummaryCard
          title="Cash Outflow"
          value={cashFlow.data ? formatCurrency(cashFlow.data.totals.outflow) : "—"}
          icon={<ArrowDownRight className="size-4 text-muted-foreground" />}
        />
        <SummaryCard
          title="Net Movement"
          value={cashFlow.data ? formatCurrency(cashFlow.data.totals.net) : "—"}
          icon={<Scale className="size-4 text-muted-foreground" />}
        />
        <SummaryCard
          title="Closing Cash"
          value={cashFlow.data ? formatCurrency(cashFlow.data.reconciliation.closingBalance) : "—"}
          description={
            cashFlow.data
              ? `Opening ${formatCurrency(cashFlow.data.reconciliation.openingBalance)}`
              : undefined
          }
          icon={<Scale className="size-4 text-muted-foreground" />}
        />
      </div>

      {series.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Daily cash movement</CardTitle>
          </CardHeader>
          <CardContent>
            <ReportTrendChart
              data={series}
              xKey="date"
              lines={[
                { key: "inflow", name: "Inflow", color: "var(--chart-1)", isCurrency: true },
                { key: "outflow", name: "Outflow", color: "var(--destructive)", isCurrency: true },
                { key: "net", name: "Net", color: "var(--chart-2)", isCurrency: true },
              ]}
            />
          </CardContent>
        </Card>
      )}

      <section className="grid gap-4 lg:grid-cols-3">
        {(["operating", "investing", "financing"] as const).map((category) => (
          <Card key={category}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base capitalize">{category}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Inflow</span>
                <span className="text-success tabular-nums">
                  {formatCurrency(cashFlow.data?.byCategory[category].inflow ?? "0")}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Outflow</span>
                <span className="text-destructive tabular-nums">
                  {formatCurrency(cashFlow.data?.byCategory[category].outflow ?? "0")}
                </span>
              </div>
              <div className="flex justify-between border-t pt-1.5 font-semibold">
                <span>Net</span>
                <span className="tabular-nums">
                  {formatCurrency(cashFlow.data?.byCategory[category].net ?? "0")}
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">By source</CardTitle>
        </CardHeader>
        <CardContent>
          <ReportTable
            columns={sourceColumns}
            data={cashFlow.data?.bySource ?? []}
            loading={cashFlow.isLoading}
            keyExtractor={(row) => row.sourceType}
            emptyMessage="No cash movement in this period."
          />
        </CardContent>
      </Card>
    </PageContainer>
  );
}
