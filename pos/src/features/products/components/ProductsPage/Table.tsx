import { Link } from "react-router";
import {
  AlertTriangle,
  Boxes,
  CircleDollarSign,
  Download,
  Package,
  Plus,
  TrendingUp,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { productExportApi } from "../../import/import.api";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import type { ProductStats } from "../../utils/calculateProductStats";

const currencyFormatter = new Intl.NumberFormat("en-BD", {
  style: "currency",
  currency: "BDT",
  maximumFractionDigits: 0,
});

function ProductStat({
  label,
  value,
  detail,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  icon: typeof Package;
  tone: string;
}) {
  return (
    <Card className="gap-3 shadow-none">
      <CardContent className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>
          {detail && (
            <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
          )}
        </div>
        <span className={`rounded-lg p-2.5 ${tone}`}>
          <Icon className="size-5" aria-hidden="true" />
        </span>
      </CardContent>
    </Card>
  );
}

export default function ProductOverview({
  stats,
  onExport,
}: {
  stats: ProductStats;
  onExport: () => void;
}) {
  return (
    <section className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your catalog, pricing, and inventory in one place.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={onExport}>
            <Download aria-hidden="true" />
            Export CSV
          </Button>
          <Button
            variant="outline"
            nativeButton={false}
            render={
              <a href="/product/import" />
            }
          >
            <Upload aria-hidden="true" />
            Import
          </Button>
          <a
            className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-input bg-background px-4 py-2 text-sm font-medium shadow-sm hover:bg-accent"
            href={productExportApi.url("xlsx", {})}
          >
            <Download aria-hidden="true" />
            Export XLSX
          </a>
          <Button
            nativeButton={false}
            variant="outline"
            render={<Link to="/product/stock-adjustment" />}
          >
            <Boxes aria-hidden="true" />
            Adjust stock
          </Button>
          <Button
            nativeButton={false}
            render={<Link to="/product/addproduct" />}
          >
            <Plus aria-hidden="true" />
            Add product
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <ProductStat
          label="Products"
          value={stats.totalProducts.toLocaleString()}
          detail={`${stats.totalVariants.toLocaleString()} variants`}
          icon={Package}
          tone="bg-primary/10 text-primary"
        />
        <ProductStat
          label="Inventory cost"
          value={currencyFormatter.format(stats.inventoryValue)}
          detail="Current stock at purchase cost"
          icon={CircleDollarSign}
          tone="bg-blue-500/10 text-blue-600"
        />
        <ProductStat
          label="Retail value"
          value={currencyFormatter.format(stats.retailValue)}
          detail="Potential sales value"
          icon={TrendingUp}
          tone="bg-emerald-500/10 text-emerald-600"
        />
        <ProductStat
          label="Potential margin"
          value={currencyFormatter.format(stats.potentialMargin)}
          detail="Retail value less inventory cost"
          icon={CircleDollarSign}
          tone="bg-violet-500/10 text-violet-600"
        />
        <ProductStat
          label="Low-stock variants"
          value={stats.lowStockCount.toLocaleString()}
          detail="At or below alert quantity"
          icon={AlertTriangle}
          tone="bg-amber-500/10 text-amber-600"
        />
        <ProductStat
          label="Out-of-stock variants"
          value={stats.outOfStockCount.toLocaleString()}
          detail="Inventory needs replenishing"
          icon={Boxes}
          tone="bg-rose-500/10 text-rose-600"
        />
      </div>
    </section>
  );
}
