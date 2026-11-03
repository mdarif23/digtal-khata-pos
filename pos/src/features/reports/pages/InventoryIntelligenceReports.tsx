import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { Badge } from "@/components/ui/badge.js";
import { ReportHeader } from "../components/ReportHeader";
import { useReportData } from "../hooks/useReportData";
import { reportsApi } from "../api/reports.api.js";

const tk = (n: number) => `৳${n.toLocaleString()}`;

const BUCKET_LABELS: Record<string, string> = {
  "0-30": "0–30 days",
  "31-60": "31–60 days",
  "61-90": "61–90 days",
  "90+": "90+ days",
};

/** Batch-level inventory aging valued at each batch's own cost (Module 2D). */
export function InventoryAgingReport() {
  const [filters] = useState({ page: 1, limit: 50 });
  const { data, loading, error, refetch } = useReportData(
    () => reportsApi.getInventoryAging(),
    [filters],
  );

  const rows = data?.rows ?? [];
  const buckets = data?.buckets ?? {};

  return (
    <div className="space-y-4">
      <ReportHeader
        title="Inventory Aging"
        description="Remaining stock bucketed by how long ago each batch was received, valued at the batch's own cost."
        onRefresh={refetch}
        loading={loading}
      />
      {loading && <Skeleton className="h-48 w-full" />}
      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">
            Could not load the aging report.
          </CardContent>
        </Card>
      )}
      {!loading && !error && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {Object.entries(BUCKET_LABELS).map(([key, label]) => (
              <Card key={key}>
                <CardHeader className="pb-1">
                  <CardDescription className="text-xs">{label}</CardDescription>
                  <CardTitle className="text-lg">
                    {buckets[key]?.quantity ?? 0} units
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  {tk(buckets[key]?.value ?? 0)}
                </CardContent>
              </Card>
            ))}
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Batches</CardTitle>
              <CardDescription>
                Oldest first — the 90+ bucket is the discount/review priority.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="p-2 font-medium">Product</th>
                    <th className="p-2 font-medium">Batch</th>
                    <th className="p-2 text-right font-medium">Qty</th>
                    <th className="p-2 text-right font-medium">Unit cost</th>
                    <th className="p-2 text-right font-medium">Value</th>
                    <th className="p-2 text-right font-medium">Age</th>
                    <th className="p-2 font-medium">Bucket</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.batchId} className="border-t">
                      <td className="p-2">{row.productName}</td>
                      <td className="p-2 font-mono text-xs">
                        {row.batchNumber}
                      </td>
                      <td className="p-2 text-right font-mono">
                        {row.quantityRemaining}
                      </td>
                      <td className="p-2 text-right font-mono">
                        {tk(row.unitCost)}
                      </td>
                      <td className="p-2 text-right font-mono">
                        {tk(row.stockValue)}
                      </td>
                      <td className="p-2 text-right font-mono">
                        {row.ageDays}d
                      </td>
                      <td className="p-2">
                        <Badge
                          variant={row.bucket === "90+" ? "destructive" : "outline"}
                        >
                          {BUCKET_LABELS[row.bucket]}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-4 text-center text-muted-foreground">
                        No stock on hand.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/** Dead stock: stocked variants with no sales in the lookback window. */
export function DeadStockReport() {
  const [days, setDays] = useState(60);
  const { data, loading, error, refetch } = useReportData(
    () => reportsApi.getDeadStock(days),
    [days],
  );

  const rows = data ?? [];
  const totalValue = rows.reduce((sum, row) => sum + row.stockValue, 0);

  return (
    <div className="space-y-4">
      <ReportHeader
        title="Dead Stock"
        description="Stocked variants with no sales in the lookback window — capital sitting on the shelf."
        onRefresh={refetch}
        loading={loading}
        actions={
          <label className="flex items-center gap-2 text-sm">
            No sales in
            <select
              className="rounded-md border bg-background p-1.5 text-sm"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
              <option value={180}>180 days</option>
            </select>
          </label>
        }
      />
      {loading && <Skeleton className="h-48 w-full" />}
      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">
            Could not load the dead-stock report.
          </CardContent>
        </Card>
      )}
      {!loading && !error && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {rows.length} variant(s) · {tk(totalValue)} at cost
            </CardTitle>
            <CardDescription>
              Consider promotions, transfers to busier locations, or supplier
              returns for these.
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-2 font-medium">Product</th>
                  <th className="p-2 text-right font-medium">Stock</th>
                  <th className="p-2 text-right font-medium">Value</th>
                  <th className="p-2 font-medium">Last sold</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.variantId} className="border-t">
                    <td className="p-2">{row.productName}</td>
                    <td className="p-2 text-right font-mono">
                      {row.currentStock}
                    </td>
                    <td className="p-2 text-right font-mono">
                      {tk(row.stockValue)}
                    </td>
                    <td className="p-2 text-muted-foreground">
                      {row.lastSoldAt
                        ? `${row.daysSinceLastSale} days ago`
                        : "Never sold"}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="p-4 text-center text-muted-foreground">
                      Nothing dead in this window — everything moved.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
