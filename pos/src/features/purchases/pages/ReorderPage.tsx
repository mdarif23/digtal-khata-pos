import { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { Badge } from "@/components/ui/badge.js";
import { toast } from "@/components/ui/toast.js";
import axios from "../../../api/axios.js";

/**
 * Automated replenishment (Module 2C): suggestions derive from stock +
 * outstanding purchases vs the per-variant reorder point, so in-flight
 * orders are never double-ordered. One click converts selections into a
 * draft purchase order (prices prefilled from purchase history).
 */

interface Suggestion {
  variantId: number;
  productId: number;
  productName: string;
  sku: string | null;
  currentStock: number;
  outstandingOnOrder: number;
  reorderPoint: number;
  suggestedQuantity: number;
  lastSupplierId: number | null;
  lastSupplierName: string | null;
  lastUnitCost: number | null;
}

const tk = (n: number) => `৳${n.toFixed(2)}`;

export function ReorderPage() {
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [selected, setSelected] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [pointDrafts, setPointDrafts] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await axios.get<{ data: Suggestion[] }>("/reorder-suggestions");
      setSuggestions(res.data.data);
      setSelected({});
    } catch {
      toast.add({ type: "error", description: "Could not load suggestions." });
      setSuggestions([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function setPoint(suggestion: Suggestion) {
    const raw = pointDrafts[suggestion.variantId];
    const point = Number(raw);
    if (!Number.isInteger(point) || point < 0) {
      toast.add({ type: "error", description: "Enter a non-negative integer." });
      return;
    }
    setBusy(true);
    try {
      await axios.patch(`/variants/${suggestion.variantId}/reorder-config`, {
        reorderPoint: point,
        reorderQuantity: null,
      });
      toast.add({ type: "success", description: "Reorder point updated." });
      await load();
    } catch (err) {
      toast.add({
        type: "error",
        description:
          err instanceof Error ? err.message : "Could not update the config.",
        priority: "high",
      });
    } finally {
      setBusy(false);
    }
  }

  async function convert() {
    const items = Object.entries(selected).map(([variantId, qty]) => ({
      variantId: Number(variantId),
      quantity: Number(qty) || undefined,
    }));
    if (items.length === 0) {
      toast.add({ type: "error", description: "Select at least one item." });
      return;
    }
    setBusy(true);
    try {
      const res = await axios.post<{ data: { purchaseOrderNumber: string } }>(
        "/reorder-suggestions/convert",
        {
          supplierId: null,
          items,
          note: "Created from reorder suggestions",
        },
      );
      toast.add({
        type: "success",
        description: `Purchase order ${res.data.data.purchaseOrderNumber} created.`,
        priority: "high",
      });
      await load();
    } catch (err) {
      toast.add({
        type: "error",
        description:
          err instanceof Error
            ? err.message
            : "Could not create the purchase order.",
        priority: "high",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle>Reorder suggestions</CardTitle>
            <CardDescription>
              Variants whose available stock (current + already on order) has
              reached their reorder point. Convert selections into a purchase
              order — prices prefill from purchase history.
            </CardDescription>
          </div>
          <Button
            disabled={
              busy || !suggestions || Object.keys(selected).length === 0
            }
            onClick={() => void convert()}
          >
            Create purchase order
          </Button>
        </CardHeader>
        <CardContent>
          {suggestions === null ? (
            <Skeleton className="h-32 w-full" />
          ) : suggestions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing to reorder. Set reorder points on products (Products →
              the % icon manages tax; reorder points are set here) — variants
              at or below their point appear here automatically.
            </p>
          ) : (
            <div className="overflow-hidden rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="p-2 font-medium">Order</th>
                    <th className="p-2 font-medium">Product</th>
                    <th className="p-2 text-right font-medium">Stock</th>
                    <th className="p-2 text-right font-medium">On order</th>
                    <th className="p-2 text-right font-medium">Point</th>
                    <th className="p-2 text-right font-medium">Suggested</th>
                    <th className="p-2 font-medium">Last supplier</th>
                    <th className="p-2 text-right font-medium">New point</th>
                  </tr>
                </thead>
                <tbody>
                  {suggestions.map((s) => (
                    <tr key={s.variantId} className="border-t">
                      <td className="p-2">
                        <input
                          type="checkbox"
                          checked={s.variantId in selected}
                          onChange={(e) =>
                            setSelected((current) => {
                              const next = { ...current };
                              if (e.target.checked) {
                                next[s.variantId] = String(s.suggestedQuantity);
                              } else {
                                delete next[s.variantId];
                              }
                              return next;
                            })
                          }
                        />
                      </td>
                      <td className="p-2">
                        {s.productName}
                        {s.sku && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            {s.sku}
                          </span>
                        )}
                      </td>
                      <td className="p-2 text-right font-mono">
                        {s.currentStock}
                      </td>
                      <td className="p-2 text-right font-mono">
                        {s.outstandingOnOrder}
                      </td>
                      <td className="p-2 text-right font-mono">
                        {s.reorderPoint}
                      </td>
                      <td className="p-2 text-right">
                        {s.variantId in selected ? (
                          <Input
                            type="number"
                            min={1}
                            className="ml-auto h-8 w-20 text-right"
                            value={selected[s.variantId]}
                            onChange={(e) =>
                              setSelected((current) => ({
                                ...current,
                                [s.variantId]: e.target.value,
                              }))
                            }
                          />
                        ) : (
                          <span className="font-mono font-medium">
                            {s.suggestedQuantity}
                          </span>
                        )}
                      </td>
                      <td className="p-2">
                        {s.lastSupplierName ? (
                          <Badge variant="outline">{s.lastSupplierName}</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                        {s.lastUnitCost !== null && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            {tk(s.lastUnitCost)}
                          </span>
                        )}
                      </td>
                      <td className="p-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Input
                            type="number"
                            min={0}
                            className="h-8 w-20 text-right"
                            placeholder={String(s.reorderPoint)}
                            value={pointDrafts[s.variantId] ?? ""}
                            onChange={(e) =>
                              setPointDrafts((c) => ({
                                ...c,
                                [s.variantId]: e.target.value,
                              }))
                            }
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy || !pointDrafts[s.variantId]}
                            onClick={() => void setPoint(s)}
                          >
                            Set
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
