import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { usePermissions } from "@/hooks/usePermissions";
import { toast } from "@/components/ui/toast";
import axios from "@/api/axios";
import { pricingKeys, useDeleteRule } from "../hooks/usePricing";
import { previewPricingApi, applyPriceApi } from "../pricing.api";
import {
  extractApiError,
  RuleDialog,
  type RuleDialogVariant,
} from "../components/RuleDialog";
import type { PricingPreviewRow } from "../pricing.types";

const PAGE_SIZE = 25;

const tk = (n: number | null | undefined) =>
  n == null ? "—" : `৳${Number(n).toFixed(2)}`;

interface ProductsListItem {
  id: number;
  name: string;
  variants: {
    id: number;
    sku: string;
    sellingPrice: number;
    quantity: number | null;
    purchaseCost?: number;
    isDefault?: boolean;
    status?: string;
  }[];
}

const SOURCE_LABELS: Record<string, string> = {
  variant_rule: "Variant override",
  product_rule: "Product rule",
  category_rule: "Category rule",
  global_rule: "Global rule",
  settings_default: "Business default",
  request_override: "What-if",
};

/**
 * Product & variant pricing matrix: effective price, where it comes from
 * (inheritance source), the rule-based recommendation, cost (permission
 * gated) and the APPLY action — the one audited write to the selling price.
 */
export function ProductPricingPage() {
  const { hasPermission } = usePermissions();
  const canManageRules = hasPermission("pricing.manage");
  const canApply = hasPermission("pricing.product.manage");
  const canViewCost = hasPermission("products.view_cost");

  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [overrideVariant, setOverrideVariant] = useState<RuleDialogVariant | null>(null);
  const [categories, setCategories] = useState<{ value: number; label: string }[]>([]);
  const [products, setProducts] = useState<
    { productId: number; label: string; variants: RuleDialogVariant[] }[]
  >([]);
  const [busyVariantId, setBusyVariantId] = useState<number | null>(null);

  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [catalog, setCatalog] = useState<ProductsListItem[]>([]);

  // Catalog for the matrix + the override picker (loaded once).
  async function loadCatalog() {
    try {
      const [productsRes, optionsRes] = await Promise.all([
        axios.get<ProductsListItem[]>("/products"),
        axios.get<{ categories: { value: number; label: string }[] }>(
          "/product/select-options",
        ),
      ]);
      const list = Array.isArray(productsRes.data) ? productsRes.data : [];
      setCatalog(list);
      setCategories(optionsRes.data.categories ?? []);
      setProducts(
        list.map((p) => ({
          productId: p.id,
          label: p.name,
          variants: (p.variants ?? []).map((v) => ({
            variantId: v.id,
            label: `${p.name}${v.sku ? ` — ${v.sku}` : ""} (৳${v.sellingPrice})`,
          })),
        })),
      );
    } catch {
      toast.add({
        type: "error",
        description: "Could not load the product catalog.",
        priority: "high",
      });
    } finally {
      setCatalogLoaded(true);
    }
  }
  if (!catalogLoaded) void loadCatalog();

  const variantRows = useMemo(() => {
    const rows: { variantId: number; label: string; sku: string; sellingPrice: number }[] = [];
    for (const p of catalog) {
      for (const v of p.variants ?? []) {
        if (v.status && v.status !== "active") continue;
        rows.push({ variantId: v.id, label: p.name, sku: v.sku, sellingPrice: Number(v.sellingPrice) });
      }
    }
    return rows;
  }, [catalog]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return variantRows;
    return variantRows.filter(
      (r) => r.label.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q),
    );
  }, [variantRows, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const pageVariantIds = useMemo(
    () => pageRows.map((r) => r.variantId),
    [pageRows],
  );

  const previewQuery = useQuery({
    queryKey: pricingKeys.preview(pageVariantIds),
    queryFn: () => previewPricingApi(pageVariantIds),
    enabled: pageVariantIds.length > 0,
    placeholderData: (prev) => prev,
  });
  const previewsById = useMemo(() => {
    const map = new Map<number, PricingPreviewRow>();
    for (const row of previewQuery.data ?? []) map.set(row.variantId, row);
    return map;
  }, [previewQuery.data]);

  const deleteRule = useDeleteRule();

  async function apply(row: PricingPreviewRow) {
    setBusyVariantId(row.variantId);
    try {
      const result = await applyPriceApi(row.variantId);
      if (result.applied) {
        toast.add({
          type: "success",
          description: `Price applied: ৳${result.oldPrice.toFixed(2)} → ৳${Number(result.newPrice).toFixed(2)} (recorded in price history).`,
        });
      } else {
        toast.add({
          type: "success",
          description: "Already at the recommended price — nothing changed.",
        });
      }
      await previewQuery.refetch();
    } catch (err) {
      toast.add({
        type: "error",
        description: extractApiError(err, "Could not apply the price."),
        priority: "high",
      });
    } finally {
      setBusyVariantId(null);
    }
  }

  async function openOverride(row: PricingPreviewRow) {
    if (!catalogLoaded) await loadCatalog();
    const label =
      row.productName + (row.sku ? ` — ${row.sku}` : "");
    setOverrideVariant({ variantId: row.variantId, label });
    setDialogOpen(true);
  }

  async function clearOverride(row: PricingPreviewRow) {
    if (row.source.kind !== "variant_rule") return;
    setBusyVariantId(row.variantId);
    try {
      await deleteRule.mutateAsync(row.source.ruleId);
      toast.add({
        type: "success",
        description: "Override removed — the variant inherits its rule again.",
      });
      await previewQuery.refetch();
    } catch (err) {
      toast.add({
        type: "error",
        description: extractApiError(err, "Could not remove the override."),
        priority: "high",
      });
    } finally {
      setBusyVariantId(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Product pricing</CardTitle>
            <CardDescription>
              Effective selling price and its inheritance source per variant.
              Applying a recommendation is the audited write to the effective
              price; overrides ride the variant › product › category › global
              › default precedence.
            </CardDescription>
          </div>
          <Input
            className="w-56"
            placeholder="Search product or SKU…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </CardHeader>
        <CardContent className="space-y-3">
          {previewQuery.isLoading || previewQuery.isFetching ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : pageRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No products match.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[860px] text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="p-2 font-medium">Variant</th>
                    <th className="p-2 font-medium">Current price</th>
                    <th className="p-2 font-medium">Source</th>
                    <th className="p-2 font-medium">Rule</th>
                    {canViewCost && <th className="p-2 font-medium">Cost</th>}
                    <th className="p-2 font-medium">Recommended</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((catalogRow) => {
                    const row = previewsById.get(catalogRow.variantId);
                    const isVariantOverride = row?.source.kind === "variant_rule";
                    return (
                      <tr key={catalogRow.variantId} className="border-t align-middle">
                        <td className="p-2">
                          <p className="font-medium">{catalogRow.label}</p>
                          <p className="text-xs text-muted-foreground">{catalogRow.sku}</p>
                        </td>
                        <td className="p-2 font-mono">{tk(catalogRow.sellingPrice)}</td>
                        <td className="p-2">
                          <Badge variant={isVariantOverride ? "default" : "outline"}>
                            {row ? (SOURCE_LABELS[row.source.kind] ?? row.source.label) : "…"}
                          </Badge>
                        </td>
                        <td className="p-2 font-mono text-xs">
                          {row?.method === "fixed"
                            ? `Fixed ${tk(row.fixedPrice)}`
                            : row
                              ? `${row.method === "markup" ? "Markup" : "Margin"} ${row.percentage ?? "—"}%`
                              : "—"}
                        </td>
                        {canViewCost && (
                          <td className="p-2 font-mono">
                            {row?.costStatus === "available"
                              ? tk(row.cost)
                              : row?.costStatus === "unavailable"
                                ? "n/a"
                                : "—"}
                          </td>
                        )}
                        <td className="p-2">
                          <span className="font-mono">{tk(row?.recommendedPrice)}</span>
                          {(row?.minimumViolations ?? []).map((v) => (
                            <Badge key={v} variant="destructive" className="ml-1.5">
                              {v === "minimum_price" ? "below min" : "below margin floor"}
                            </Badge>
                          ))}
                        </td>
                        <td className="p-2 text-right">
                          <div className="flex justify-end gap-1.5">
                            {canApply && row?.recommendedPrice != null && (
                              <Button
                                size="sm"
                                disabled={busyVariantId === row.variantId}
                                onClick={() => void apply(row)}
                              >
                                Apply
                              </Button>
                            )}
                            {canManageRules && row && !isVariantOverride && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void openOverride(row)}
                              >
                                Override
                              </Button>
                            )}
                            {canManageRules && row && isVariantOverride && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busyVariantId === row.variantId}
                                onClick={() => void clearOverride(row)}
                              >
                                Clear override
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {filtered.length} variant{filtered.length === 1 ? "" : "s"}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={safePage <= 1}
                onClick={() => setPage(safePage - 1)}
              >
                Previous
              </Button>
              <span>
                Page {safePage} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={safePage >= totalPages}
                onClick={() => setPage(safePage + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <RuleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialScope="Variant"
        initialVariant={overrideVariant}
        categories={categories}
        products={products}
      />
    </div>
  );
}
