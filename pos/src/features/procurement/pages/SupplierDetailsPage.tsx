import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, LineChart } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import { ReportTrendChart } from "@/features/reports/components/ReportChart";
import {
  formatCurrency,
  formatDate,
  formatNumber,
} from "@/features/reports/utils/reportUtils";
import { PriceChangeBadge } from "../components/PriceChangeBadge";
import {
  useSupplierDetail,
  useSupplierPriceHistory,
  useSupplierVariantTrend,
} from "../hooks/useProcurement";
import type { SupplierHistoryFilters } from "../api/procurement.api";

const PAGE_SIZE = 20;

/**
 * Supplier Price Monitoring (Smart Procurement Phase 3): this supplier's
 * actual received purchase prices per product, their trend, and the
 * latest recorded quotation — factual reporting only.
 */
export function SupplierDetailsPage() {
  const { supplierId } = useParams();
  const id = Number(supplierId);
  const validId = Number.isInteger(id) && id > 0 ? id : 0;

  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [trendVariantId, setTrendVariantId] = useState("");

  const filters = useMemo<SupplierHistoryFilters>(
    () => ({ search: search || undefined, page, limit: PAGE_SIZE }),
    [search, page],
  );

  const detail = useSupplierDetail(validId);
  const history = useSupplierPriceHistory(validId, filters);
  const variantTrendId = trendVariantId ? Number(trendVariantId) : 0;
  const trend = useSupplierVariantTrend(validId, variantTrendId);

  const rows = history.data?.data ?? [];
  const total = history.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Auto-select the first product for the trend chart.
  useEffect(() => {
    if (!trendVariantId && rows.length > 0) {
      setTrendVariantId(String(rows[0]!.variantId));
    }
  }, [rows, trendVariantId]);

  const chartData = useMemo(
    () =>
      (trend.data ?? []).map((event) => ({
        date: formatDate(event.purchaseDate),
        price: event.unitCost,
      })),
    [trend.data],
  );

  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4 p-4 md:p-6">
        <BackButton />
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          Could not load the supplier. {getErrorMessage(detail.error)}
        </div>
      </div>
    );
  }

  const supplier = detail.data?.supplier;
  const stats = detail.data?.stats;

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <BackButton />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            {detail.isLoading ? (
              <Skeleton className="h-6 w-56" />
            ) : (
              <>
                {supplier?.name}
                <Badge
                  variant="secondary"
                  className={
                    supplier?.status === "active"
                      ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-100"
                      : ""
                  }
                >
                  {supplier?.status ?? "Unknown"}
                </Badge>
              </>
            )}
          </CardTitle>
          <CardDescription>
            {supplier?.phone ? `${supplier.phone} · ` : ""}
            {supplier?.email ? `${supplier.email} · ` : ""}
            {supplier?.address ?? "No address on file"}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard
            label="Received purchases"
            value={detail.isLoading ? null : formatNumber(stats?.purchaseCount ?? 0)}
          />
          <StatCard
            label="Received value"
            value={detail.isLoading ? null : formatCurrency(stats?.totalReceivedValue ?? 0)}
          />
          <StatCard
            label="Products supplied"
            value={detail.isLoading ? null : formatNumber(stats?.productCount ?? 0)}
          />
          <StatCard
            label="Last purchase"
            value={detail.isLoading ? null : formatDate(stats?.lastPurchaseDate)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Price history</CardTitle>
          <CardDescription>
            This supplier's actual received purchase prices per product,
            with the latest recorded quotation beside them. Change badges
            report the latest price against this supplier's previous price.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Input
            aria-label="Search supplier products"
            placeholder="Search product or SKU…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
          {history.isError ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
            >
              Could not load the price history. {getErrorMessage(history.error)}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
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
                  {history.isLoading
                    ? Array.from({ length: 4 }).map((_, index) => (
                        <TableRow key={index}>
                          {Array.from({ length: 10 }).map((_, cell) => (
                            <TableCell key={cell}>
                              <Skeleton className="h-4 w-full" />
                            </TableCell>
                          ))}
                        </TableRow>
                      ))
                    : rows.length === 0
                      ? (
                          <TableRow>
                            <TableCell colSpan={10}>
                              <div className="flex flex-col items-center gap-1 py-10 text-center">
                                <p className="text-sm font-medium text-slate-600">
                                  No received purchases from this supplier yet
                                </p>
                                <p className="text-xs text-slate-400">
                                  Prices appear once purchases are received.
                                </p>
                              </div>
                            </TableCell>
                          </TableRow>
                        )
                      : rows.map((row) => (
                          <TableRow key={row.variantId}>
                            <TableCell>
                              <div className="flex flex-col">
                                <span className="font-medium">{row.productName}</span>
                                <span className="text-xs text-slate-400">
                                  {row.sku ?? "—"}
                                  {row.unitName ? ` · ${row.unitName}` : ""}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className="text-right font-medium">
                              {formatCurrency(row.latestPrice)}
                            </TableCell>
                            <TableCell className="text-right text-slate-500">
                              {row.latestQuotation !== null ? (
                                <div className="flex flex-col">
                                  <span>{formatCurrency(row.latestQuotation)}</span>
                                  <span className="text-xs text-slate-400">
                                    quoted {formatDate(row.lastObservationDate)}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-slate-400">—</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right text-slate-500">
                              {formatCurrency(row.previousPrice)}
                            </TableCell>
                            <TableCell className="text-center">
                              <PriceChangeBadge value={row.priceChangePercent} />
                            </TableCell>
                            <TableCell className="text-right">
                              {formatCurrency(row.lowestPrice)}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatCurrency(row.highestPrice)}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatCurrency(row.averagePrice)}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatNumber(row.purchaseCount)}
                            </TableCell>
                            <TableCell>{formatDate(row.lastPurchaseDate)}</TableCell>
                          </TableRow>
                        ))}
                </TableBody>
              </Table>
            </div>
          )}
          <div className="flex items-center justify-end gap-2 text-sm text-slate-500">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || history.isLoading}
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
              disabled={page >= totalPages || history.isLoading}
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            >
              Next
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <LineChart aria-hidden className="size-4" />
            Price trend
          </CardTitle>
          <CardDescription>
            This supplier's received unit cost for the selected product,
            oldest to newest.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Select
            items={rows.map((row) => ({
              value: String(row.variantId),
              label: `${row.productName}${row.sku ? ` · ${row.sku}` : ""}`,
            }))}
            value={trendVariantId}
            onValueChange={(value) => setTrendVariantId(value ?? "")}
          >
            <SelectTrigger aria-label="Select product for trend" className="sm:w-72">
              <SelectValue placeholder="Select a product" />
            </SelectTrigger>
            <SelectContent>
              {rows.map((row) => (
                <SelectItem key={row.variantId} value={String(row.variantId)}>
                  {row.productName}
                  {row.sku ? ` · ${row.sku}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {trend.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <ReportTrendChart
              data={chartData}
              xKey="date"
              lines={[
                { key: "price", name: "Unit cost", color: "#0284c7", isCurrency: true },
              ]}
              height={256}
            />
          )}
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
      render={<Link to="/suppliers" />}
    >
      <ArrowLeft aria-hidden className="size-4" />
      Back to Suppliers
    </Button>
  );
}

function StatCard({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-3">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-sm font-semibold">{value ?? "—"}</span>
    </div>
  );
}
