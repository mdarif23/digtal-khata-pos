import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { Badge } from "@/components/ui/badge.js";
import { Percent } from "lucide-react";
import axios from "@/api/axios";
import { usePermissions } from "@/hooks/usePermissions";

interface TaxRateSummary {
  taxRateId: number;
  name: string;
  rate: number;
  isInclusive: boolean;
  isActive: boolean;
}

/**
 * Per-product tax assignment (Module 4): choose which active tax rates
 * apply to the product. Unassigned products are tax-exempt under the rules
 * engine. Self-contained cell component for the products table.
 */
export function ProductTaxCell({
  productId,
  productName,
}: {
  productId: number;
  productName: string;
}) {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("taxes.manage");
  const [open, setOpen] = useState(false);
  const [rates, setRates] = useState<TaxRateSummary[] | null>(null);
  const [assigned, setAssigned] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setRates(null);
    try {
      const [allRes, assignedRes] = await Promise.all([
        axios.get<{ data: TaxRateSummary[] }>("/tax-rates"),
        axios.get<{ data: TaxRateSummary[] }>(
          `/products/${productId}/tax-rates`,
        ),
      ]);
      setRates(allRes.data.data.filter((r) => r.isActive));
      setAssigned(assignedRes.data.data.map((r) => r.taxRateId));
    } catch {
      toast.add({
        type: "error",
        description: "Could not load tax rates.",
        priority: "high",
      });
      setRates([]);
    }
  }, [productId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function save() {
    setBusy(true);
    try {
      await axios.put(`/products/${productId}/tax-rates`, {
        taxRateIds: assigned,
      });
      toast.add({
        type: "success",
        description: `Tax rates updated for ${productName}.`,
      });
      setOpen(false);
    } catch (err) {
      toast.add({
        type: "error",
        description:
          err instanceof Error ? err.message : "Could not update tax rates.",
        priority: "high",
      });
    } finally {
      setBusy(false);
    }
  }

  if (!canManage) return null;

  return (
    <>
      <Button
        nativeButton={false}
        variant="ghost"
        size="icon-sm"
        aria-label={`Tax rates for ${productName}`}
        onClick={() => setOpen(true)}
      >
        <Percent aria-hidden="true" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Product taxes — {productName}</DialogTitle>
            <DialogDescription>
              Assigned rates apply at sale time and are snapshotted onto each
              invoice. Unassigned products are tax-exempt.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-60 space-y-1 overflow-y-auto">
            {rates === null && (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
            {rates !== null && rates.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No active tax rates — create one under Tax Rates first.
              </p>
            )}
            {rates?.map((rate) => (
              <label
                key={rate.taxRateId}
                className="flex cursor-pointer items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={assigned.includes(rate.taxRateId)}
                  onChange={(e) =>
                    setAssigned((current) =>
                      e.target.checked
                        ? [...current, rate.taxRateId]
                        : current.filter((id) => id !== rate.taxRateId),
                    )
                  }
                />
                <span className="flex-1">{rate.name}</span>
                <span className="font-mono">{rate.rate}%</span>
                <Badge variant="outline">
                  {rate.isInclusive ? "incl" : "excl"}
                </Badge>
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || rates === null} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
