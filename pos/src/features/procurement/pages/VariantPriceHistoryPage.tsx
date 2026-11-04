import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, ScanSearch } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getErrorMessage } from "@/utils/getErrorMessage";
import { ReportTrendChart } from "@/features/reports/components/ReportChart";
import {
  formatCurrency,
  formatDate,
  formatNumber,
} from "@/features/reports/utils/reportUtils";
import { PriceChangeBadge } from "../components/PriceChangeBadge";
import { formatPercent } from "../utils/priceMath";
import { useVariantPriceHistory } from "../hooks/useProcurement";
import type { PriceHistoryFilters } from "../api/procurement.api";

const PAGE_SIZE = 20;

/**
 * Variant price history (Smart Procurement Phase 1): every RECEIVED
 * purchase line is a price event. Shows the historical summary, a trend
 * chart, a per-supplier comparison (cheapest latest price first), and the
 * paginated purchase records behind the numbers.
 */
export function VariantPriceHistoryPage() {
  const { variantId } = useParams();
  const id = Number(variantId);
  const validId = Number.isInteger(id) && id > 0 ? id : 0;

  const [page, setPage] = useState(1);
  const filters = useMemo<PriceHistoryFilters>(
    () => ({ page, limit: PAGE_SIZE }),
    [page],
  );

  const { data, isLoading, isError, error } = useVariantPriceHistory(
    validId,
    filters,
  );

  const chartData = useMemo(() => {
    const records = data?.records.data ?? [];
    // Records arrive newest-first; the trend reads chronologically.
    return [...records]
      .reverse()
      .map((record) => ({
        date: formatDate(record.purchaseDate),
        price: record.unitCost,
      }));
  }, [data]);

  const bestSupplierId = useMemo(() => {
    const suppliers = (data?.suppliers ?? []).filter(
      (s) => s.latestPrice !== null,
    );
    if (suppliers.length === 0) return null;
    return suppliers.reduce((best, current) =>
      (current.latestPrice ?? Infinity) < (best.latestPrice ?? Infinity)
        ? current
        : best,
    ).supplierId;
  }, [data]);

  const records = data?.records;
  const totalPages = Math.max(1, Math.ceil((records?.total ?? 0) / PAGE_SIZE));

  if (isError) {
    return (
      <div className="flex flex-col gap-4 p-4 md:p-6">
        <BackButton />
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          Could not load the price history. {getErrorMessage(error)}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <BackButton />

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">
            {isLoading ? (
              <Skeleton className="h-6 w-64" />
            ) : (
              <>
                {data?.variant.variantName || data?.variant.productName}
                <span className="ml-2 text-sm font-normal text-slate-400">
                  {data?.variant.sku ?? "—"}
                  {data?.variant.unitName ? ` · per ${data.variant.unitName}` : ""}
                </span>
              </>
            )}
          </CardTitle>
          <CardDescription>
            Historical received purchase prices for this product variant.
            Sell price today: {formatCurrency(data?.variant.sellingPrice ?? 0)}
          </CardDescription>
          <div className="flex">
            <Button
              variant="outline"
              size="sm"
              render={
                <Link to={`/procurement/price-check?variantId=${validId}`} />
              }
            >
              <ScanSearch aria-hidden className="size-4" />
              Quick Price Check
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
          <SummaryStat
            label="Latest price"
            value={isLoading ? null : formatCurrency(data?.summary.latestPrice)}
            highlight
          />
          <SummaryStat
            label="Previous"
            value={isLoading ? null : formatCurrency(data?.summary.previousPrice)}
          />
          <SummaryStat
            label="Change"
            value={isLoading ? null : formatPercent(data?.summary.priceChangePercent)}
            badge={
              data?.summary.priceChangePercent !== undefined && data ? (
                <PriceChangeBadge value={data.summary.priceChangePercent} />
              ) : null
            }
          />
          <SummaryStat
            label="Lowest"
            value={isLoading ? null : formatCurrency(data?.summary.lowestPrice)}
          />
          <SummaryStat
            label="Highest"
            value={isLoading ? null : formatCurrency(data?.summary.highestPrice)}
          />
          <SummaryStat
            label="Average"
            value={isLoading ? null : formatCurrency(data?.summary.averagePrice)}
          />
          <SummaryStat
            label="Purchases"
            value={
              isLoading
                ? null
                : `${formatNumber(data?.summary.purchaseCount ?? 0)} · last ${formatDate(data?.summary.lastPurchaseDate)}`
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Price trend</CardTitle>
          <CardDescription>
            Received unit cost per purchase, oldest to newest.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-72 w-full" />
          ) : (
            <ReportTrendChart
              data={chartData}
              xKey="date"
              lines={[
                { key: "price", name: "Unit cost", color: "#059669", isCurrency: true },
              ]}
              height={288}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Supplier comparison</CardTitle>
          <CardDescription>
            Same product, same unit — ordered by latest price, cheapest
            first. Only comparable received purchases are included; latest
            market quotations (per unit) shown beside them.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (data?.suppliers.length ?? 0) === 0 ? (
            <EmptyState text="No received purchases for this variant yet." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Supplier</TableHead>
                  <TableHead className="text-right">Latest</TableHead>
                  <TableHead className="text-right">Latest quotation</TableHead>
                  <TableHead className="text-right">Previous</TableHead>
                  <TableHead className="text-center">Change</TableHead>
                  <TableHead className="text-right">Lowest</TableHead>
                  <TableHead className="text-right">Highest</TableHead>
                  <TableHead className="text-right">Average</TableHead>
                  <TableHead className="text-right">Purchases</TableHead>
                  <TableHead>Last purchase</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.suppliers.map((supplier) => (
                  <TableRow key={supplier.supplierId ?? "none"}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {supplier.supplierName ?? "Unknown supplier"}
                        {supplier.supplierId === bestSupplierId ? (
                          <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                            Best price
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCurrency(supplier.latestPrice)}
                    </TableCell>
                    <TableCell className="text-right text-slate-500">
                      {supplier.latestQuotation !== null ? (
                        <div className="flex flex-col">
                          <span>{formatCurrency(supplier.latestQuotation)}</span>
                          <span className="text-xs text-slate-400">
                            quoted {formatDate(supplier.lastObservationDate)}
                          </span>
                        </div>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-slate-500">
                      {formatCurrency(supplier.previousPrice)}
                    </TableCell>
                    <TableCell className="text-center">
                      <PriceChangeBadge value={supplier.priceChangePercent} />
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(supplier.lowestPrice)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(supplier.highestPrice)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(supplier.averagePrice)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatNumber(supplier.purchaseCount)}
                    </TableCell>
                    <TableCell>{formatDate(supplier.lastPurchaseDate)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            Market quotations
            <Badge variant="secondary">Quotation</Badge>
          </CardTitle>
          <CardDescription>
            Manually observed prices from price checks — never actual
            purchases. Packaged quotes are normalized per unit for
            comparison.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (data?.observations.data.length ?? 0) === 0 ? (
            <EmptyState text="No quotations recorded for this variant. Use Quick Price Check after your next market visit." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead className="text-right">Quoted</TableHead>
                  <TableHead className="text-right">Per unit</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.observations.data.map((observation) => (
                  <TableRow key={observation.id}>
                    <TableCell>{formatDate(observation.observationDate)}</TableCell>
                    <TableCell>{observation.supplierName ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-col">
                        <span>{formatCurrency(observation.quotedPrice)}</span>
                        {observation.packageQuantity !== null ? (
                          <span className="text-xs text-slate-400">
                            for {observation.packageQuantity}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {observation.unitPrice !== null
                        ? formatCurrency(observation.unitPrice)
                        : <span className="text-slate-400">—</span>}
                    </TableCell>
                    <TableCell className="max-w-48 truncate text-sm text-slate-500">
                      {observation.notes ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Purchase records</CardTitle>
          <CardDescription>
            The received purchase lines behind this history. Ordered but
            unreceived purchases are never listed.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="overflow-x-auto">
            {isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (records?.data.length ?? 0) === 0 ? (
              <EmptyState text="No received purchases for this variant yet." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>PO number</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead className="text-right">Unit cost</TableHead>
                    <TableHead className="text-right">Ordered</TableHead>
                    <TableHead className="text-right">Received</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records?.data.map((record) => (
                    <TableRow key={record.purchaseId}>
                      <TableCell className="font-mono text-xs">
                        {record.purchaseOrderNumber}
                      </TableCell>
                      <TableCell>{formatDate(record.purchaseDate)}</TableCell>
                      <TableCell>{record.supplierName ?? "—"}</TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCurrency(record.unitCost)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatNumber(record.quantity)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatNumber(record.receivedQuantity)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 text-sm text-slate-500">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || isLoading}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </Button>
            <span>
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages || isLoading}
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            >
              Next
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function BackButton() {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="w-fit"
      render={<Link to="/procurement/prices" />}
    >
      <ArrowLeft aria-hidden className="size-4" />
      Back to Product Price Monitoring
    </Button>
  );
}

function SummaryStat({
  label,
  value,
  highlight,
  badge,
}: {
  label: string;
  value: string | null;
  highlight?: boolean | undefined;
  badge?: ReactNode;
}) {
  return (
    <div
      className={`flex flex-col gap-1 rounded-lg border p-3 ${
        highlight ? "border-emerald-200 bg-emerald-50/50" : ""
      }`}
    >
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-sm font-semibold">{value ?? "—"}</span>
      {badge}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center rounded-lg border border-dashed border-slate-200 py-10 text-sm text-slate-400">
      {text}
    </div>
  );
}
