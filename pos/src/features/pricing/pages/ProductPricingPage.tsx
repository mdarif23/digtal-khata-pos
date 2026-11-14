import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PackageSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageContainer } from "@/components/common/PageContainer";
import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { formatCurrency } from "@/lib/format";
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
            label: `${p.name}${v.sku ? ` — ${v.sku}` : ""} (${formatCurrency(v.sellingPrice)})`,
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
          description: `Price applied: ${formatCurrency(result.oldPrice)} → ${formatCurrency(Number(result.newPrice))} (recorded in price history).`,
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
    <PageContainer width="wide">
      <PageHeader
        title="Product pricing"
        description="Effective selling price and its inheritance source per variant. Applying a recommendation is the audited write to the effective price; overrides ride the variant › product › category › global › default precedence."
      />
      <Card>
        <CardContent className="space-y-3">
          <Input
            className="w-56"
            placeholder="Search product or SKU…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
          {previewQuery.isLoading || previewQuery.isFetching ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border">
              <Table className="min-w-[860px]">
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Variant</TableHead>
                    <TableHead className="text-right">Current price</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Rule</TableHead>
                    {canViewCost && <TableHead className="text-right">Cost</TableHead>}
                    <TableHead className="text-right">Recommended</TableHead>
                    <TableHead className="text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={canViewCost ? 7 : 6}>
                        <EmptyState
                          icon={PackageSearch}
                          title="No products match"
                          description="Try a different product name or SKU."
                        />
                      </TableCell>
                    </TableRow>
                  ) : (
                    pageRows.map((catalogRow) => {
                      const row = previewsById.get(catalogRow.variantId);
                      const isVariantOverride = row?.source.kind === "variant_rule";
                      return (
                        <TableRow key={catalogRow.variantId}>
                          <TableCell>
                            <p className="font-medium">{catalogRow.label}</p>
                            <p className="text-xs text-muted-foreground">{catalogRow.sku}</p>
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {formatCurrency(catalogRow.sellingPrice)}
                          </TableCell>
                          <TableCell>
                            <Badge variant={isVariantOverride ? "default" : "outline"}>
                              {row ? (SOURCE_LABELS[row.source.kind] ?? row.source.label) : "…"}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs tabular-nums">
                            {row?.method === "fixed"
                              ? `Fixed ${row.fixedPrice != null ? formatCurrency(row.fixedPrice) : "—"}`
                              : row
                                ? `${row.method === "markup" ? "Markup" : "Margin"} ${row.percentage ?? "—"}%`
                                : "—"}
                          </TableCell>
                          {canViewCost && (
                            <TableCell className="text-right font-mono tabular-nums">
                              {row?.costStatus === "available" && row?.cost != null
                                ? formatCurrency(row.cost)
                                : row?.costStatus === "unavailable"
                                  ? "n/a"
                                  : "—"}
                            </TableCell>
                          )}
                          <TableCell className="text-right">
                            <span className="font-mono tabular-nums">
                              {row?.recommendedPrice != null
                                ? formatCurrency(row.recommendedPrice)
                                : "—"}
                            </span>
                            {(row?.minimumViolations ?? []).map((v) => (
                              <Badge key={v} variant="destructive" className="ml-1.5">
                                {v === "minimum_price" ? "below min" : "below margin floor"}
                              </Badge>
                            ))}
                          </TableCell>
                          <TableCell className="text-right">
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
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
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
    </PageContainer>
  );
}
