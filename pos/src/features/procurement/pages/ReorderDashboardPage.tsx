import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ArrowRight, ShoppingCart, TriangleAlert } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { toast } from "@/components/ui/toast";
import useProductStore from "@/features/products/useProductStore";
import {
  formatCurrency,
  formatNumber,
} from "@/features/reports/utils/reportUtils";
import {
  convertSuggestionsApi,
  getReorderDashboardApi,
  type ReorderDashboardFilters,
  type ReorderRow,
} from "../api/procurement.api";
import {
  useConvertSuggestions,
  useReorderDashboard,
} from "../hooks/useProcurement";

const PAGE_SIZE = 20;

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  out_of_stock: {
    label: "Out of stock",
    className: "bg-red-100 text-red-700 hover:bg-red-100",
  },
  low_stock: {
    label: "Low stock",
    className: "bg-amber-100 text-amber-700 hover:bg-amber-100",
  },
  needs_reorder: {
    label: "Needs reorder",
    className: "bg-sky-100 text-sky-700 hover:bg-sky-100",
  },
  healthy: { label: "Healthy", className: "" },
};

const ORDER_STATUS_BADGE: Record<string, { label: string; className: string }> = {
  below_minimum: {
    label: "Below minimum",
    className: "bg-amber-100 text-amber-700 hover:bg-amber-100",
  },
  minimum_reached: {
    label: "Minimum reached",
    className: "bg-sky-100 text-sky-700 hover:bg-sky-100",
  },
  target_reached: {
    label: "Target reached",
    className: "bg-emerald-100 text-emerald-700 hover:bg-emerald-100",
  },
  above_target: {
    label: "Above target",
    className: "bg-emerald-100 text-emerald-700 hover:bg-emerald-100",
  },
  ready_for_review: { label: "Ready for review", className: "" },
};

/**
 * Smart Reorder Planning (Phase 4): one netting rule — available =
 * (stock − reserved) + outstanding POs + in-transit inbound transfers —
 * drives the dashboard, supplier-wise grouping, and draft PO creation
 * through the existing reorder conversion. Quantities stay editable and
 * nothing is ever ordered automatically.
 */
export function ReorderDashboardPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("attention");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [addedRows, setAddedRows] = useState<ReorderRow[]>([]);
  const [supplierChoice, setSupplierChoice] = useState<
    Record<string, number | null>
  >({});
  const [additionalRows, setAdditionalRows] = useState<{
    groupKey: string;
    rows: ReorderRow[];
    loading: boolean;
  } | null>(null);

  const supplierOptions = useProductStore(
    (state) => state.productSelectOptions.suppliers,
  );

  const filters = useMemo<ReorderDashboardFilters>(
    () => ({
      search: search || undefined,
      status: (status || undefined) as ReorderDashboardFilters["status"],
      page,
      limit: PAGE_SIZE,
    }),
    [search, status, page],
  );

  const { data, isLoading, isError, error } = useReorderDashboard(filters);
  const convert = useConvertSuggestions();

  const rows = data?.data ?? [];
  const summary = data?.summary;
  const groups = data?.suppliers ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const selectedRows = useMemo(() => {
    const seen = new Set<number>();
    const merged: ReorderRow[] = [];
    for (const row of [...addedRows, ...rows]) {
      if (selected.has(row.variantId) && !seen.has(row.variantId)) {
        seen.add(row.variantId);
        merged.push(row);
      }
    }
    return merged;
  }, [rows, addedRows, selected]);

  const draftGroups = useMemo(() => {
    const map = new Map<string, {
      key: string;
      supplierId: number | null;
      supplierName: string;
      orderStatus: string;
      amountRemaining: number;
      minimumOrderValue: number | null;
      items: { row: ReorderRow; quantity: number }[];
      value: number;
    }>();
    for (const row of selectedRows) {
      const quantity =
        quantities[row.variantId] ?? row.suggestedQuantity ?? 0;
      if (quantity <= 0) continue;
      const key =
        row.lastSupplierId === null ? "none" : String(row.lastSupplierId);
      const group = map.get(key) ?? {
        key,
        supplierId: row.lastSupplierId,
        supplierName: row.lastSupplierName ?? "No supplier yet",
        orderStatus: "ready_for_review",
        amountRemaining: 0,
        minimumOrderValue: null,
        items: [],
        value: 0,
      };
      group.items.push({ row, quantity });
      group.value +=
        row.lastUnitCost !== null
          ? Number((quantity * row.lastUnitCost).toFixed(2))
          : 0;
      map.set(key, group);
    }
    // Attach the order-value status from the supplier groups when known.
    const groupMeta = new Map(
      groups.map((g) => [g.supplierId === null ? "none" : String(g.supplierId), g]),
    );
    return [...map.values()].map((group) => {
      const meta = groupMeta.get(group.key);
      return {
        ...group,
        orderStatus: meta?.orderStatus ?? "ready_for_review",
        amountRemaining: meta?.amountRemaining ?? 0,
        minimumOrderValue: meta?.minimumOrderValue ?? null,
      };
    });
  }, [selectedRows, quantities, groups]);

  const toggleRow = (row: ReorderRow, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(row.variantId);
      } else {
        next.delete(row.variantId);
      }
      return next;
    });
  };

  const addAdditionalRow = (row: ReorderRow) => {
    setAddedRows((current) =>
      current.some((r) => r.variantId === row.variantId)
        ? current
        : [...current, row],
    );
    setSelected((current) => new Set(current).add(row.variantId));
    setAdditionalRows((current) =>
      current
        ? {
            ...current,
            rows: current.rows.filter((r) => r.variantId !== row.variantId),
          }
        : current,
    );
  };

  const showAdditionalProducts = async (groupKey: string, supplierId: number | null) => {
    if (supplierId === null) return;
    setAdditionalRows({ groupKey, rows: [], loading: true });
    try {
      const result = await getReorderDashboardApi({
        supplierId,
        status: "attention",
        limit: 50,
      });
      setAdditionalRows({
        groupKey,
        rows: result.data.filter(
          (row) =>
            !selected.has(row.variantId) &&
            row.variantId !== undefined &&
            !addedRows.some((added) => added.variantId === row.variantId),
        ),
        loading: false,
      });
    } catch (err) {
      toast.add({
        type: "error",
        title: "Could not load additional products",
        description: getErrorMessage(err),
      });
      setAdditionalRows(null);
    }
  };

  const onCreateDrafts = async () => {
    try {
      const created: string[] = [];
      for (const group of draftGroups) {
        const chosen = supplierChoice[group.key];
        const supplierId = chosen === undefined ? group.supplierId : chosen;
        const result = await convertSuggestionsApi({
          supplierId,
          items: group.items.map((item) => ({
            variantId: item.row.variantId,
            quantity: item.quantity,
          })),
          note: "Created from the reorder dashboard",
        });
        if (result.purchaseOrderNumber) {
          created.push(result.purchaseOrderNumber);
        }
      }
      toast.add({
        type: "success",
        title: `Created ${created.length} draft purchase order${created.length === 1 ? "" : "s"}`,
        description: created.join(", "),
      });
      setConfirmOpen(false);
      setSelected(new Set());
      setQuantities({});
      setAddedRows([]);
      setSupplierChoice({});
      setAdditionalRows(null);
    } catch (err) {
      toast.add({
        type: "error",
        title: "Could not create draft purchase orders",
        description: getErrorMessage(err),
      });
    }
  };

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Smart Reorder Planning</CardTitle>
          <CardDescription>
            Availability nets reserved stock, outstanding purchase orders,
            and in-transit transfers into this location — so nothing is
            double-ordered. Quantities are suggestions; you decide what to
            order.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <MetricCard
            label="Out of stock"
            value={summary ? formatNumber(summary.outOfStock) : null}
            tone="text-red-600"
          />
          <MetricCard
            label="Low stock"
            value={summary ? formatNumber(summary.lowStock) : null}
            tone="text-amber-600"
          />
          <MetricCard
            label="Needs reorder"
            value={summary ? formatNumber(summary.needsReorder) : null}
            tone="text-sky-600"
          />
          <MetricCard
            label="Estimated reorder value"
            value={summary ? formatCurrency(summary.totalEstimatedValue) : null}
          />
          <MetricCard
            label="No supplier yet"
            value={summary ? formatNumber(summary.noSupplierCount) : null}
          />
          <MetricCard
            label="Missing purchase price"
            value={summary ? formatNumber(summary.missingPriceCount) : null}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Supplier-wise reorder summary</CardTitle>
          <CardDescription>
            Attention products grouped by their last supplier, with the
            supplier's order-value settings for reference.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : groups.length === 0 ? (
            <div className="flex items-center justify-center rounded-lg border border-dashed border-slate-200 py-8 text-sm text-slate-400">
              Nothing to group — no attention products with a cost basis.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Order status</TableHead>
                  <TableHead className="text-right">Remaining to minimum</TableHead>
                  <TableHead className="text-right">Products</TableHead>
                  <TableHead className="text-right">Suggested qty</TableHead>
                  <TableHead className="text-right">Estimated value</TableHead>
                  <TableHead className="text-right">Min. order</TableHead>
                  <TableHead className="text-right">Target order</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((group) => {
                  const badge =
                    ORDER_STATUS_BADGE[group.orderStatus] ??
                    ORDER_STATUS_BADGE.ready_for_review!;
                  return (
                    <TableRow key={group.supplierId ?? "none"}>
                      <TableCell className="font-medium">
                        {group.supplierName ?? "No supplier yet"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className={badge.className}>
                          {badge.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {group.orderStatus === "below_minimum"
                          ? formatCurrency(group.amountRemaining)
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatNumber(group.itemCount)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatNumber(group.totalQuantity)}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCurrency(group.estimatedValue)}
                      </TableCell>
                      <TableCell className="text-right text-slate-500">
                        {group.minimumOrderValue !== null
                          ? formatCurrency(group.minimumOrderValue)
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right text-slate-500">
                        {group.targetOrderValue !== null
                          ? formatCurrency(group.targetOrderValue)
                          : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Products</CardTitle>
          <CardDescription>
            Select products and create supplier-wise draft purchase orders —
            nothing is submitted or paid automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Input
              aria-label="Search products"
              placeholder="Search product or SKU…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
                setSelected(new Set());
              }}
            />
            <Select
              items={[
                { value: "attention", label: "Needs attention" },
                { value: "all", label: "All monitored" },
                { value: "out_of_stock", label: "Out of stock" },
                { value: "low_stock", label: "Low stock" },
                { value: "needs_reorder", label: "Needs reorder" },
                { value: "healthy", label: "Healthy" },
              ]}
              value={status}
              onValueChange={(value) => {
                setStatus(value ?? "attention");
                setPage(1);
                setSelected(new Set());
              }}
            >
              <SelectTrigger aria-label="Filter by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="attention">Needs attention</SelectItem>
                <SelectItem value="all">All monitored</SelectItem>
                <SelectItem value="out_of_stock">Out of stock</SelectItem>
                <SelectItem value="low_stock">Low stock</SelectItem>
                <SelectItem value="needs_reorder">Needs reorder</SelectItem>
                <SelectItem value="healthy">Healthy</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center justify-end gap-2">
              <Button
                disabled={selectedRows.length === 0 || convert.isPending}
                onClick={() => setConfirmOpen(true)}
              >
                <ShoppingCart aria-hidden className="size-4" />
                Create draft POs ({selectedRows.length})
              </Button>
            </div>
          </div>

          {isError ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
            >
              Could not load the reorder dashboard. {getErrorMessage(error)}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <span className="sr-only">Select</span>
                    </TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Stock</TableHead>
                    <TableHead className="text-right">Reserved</TableHead>
                    <TableHead className="text-right">On order</TableHead>
                    <TableHead className="text-right">In transit</TableHead>
                    <TableHead className="text-right">Available</TableHead>
                    <TableHead className="text-right">Suggested qty</TableHead>
                    <TableHead className="text-right">Est. unit cost</TableHead>
                    <TableHead className="text-right">Est. value</TableHead>
                    <TableHead>Last supplier</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading
                    ? Array.from({ length: 5 }).map((_, index) => (
                        <TableRow key={index}>
                          {Array.from({ length: 12 }).map((_, cell) => (
                            <TableCell key={cell}>
                              <Skeleton className="h-4 w-full" />
                            </TableCell>
                          ))}
                        </TableRow>
                      ))
                    : rows.length === 0
                      ? (
                          <TableRow>
                            <TableCell colSpan={12}>
                              <div className="flex flex-col items-center gap-1 py-10 text-center">
                                <p className="text-sm font-medium text-slate-600">
                                  Nothing needs attention
                                </p>
                                <p className="text-xs text-slate-400">
                                  Configure reorder points or alert quantities
                                  on variants to monitor them here.
                                </p>
                              </div>
                            </TableCell>
                          </TableRow>
                        )
                      : rows.map((row) => {
                          const selectable = row.suggestedQuantity !== null;
                          const isSelected = selected.has(row.variantId);
                          const badge = STATUS_BADGE[row.status] ?? STATUS_BADGE.healthy!;
                          return (
                            <TableRow key={row.variantId}>
                              <TableCell>
                                <Checkbox
                                  aria-label={`Select ${row.productName}`}
                                  disabled={!selectable}
                                  checked={isSelected}
                                  onCheckedChange={(checked) =>
                                    toggleRow(row, checked === true)
                                  }
                                />
                              </TableCell>
                              <TableCell>
                                <div className="flex flex-col">
                                  <span className="font-medium">
                                    {row.productName}
                                  </span>
                                  <span className="flex items-center gap-2 text-xs text-slate-400">
                                    <span>
                                      {row.sku ?? "—"}
                                      {row.unitName ? ` · ${row.unitName}` : ""}
                                    </span>
                                    <Link
                                      to={`/procurement/prices/${row.variantId}`}
                                      className="text-sky-600 hover:underline"
                                      onClick={(event) => event.stopPropagation()}
                                    >
                                      Compare prices
                                    </Link>
                                  </span>
                                </div>
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant="secondary"
                                  className={badge.className}
                                >
                                  {badge.label}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right">
                                {formatNumber(row.currentStock)}
                              </TableCell>
                              <TableCell className="text-right text-slate-500">
                                {row.reservedQuantity > 0
                                  ? formatNumber(row.reservedQuantity)
                                  : "—"}
                              </TableCell>
                              <TableCell className="text-right text-slate-500">
                                {row.outstandingOnOrder > 0
                                  ? formatNumber(row.outstandingOnOrder)
                                  : "—"}
                              </TableCell>
                              <TableCell className="text-right text-slate-500">
                                {row.inTransitQuantity > 0
                                  ? formatNumber(row.inTransitQuantity)
                                  : "—"}
                              </TableCell>
                              <TableCell className="text-right font-medium">
                                {formatNumber(row.availableQuantity)}
                              </TableCell>
                              <TableCell className="text-right">
                                {isSelected ? (
                                  <Input
                                    aria-label={`Quantity for ${row.productName}`}
                                    type="number"
                                    min="1"
                                    className="ml-auto h-8 w-20 text-right"
                                    value={
                                      quantities[row.variantId] ??
                                      row.suggestedQuantity ??
                                      ""
                                    }
                                    onChange={(event) =>
                                      setQuantities((current) => ({
                                        ...current,
                                        [row.variantId]: Number(event.target.value),
                                      }))
                                    }
                                  />
                                ) : row.suggestedQuantity !== null ? (
                                  formatNumber(row.suggestedQuantity)
                                ) : (
                                  <span className="text-xs text-slate-400">
                                    set qty at order time
                                  </span>
                                )}
                              </TableCell>
                              <TableCell className="text-right text-slate-500">
                                {row.lastUnitCost !== null
                                  ? formatCurrency(row.lastUnitCost)
                                  : "—"}
                              </TableCell>
                              <TableCell className="text-right">
                                {row.estimatedValue !== null
                                  ? formatCurrency(row.estimatedValue)
                                  : "—"}
                              </TableCell>
                              <TableCell className="text-sm">
                                <div className="flex flex-col">
                                  <span>
                                    {row.lastSupplierName ?? (
                                      <span className="text-amber-600">
                                        No supplier yet
                                      </span>
                                    )}
                                  </span>
                                  <span className="text-xs text-slate-400">
                                    last purchase{" "}
                                    {row.lastUnitCost !== null ? "recorded" : "missing"}
                                  </span>
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                </TableBody>
              </Table>
            </div>
          )}

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

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmOpen(false);
            setAdditionalRows(null);
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create draft purchase orders</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 text-sm">
            <p className="text-slate-500">
              One unpaid draft per supplier, created through the existing
              purchase workflow. Review them in Purchases before receiving or
              paying anything — you can also change the supplier per draft.
            </p>
            {draftGroups.map((group) => {
              const badge =
                ORDER_STATUS_BADGE[group.orderStatus] ??
                ORDER_STATUS_BADGE.ready_for_review!;
              const choiceKey = String(group.key);
              return (
                <div key={group.key} className="flex flex-col gap-3 rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="text-xs font-medium text-slate-500">
                        Draft for
                      </span>
                      <Select
                        items={[
                          ...supplierOptions.map((supplier) => ({
                            value: String(supplier.value),
                            label: supplier.label,
                          })),
                          ...(group.supplierId === null
                            ? [{ value: "none", label: "No supplier yet" }]
                            : []),
                        ]}
                        value={
                          choiceKey in supplierChoice
                            ? String(supplierChoice[choiceKey] ?? "none")
                            : group.supplierId === null
                              ? "none"
                              : String(group.supplierId)
                        }
                        onValueChange={(value) =>
                          setSupplierChoice((current) => ({
                            ...current,
                            [choiceKey]:
                              value === "none" || value === null
                                ? null
                                : Number(value),
                          }))
                        }
                      >
                        <SelectTrigger
                          aria-label={`Supplier for draft ${group.supplierName}`}
                          className="w-full"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {supplierOptions.map((supplier) => (
                            <SelectItem
                              key={supplier.value}
                              value={String(supplier.value)}
                            >
                              {supplier.label}
                            </SelectItem>
                          ))}
                          {group.supplierId === null ? (
                            <SelectItem value="none">No supplier yet</SelectItem>
                          ) : null}
                        </SelectContent>
                      </Select>
                    </div>
                    <span className="whitespace-nowrap font-medium">
                      {formatCurrency(group.value)}
                    </span>
                  </div>

                  <div className="flex flex-col gap-1">
                    {group.items.map((item) => (
                      <div
                        key={item.row.variantId}
                        className="flex items-center justify-between text-xs text-slate-500"
                      >
                        <span>
                          {item.row.productName} × {item.quantity}
                        </span>
                        <span>
                          {item.row.lastUnitCost !== null
                            ? formatCurrency(item.row.lastUnitCost * item.quantity)
                            : "no price"}
                        </span>
                      </div>
                    ))}
                  </div>

                  <Badge variant="secondary" className={`w-fit ${badge.className}`}>
                    {badge.label}
                  </Badge>

                  {group.orderStatus === "below_minimum" ? (
                    <div className="flex flex-col gap-2 rounded-md border border-amber-200 bg-amber-50/60 p-2">
                      <p className="flex items-start gap-2 text-xs text-amber-700">
                        <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                        Below {group.supplierName}&apos;s minimum by{" "}
                        {formatCurrency(group.amountRemaining)}. You can still
                        create this draft, or add other products that genuinely
                        need replenishment.
                      </p>
                      {group.supplierId !== null ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-fit"
                          disabled={additionalRows?.loading === true}
                          onClick={() =>
                            void showAdditionalProducts(group.key, group.supplierId)
                          }
                        >
                          Show needed products
                          <ArrowRight aria-hidden className="size-3.5" />
                        </Button>
                      ) : null}
                      {additionalRows?.groupKey === group.key &&
                      !additionalRows.loading ? (
                        additionalRows.rows.length === 0 ? (
                          <p className="text-xs text-slate-400">
                            No other products from this supplier need
                            replenishment right now.
                          </p>
                        ) : (
                          <div className="flex flex-col gap-1">
                            {additionalRows.rows.map((row) => (
                              <div
                                key={row.variantId}
                                className="flex items-center justify-between gap-2 text-xs"
                              >
                                <span className="truncate">
                                  {row.productName}
                                  {row.sku ? ` · ${row.sku}` : ""}
                                </span>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 shrink-0"
                                  onClick={() => addAdditionalRow(row)}
                                >
                                  Add
                                </Button>
                              </div>
                            ))}
                          </div>
                        )
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void onCreateDrafts()} disabled={convert.isPending}>
              Create {draftGroups.length} draft{draftGroups.length === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | null;
  tone?: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-3">
      <span className="text-xs text-slate-500">{label}</span>
      <span className={`text-lg font-semibold ${tone ?? ""}`}>
        {value ?? "—"}
      </span>
    </div>
  );
}
