import { useState } from "react";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
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
import { EmptyState } from "@/components/common/EmptyState";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { usePermissions } from "@/hooks/usePermissions";
import { usePriceHistory } from "../hooks/usePricing";

/**
 * Price change history (Phase 2 endpoint, Phase 7 UI): every materialized
 * change to an effective selling price — who, when, from what, to what, at
 * which cost, and through which source. Never edited, never deleted.
 */
export function PriceHistoryPage() {
  const { hasPermission } = usePermissions();
  const canSeeCost = hasPermission("products.view_cost");
  const [variantId, setVariantId] = useState("");
  const [page, setPage] = useState(1);

  const historyQuery = usePriceHistory({
    variantId: variantId === "" ? undefined : Number(variantId),
    page,
    pageSize: 25,
  });

  const meta = historyQuery.data?.meta;
  const rows = historyQuery.data?.rows ?? [];

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Price history"
        description="Every applied change to a selling price — rules, bulk updates, approved proposals, auto-update sweeps and imports. Sale snapshots and reports are never rewritten."
      />
      <Card>
        <CardContent className="space-y-3">
          <Input
            type="number"
            min="1"
            className="w-56"
            placeholder="Filter by variant id"
            aria-label="Filter by variant id"
            value={variantId}
            onChange={(e) => {
              setVariantId(e.target.value);
              setPage(1);
            }}
          />
          {historyQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Variant</TableHead>
                    <TableHead className="text-right">Change</TableHead>
                    <TableHead>Source</TableHead>
                    {canSeeCost && <TableHead className="text-right">Cost at change</TableHead>}
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={canSeeCost ? 6 : 5}>
                        <EmptyState
                          icon={History}
                          title="No price changes recorded yet"
                          description="Applied price changes are recorded here automatically."
                        />
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {formatDateTime(row.createdAt)}
                        </TableCell>
                        <TableCell>
                          <div className="font-medium">{row.productName}</div>
                          {row.sku && <div className="text-xs text-muted-foreground">{row.sku}</div>}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {row.oldPrice != null ? `${formatCurrency(row.oldPrice)} → ` : ""}
                          <span className="font-semibold">{formatCurrency(row.newPrice)}</span>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{row.source}</Badge>
                        </TableCell>
                        {canSeeCost && (
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {row.costAtChange != null ? formatCurrency(row.costAtChange) : "—"}
                          </TableCell>
                        )}
                        <TableCell className="max-w-72 truncate text-xs text-muted-foreground">
                          {row.reason ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
          {meta && meta.totalPages > 1 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Page {meta.page} of {meta.totalPages} · {meta.total} entries
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= meta.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
