import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { BellRing } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { usePermissions } from "@/hooks/usePermissions";
import {
  useAlertSettings,
  useUpdateAlertSettings,
} from "../hooks/useProcurement";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getErrorMessage } from "@/utils/getErrorMessage";
import useProductStore from "@/features/products/useProductStore";
import {
  formatCurrency,
  formatDate,
  formatNumber,
} from "@/features/reports/utils/reportUtils";
import { PriceChangeBadge } from "../components/PriceChangeBadge";
import { usePriceOverview } from "../hooks/useProcurement";
import type { PriceOverviewFilters } from "../api/procurement.api";

const PAGE_SIZE = 20;

/**
 * Product Price Monitoring (Smart Procurement Phase 1): compares the
 * latest received purchase price of every variant against its previous
 * price, historical low/high/average, and shows the last supplier — so
 * the owner can spot the cheapest comparable source at a glance.
 */
export function PriceMonitoringPage() {
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const canManageAlerts = hasPermission("purchases.manage_price_alerts");
  const categories = useProductStore(
    (state) => state.productSelectOptions.categories,
  );
  const supplierOptions = useProductStore(
    (state) => state.productSelectOptions.suppliers,
  );

  const alertSettings = useAlertSettings();
  const updateAlertSettings = useUpdateAlertSettings();
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const [alertThreshold, setAlertThreshold] = useState("10");
  const [alertsLoaded, setAlertsLoaded] = useState(false);

  useEffect(() => {
    if (alertSettings.data && !alertsLoaded) {
      setAlertsEnabled(alertSettings.data.enabled);
      setAlertThreshold(String(alertSettings.data.increaseThresholdPercent));
      setAlertsLoaded(true);
    }
  }, [alertSettings.data, alertsLoaded]);

  const saveAlertSettings = async () => {
    const threshold = Number(alertThreshold);
    if (!Number.isFinite(threshold) || threshold <= 0) {
      toast.add({
        type: "error",
        title: "Invalid threshold",
        description: "Enter a percentage above 0.",
      });
      return;
    }
    try {
      const saved = await updateAlertSettings.mutateAsync({
        enabled: alertsEnabled,
        increaseThresholdPercent: threshold,
      });
      setAlertsEnabled(saved.enabled);
      setAlertThreshold(String(saved.increaseThresholdPercent));
      toast.add({
        type: "success",
        title: "Alert settings saved",
        description: alertsEnabled
          ? `You will be notified when a supplier raises a price by ${threshold}% or more.`
          : "Price increase alerts are turned off.",
      });
    } catch (err) {
      toast.add({
        type: "error",
        title: "Could not save alert settings",
        description: getErrorMessage(err),
      });
    }
  };

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("all");
  const [supplierId, setSupplierId] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const filters = useMemo<PriceOverviewFilters>(
    () => ({
      search: search || undefined,
      categoryId: categoryId !== "all" ? Number(categoryId) : undefined,
      supplierId: supplierId !== "all" ? Number(supplierId) : undefined,
      from: from || undefined,
      to: to || undefined,
      page,
      limit: PAGE_SIZE,
    }),
    [search, categoryId, supplierId, from, to, page],
  );

  const { data, isLoading, isError, error } = usePriceOverview(filters);
  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const categoryItems = useMemo(
    () => [
      { value: "all", label: "All categories" },
      ...categories.map((c) => ({ value: String(c.value), label: c.label })),
    ],
    [categories],
  );
  const supplierItems = useMemo(
    () => [
      { value: "all", label: "All suppliers" },
      ...supplierOptions.map((s) => ({
        value: String(s.value),
        label: s.label,
      })),
    ],
    [supplierOptions],
  );

  const resetToFirstPage = (apply: () => void) => {
    apply();
    setPage(1);
  };

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BellRing aria-hidden className="size-4" />
            Price increase alerts
          </CardTitle>
          <CardDescription>
            Get a notification when a supplier raises a product's price by
            your threshold over their previous actual price. Alerts are
            factual — one per price event.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-6">
          <label className="flex items-center gap-3 text-sm font-medium">
            <Switch
              checked={alertsEnabled}
              disabled={!canManageAlerts || alertSettings.isLoading}
              onCheckedChange={(checked) => setAlertsEnabled(checked === true)}
            />
            {alertsEnabled ? "Enabled" : "Disabled"}
          </label>
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-slate-500">Threshold (%)</span>
              <Input
                aria-label="Alert threshold percentage"
                type="number"
                step="0.01"
                min="0.01"
                className="w-32"
                value={alertThreshold}
                disabled={!canManageAlerts}
                onChange={(event) => setAlertThreshold(event.target.value)}
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={!canManageAlerts || updateAlertSettings.isPending}
              onClick={() => void saveAlertSettings()}
            >
              Save
            </Button>
          </div>
          {!canManageAlerts ? (
            <p className="text-xs text-slate-400 sm:ml-auto">
              Only users with price alert permission can change these
              settings.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Product Price Monitoring</CardTitle>
          <CardDescription>
            Compare the latest received purchase price of every product
            against its history and suppliers. Only received purchase
            quantities count as actual prices — quotations come later from
            Price Check.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Input
              aria-label="Search products"
              placeholder="Search product or SKU…"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              className="lg:col-span-2"
            />
            <Select
              items={categoryItems}
              value={categoryId}
              onValueChange={(value) =>
                resetToFirstPage(() => setCategoryId(value ?? "all"))
              }
            >
              <SelectTrigger aria-label="Filter by category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {categoryItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              items={supplierItems}
              value={supplierId}
              onValueChange={(value) =>
                resetToFirstPage(() => setSupplierId(value ?? "all"))
              }
            >
              <SelectTrigger aria-label="Filter by supplier">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {supplierItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2">
              <Input
                aria-label="From date"
                type="date"
                value={from}
                onChange={(event) => resetToFirstPage(() => setFrom(event.target.value))}
              />
              <Input
                aria-label="To date"
                type="date"
                value={to}
                onChange={(event) => resetToFirstPage(() => setTo(event.target.value))}
              />
            </div>
          </div>

          {isError ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
            >
              Could not load the price overview. {getErrorMessage(error)}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Latest</TableHead>
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
                  {isLoading
                    ? Array.from({ length: 5 }).map((_, index) => (
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
                                  No price history yet
                                </p>
                                <p className="text-xs text-slate-400">
                                  Prices appear here once purchases are
                                  received into inventory.
                                </p>
                              </div>
                            </TableCell>
                          </TableRow>
                        )
                      : rows.map((row) => (
                          <TableRow
                            key={row.variantId}
                            className="cursor-pointer"
                            onClick={() =>
                              navigate(`/procurement/prices/${row.variantId}`)
                            }
                          >
                            <TableCell>
                              <div className="flex flex-col">
                                <span className="font-medium">
                                  {row.productName}
                                </span>
                                <span className="text-xs text-slate-400">
                                  {row.sku ?? "—"}
                                  {row.unitName ? ` · ${row.unitName}` : ""}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className="text-sm text-slate-500">
                              {row.categoryName}
                            </TableCell>
                            <TableCell className="text-right font-medium">
                              {formatCurrency(row.latestPrice)}
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
                            <TableCell className="text-sm">
                              <div className="flex flex-col">
                                <span>{formatDate(row.lastPurchaseDate)}</span>
                                <span className="text-xs text-slate-400">
                                  {row.lastSupplierName ?? "—"}
                                </span>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                </TableBody>
              </Table>
            </div>
          )}

          <div className="flex items-center justify-between text-sm text-slate-500">
            <span>
              {total} variant{total === 1 ? "" : "s"} with received purchases
            </span>
            <div className="flex items-center gap-2">
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
                onClick={() =>
                  setPage((current) => Math.min(totalPages, current + 1))
                }
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
