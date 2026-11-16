import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox";
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
import { StatusBadge } from "@/components/common/StatusBadge";
import { formatCurrency } from "@/lib/format";
import { usePermissions } from "@/hooks/usePermissions";
import { toast } from "@/components/ui/toast";
import { extractApiError } from "../components/RuleDialog";
import { useBulkUpdate } from "../hooks/usePricing";
import { useProductSelectOptionsQuery } from "@/features/products/hooks/useProductOptions";
import { useProductsQuery } from "@/features/products/hooks/useProducts";
import type { BulkRow } from "../pricing.types";

interface CatalogOption {
  id: number;
  label: string;
}

interface BulkFilters {
  variantIds?: number[];
  categoryIds?: number[];
  productIds?: number[];
  search?: string;
}

/**
 * Bulk price update wizard (Phase 8): filter the catalog, preview every
 * recommendation (with per-row blocked reasons — cost-unavailable rows are
 * never priced from nothing), then apply. Every applied write lands in the
 * price history with source 'bulk'.
 */
export function BulkUpdatePage() {
  const { hasPermission } = usePermissions();
  const canSeeCost = hasPermission("products.view_cost");
  const bulk = useBulkUpdate();
  const productsQuery = useProductsQuery();
  const categoriesQuery = useProductSelectOptionsQuery();
  const products = productsQuery.data ?? [];
  const categories = categoriesQuery.data?.categories ?? [];

  const [variantIds, setVariantIds] = useState<number[]>([]);
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [productIds, setProductIds] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<BulkRow[]>([]);
  const [previewFilters, setPreviewFilters] = useState<BulkFilters | null>(null);
  const [applying, setApplying] = useState(false);

  const categoryOptions = useMemo(
    () => categories.map((category) => ({ id: category.value, label: category.label })),
    [categories],
  );
  const productOptions = useMemo(
    () => products.map((product) => ({ id: product.id, label: product.name })),
    [products],
  );
  const variantOptions = useMemo(
    () =>
      products.flatMap((product) =>
        product.variants.flatMap((variant) =>
          typeof variant.id === "number"
            ? [
                {
                  id: variant.id,
                label: [
                  product.name,
                  variant.options?.map((option) => option.value).join(", "),
                  variant.sku,
                ]
                  .filter(Boolean)
                  .join(" - "),
                },
              ]
            : [],
        ),
      ),
    [products],
  );

  function buildFilters(): BulkFilters {
    return {
      ...(variantIds.length ? { variantIds } : {}),
      ...(categoryIds.length ? { categoryIds } : {}),
      ...(productIds.length ? { productIds } : {}),
      ...(search.trim() ? { search: search.trim() } : {}),
    };
  }

  function clearPreview() {
    setPreview([]);
    setPreviewFilters(null);
  }

  function updateFilter(update: () => void) {
    update();
    clearPreview();
  }

  async function runPreview() {
    const filters = buildFilters();
    if (!Object.values(filters).some((value) => value !== undefined)) {
      toast.add({
        type: "error",
        description: "Choose at least one category, product, variant, or name filter.",
      });
      return;
    }

    try {
      const result = await bulk.mutateAsync({ ...filters, dryRun: true });
      setPreview(result.rows);
      setPreviewFilters(filters);
      toast.add({
        type: "success",
        description: `${result.rows.filter((r) => r.changed && !r.blockedReason).length} of ${result.rows.length} variants would change.`,
      });
    } catch (err) {
      toast.add({
        type: "error",
        description: extractApiError(err, "Preview failed."),
        priority: "high",
      });
    }
  }

  async function apply() {
    if (!previewFilters) return;
    if (!window.confirm(`Apply the recommended prices to ${preview.filter((r) => r.changed && !r.blockedReason).length} variant(s)?`)) {
      return;
    }
    setApplying(true);
    try {
      const result = await bulk.mutateAsync({
        ...previewFilters,
        dryRun: false,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setPreview(result.rows);
      toast.add({
        type: "success",
        description: `${result.appliedCount} price(s) applied — see the Price History page for the audit trail.`,
      });
    } catch (err) {
      toast.add({
        type: "error",
        description: extractApiError(err, "Apply failed."),
        priority: "high",
      });
    } finally {
      setApplying(false);
    }
  }

  const changedCount = preview.filter((r) => r.changed && !r.blockedReason).length;
  const catalogError = productsQuery.error ?? categoriesQuery.error;
  const catalogLoading = productsQuery.isPending || categoriesQuery.isPending;
  const selectorsDisabled = catalogLoading || bulk.isPending || applying;
  const hasFilters =
    categoryIds.length > 0 ||
    productIds.length > 0 ||
    variantIds.length > 0 ||
    search.trim().length > 0;

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Bulk price update"
        description="Recomputes every filtered variant from its effective pricing rule and current cost. Preview first — nothing is written until you apply."
      />
      <Card>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">Choose what to update</p>
            <p className="text-xs text-muted-foreground">
              Multiple choices in one picker match any of those items; filters
              across pickers and name search narrow the results together.
              Choose at least one filter. Preview is limited to 500 matching
              variants.
            </p>
          </div>
          {catalogError && (
            <p role="alert" className="text-sm text-destructive">
              {catalogError instanceof Error
                ? `Could not load product and category options: ${catalogError.message} You can still search by product name.`
                : "Could not load product and category options. You can still search by product name."}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <CatalogMultiSelect
              label="Categories"
              placeholder="Search categories..."
              emptyMessage="No categories found."
              options={categoryOptions}
              selectedIds={categoryIds}
              onChange={(ids) => updateFilter(() => setCategoryIds(ids))}
              disabled={selectorsDisabled}
              maxSelections={100}
            />
            <CatalogMultiSelect
              label="Products"
              placeholder="Search products..."
              emptyMessage="No products found."
              options={productOptions}
              selectedIds={productIds}
              onChange={(ids) => updateFilter(() => setProductIds(ids))}
              disabled={selectorsDisabled}
              maxSelections={500}
            />
            <CatalogMultiSelect
              label="Variants"
              placeholder="Search product or SKU..."
              emptyMessage="No variants found."
              options={variantOptions}
              selectedIds={variantIds}
              onChange={(ids) => updateFilter(() => setVariantIds(ids))}
              disabled={selectorsDisabled}
              maxSelections={500}
            />
            <div className="space-y-1.5">
              <Label htmlFor="bulk-search">Product name contains (optional)</Label>
              <Input
                id="bulk-search"
                placeholder="e.g. soap"
                value={search}
                disabled={selectorsDisabled}
                onChange={(e) => updateFilter(() => setSearch(e.target.value))}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="bulk-reason">Reason (recorded in the price history)</Label>
              <Input
                id="bulk-reason"
                placeholder="e.g. supplier price increase, March list"
                value={reason}
                disabled={selectorsDisabled}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={() => void runPreview()}
              disabled={
                bulk.isPending || applying || catalogLoading || !hasFilters
              }
            >
              Preview
            </Button>
            <Button
              disabled={
                applying ||
                previewFilters === null ||
                preview.length === 0 ||
                changedCount === 0
              }
              onClick={() => void apply()}
            >
              Apply {changedCount > 0 ? `(${changedCount})` : ""}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={
                selectorsDisabled ||
                (categoryIds.length === 0 &&
                  productIds.length === 0 &&
                  variantIds.length === 0 &&
                  search.length === 0)
              }
              onClick={() => {
                setCategoryIds([]);
                setProductIds([]);
                setVariantIds([]);
                setSearch("");
                clearPreview();
              }}
            >
              Clear filters
            </Button>
          </div>

          {preview.length > 0 && (
            <div className="overflow-hidden rounded-md border">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Source</TableHead>
                    {canSeeCost && <TableHead className="text-right">Cost</TableHead>}
                    <TableHead className="text-right">Current → recommended</TableHead>
                    <TableHead>Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.map((row) => (
                    <TableRow key={row.variantId}>
                      <TableCell>
                        <div className="font-medium">{row.variantName}</div>
                        {row.sku && <div className="text-xs text-muted-foreground">{row.sku}</div>}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{row.sourceLabel}</TableCell>
                      {canSeeCost && (
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {row.cost != null ? formatCurrency(row.cost) : "—"}
                        </TableCell>
                      )}
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatCurrency(row.currentPrice)} →{" "}
                        <span className="font-semibold">
                          {row.recommended != null ? formatCurrency(row.recommended) : "—"}
                        </span>
                      </TableCell>
                      <TableCell>
                        {row.blockedReason ? (
                          <StatusBadge tone="danger">{row.blockedReason}</StatusBadge>
                        ) : row.applied ? (
                          <StatusBadge tone="success">Applied</StatusBadge>
                        ) : row.changed ? (
                          <StatusBadge tone="info">Ready</StatusBadge>
                        ) : (
                          <StatusBadge tone="neutral">Unchanged</StatusBadge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}

function CatalogMultiSelect({
  label,
  placeholder,
  emptyMessage,
  options,
  selectedIds,
  onChange,
  disabled,
  maxSelections,
}: {
  label: string;
  placeholder: string;
  emptyMessage: string;
  options: CatalogOption[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
  disabled: boolean;
  maxSelections: number;
}) {
  const anchor = useComboboxAnchor();
  const selectedOptions = options.filter((option) =>
    selectedIds.includes(option.id),
  );

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Combobox
        multiple
        autoHighlight
        disabled={disabled}
        items={options}
        value={selectedOptions}
        onValueChange={(selected: CatalogOption[]) =>
          onChange(selected.map((option) => option.id))
        }
        itemToStringValue={(option) => option.label}
      >
        <ComboboxChips ref={anchor} className="w-full bg-background">
          <ComboboxValue>
            {(values: CatalogOption[]) => (
              <>
                {values.map((option) => (
                  <ComboboxChip key={option.id}>{option.label}</ComboboxChip>
                ))}
                <ComboboxChipsInput
                  aria-label={label}
                  placeholder={values.length > 0 ? "Add another..." : placeholder}
                />
              </>
            )}
          </ComboboxValue>
        </ComboboxChips>
        <ComboboxContent anchor={anchor}>
          <ComboboxEmpty>{emptyMessage}</ComboboxEmpty>
          <ComboboxList>
            {(option) => (
              <ComboboxItem
                key={option.id}
                value={option}
                disabled={
                  selectedIds.length >= maxSelections &&
                  !selectedIds.includes(option.id)
                }
              >
                {option.label}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <p className="text-xs text-muted-foreground">
        {selectedIds.length} selected
      </p>
    </div>
  );
}
