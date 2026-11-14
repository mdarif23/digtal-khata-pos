import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
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
import type { BulkRow } from "../pricing.types";

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

  const [variantIds, setVariantIds] = useState("");
  const [categoryIds, setCategoryIds] = useState("");
  const [productIds, setProductIds] = useState("");
  const [search, setSearch] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<BulkRow[]>([]);
  const [applying, setApplying] = useState(false);

  function parseIds(raw: string): number[] {
    return raw
      .split(/[\s,;]+/)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0);
  }

  function buildPayload(dryRun: boolean) {
    return {
      dryRun,
      ...(parseIds(variantIds).length ? { variantIds: parseIds(variantIds) } : {}),
      ...(parseIds(categoryIds).length ? { categoryIds: parseIds(categoryIds) } : {}),
      ...(parseIds(productIds).length ? { productIds: parseIds(productIds) } : {}),
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    };
  }

  async function runPreview() {
    try {
      const result = await bulk.mutateAsync(buildPayload(true));
      setPreview(result.rows);
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
    if (!window.confirm(`Apply the recommended prices to ${preview.filter((r) => r.changed && !r.blockedReason).length} variant(s)?`)) {
      return;
    }
    setApplying(true);
    try {
      const result = await bulk.mutateAsync(buildPayload(false));
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

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Bulk price update"
        description="Recomputes every filtered variant from its effective pricing rule and current cost. Preview first — nothing is written until you apply."
      />
      <Card>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="bulk-variants">Variant ids</Label>
              <Input
                id="bulk-variants"
                placeholder="e.g. 12, 13, 14"
                value={variantIds}
                onChange={(e) => setVariantIds(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bulk-categories">Category ids</Label>
              <Input
                id="bulk-categories"
                placeholder="e.g. 3"
                value={categoryIds}
                onChange={(e) => setCategoryIds(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bulk-products">Product ids</Label>
              <Input
                id="bulk-products"
                placeholder="e.g. 8"
                value={productIds}
                onChange={(e) => setProductIds(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bulk-search">Product name contains</Label>
              <Input
                id="bulk-search"
                placeholder="e.g. soap"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="bulk-reason">Reason (recorded in the price history)</Label>
              <Input
                id="bulk-reason"
                placeholder="e.g. supplier price increase, March list"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => void runPreview()} disabled={bulk.isPending}>
              Preview
            </Button>
            <Button
              disabled={applying || preview.length === 0 || changedCount === 0}
              onClick={() => void apply()}
            >
              Apply {changedCount > 0 ? `(${changedCount})` : ""}
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
