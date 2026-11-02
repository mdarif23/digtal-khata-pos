import { createColumnHelper } from "@tanstack/react-table";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Package, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { DataTableColumnHeader } from "./data-table-column-header";
import { type DataTableFeatures } from "./data-table-features";
import { ProductType } from "@/features/products/product.schema";
import { getProductStockState } from "../../../utils/getProductStockState";
import axios from "../../../../../api/axios";
import { ViewSerialsDialog } from "./data-table";
import { hasPermission } from "@/auth/sessionStore";

const columnHelper = createColumnHelper<DataTableFeatures, ProductType>();
const currencyFormatter = new Intl.NumberFormat("en-BD", {
  style: "currency",
  currency: "BDT",
  maximumFractionDigits: 0,
});

function formatPriceRange(prices: number[]) {
  if (prices.length === 0) return "—";
  const minimum = Math.min(...prices);
  const maximum = Math.max(...prices);
  return minimum === maximum
    ? currencyFormatter.format(minimum)
    : `${currencyFormatter.format(minimum)} – ${currencyFormatter.format(maximum)}`;
}

export const columns = columnHelper.columns([
  columnHelper.display({
    id: "select",
    header: ({ table }) => (
      <Checkbox
        checked={table.getIsAllPageRowsSelected()}
        indeterminate={
          table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected()
        }
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        aria-label="Select all products on this page"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
        aria-label={`Select ${row.original.name}`}
      />
    ),
    enableSorting: false,
    enableHiding: false,
  }),
  columnHelper.accessor("name", {
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Product" />
    ),
    cell: ({ row }) => (
      <div className="flex items-center gap-3">
        {row.original.imageUrl ? (
          <img
            className="size-10 shrink-0 rounded-md border object-cover"
            src={row.original.imageUrl}
            alt=""
          />
        ) : (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Package className="size-5" aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0">
          <div className="truncate font-medium">{row.original.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {row.original.hasVariants
              ? `${row.original.variants.length} variants`
              : (row.original.variants[0]?.sku ?? "—")}
          </div>
        </div>
      </div>
    ),
  }),
  columnHelper.accessor("variants", {
    id: "stock",
    header: () => <div>Inventory</div>,
    cell: ({ row }) => {
      const [available, setAvailable] = useState<string[]>([]);
      const [error, setError] = useState("");
      const product = row.original;
      const variantId = product.variants[0]?.id;

      useEffect(() => {
        if (product.hasVariants && product.trackingType !== "serial") return;
        if (variantId === undefined) return;
        setError("");
        axios
          .get(`variants/${variantId}/serials`)
          .then((res) => setAvailable(res.data))
          .catch(() => setError("Could not load serial numbers"));
      }, [product.hasVariants, product.trackingType, variantId]);

      const totalQuantity = product.variants.reduce(
        (total, variant) => total + variant.quantity,
        0,
      );
      const stockState = getProductStockState(product);
      const stockLabel = {
        "in-stock": "In stock",
        "low-stock": "Low stock",
        "out-of-stock": "Out of stock",
      }[stockState];
      const stockTone = {
        "in-stock": "border-emerald-200 bg-emerald-50 text-emerald-700",
        "low-stock": "border-amber-200 bg-amber-50 text-amber-700",
        "out-of-stock": "border-rose-200 bg-rose-50 text-rose-700",
      }[stockState];

      return (
        <div className="flex flex-col items-start gap-1">
          <Badge variant="outline" className={stockTone}>
            {stockLabel}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {totalQuantity.toLocaleString()} units
            {!product.hasVariants &&
            product.trackingType === "serial" &&
            variantId !== undefined ? (
              <>
                {" · "}
                {error ? (
                  <span title={error}>Serials unavailable</span>
                ) : (
                  <ViewSerialsDialog
                    available={available}
                    variantId={variantId}
                  />
                )}
              </>
            ) : null}
          </span>
        </div>
      );
    },
  }),
  // Purchase cost is permission-gated (products.view_cost) and already
  // stripped server-side; the column is simply not registered without it.
  ...(hasPermission("products.view_cost")
    ? [
        columnHelper.accessor("variants", {
          id: "cost",
          header: () => <div className="text-right">Cost</div>,
          cell: ({ row }) => (
            <div className="text-right font-medium">
              {formatPriceRange(
                row.original.variants.map(
                  (variant) =>
                    variant.purchaseCost ?? variant.purchasePrice ?? 0,
                ),
              )}
            </div>
          ),
        }),
      ]
    : []),
  columnHelper.accessor("variants", {
    id: "price",
    header: () => <div className="text-right">Price</div>,
    cell: ({ row }) => (
      <div className="text-right font-medium">
        {formatPriceRange(
          row.original.variants.map((variant) => variant.sellingPrice),
        )}
      </div>
    ),
  }),
  columnHelper.display({
    id: "actions",
    header: () => <div className="text-right">Edit</div>,
    cell: ({ row }) => (
      <div className="flex justify-end">
        <Button
          nativeButton={false}
          variant="ghost"
          size="icon-sm"
          aria-label={`Edit ${row.original.name}`}
          render={<Link to={`/product/${row.original.id}/edit`} />}
        >
          <Pencil aria-hidden="true" />
        </Button>
      </div>
    ),
  }),
]);
