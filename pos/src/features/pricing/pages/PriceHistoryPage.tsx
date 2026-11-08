import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { usePermissions } from "@/hooks/usePermissions";
import { usePriceHistory } from "../hooks/usePricing";

const tk = (n: number) => `৳${n.toFixed(2)}`;

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

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Price history</CardTitle>
            <CardDescription>
              Every applied change to a selling price — rules, bulk updates,
              approved proposals, auto-update sweeps and imports. Sale snapshots
              and reports are never rewritten.
            </CardDescription>
          </div>
          <div className="w-56 space-y-1.5">
            <Input
              type="number"
              min="1"
              placeholder="Filter by variant id"
              value={variantId}
              onChange={(e) => {
                setVariantId(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </CardHeader>
        <CardContent>
          {historyQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (historyQuery.data?.rows.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">
              No price changes recorded yet.
            </p>
          ) : (
            <div className="overflow-hidden rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="p-2 font-medium">When</th>
                    <th className="p-2 font-medium">Variant</th>
                    <th className="p-2 font-medium">Change</th>
                    <th className="p-2 font-medium">Source</th>
                    {canSeeCost && <th className="p-2 font-medium">Cost at change</th>}
                    <th className="p-2 font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {(historyQuery.data?.rows ?? []).map((row) => (
                    <tr key={row.id} className="border-t">
                      <td className="p-2 whitespace-nowrap text-xs text-muted-foreground">
                        {new Date(row.createdAt).toLocaleString()}
                      </td>
                      <td className="p-2">
                        <div className="font-medium">{row.productName}</div>
                        {row.sku && <div className="text-xs text-muted-foreground">{row.sku}</div>}
                      </td>
                      <td className="p-2 font-mono">
                        {row.oldPrice != null ? `${tk(row.oldPrice)} → ` : ""}
                        <span className="font-semibold">{tk(row.newPrice)}</span>
                      </td>
                      <td className="p-2">
                        <Badge variant="outline">{row.source}</Badge>
                      </td>
                      {canSeeCost && (
                        <td className="p-2 font-mono text-xs">
                          {row.costAtChange != null ? tk(row.costAtChange) : "—"}
                        </td>
                      )}
                      <td className="p-2 max-w-72 truncate text-xs text-muted-foreground">
                        {row.reason ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {meta && meta.totalPages > 1 && (
            <div className="mt-3 flex items-center justify-between text-sm">
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
    </div>
  );
}
