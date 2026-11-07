import { useState } from "react";
import { CircleCheckIcon, PackageX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import {
  usePurchaseDiscrepancies,
  useResolveDiscrepancy,
} from "../../hooks/usePurchaseDiscrepancies";
import type { DiscrepancyResolution } from "../../purchase.types";

/**
 * Open rejection discrepancies (Phase 4) for this purchase, with the
 * supplier settlement workflow. Resolving RECORDS the outcome only —
 * credits and payments are never created automatically.
 */
export function OpenRejectionsPanel({ purchaseId }: { purchaseId: number }) {
  const trail = usePurchaseDiscrepancies(purchaseId);
  const resolve = useResolveDiscrepancy(purchaseId);
  const [resolutionByItem, setResolutionByItem] = useState<
    Record<number, DiscrepancyResolution>
  >({});

  const openRejections = (trail.data?.discrepancies ?? []).filter(
    (entry) => entry.type === "rejection" && entry.status === "open",
  );

  if (trail.isLoading || openRejections.length === 0) return null;

  const submit = async (discrepancyId: number, purchaseItemId: number) => {
    const resolution =
      resolutionByItem[discrepancyId] ?? ("supplier_credit" as const);
    try {
      await resolve.mutateAsync({
        discrepancyId,
        input: { resolution },
      });
      toast.add({
        type: "success",
        description:
          resolution === "supplier_credit"
            ? "Recorded: supplier will credit the rejected goods."
            : "Recorded: supplier will send a replacement.",
      });
    } catch (error) {
      const message =
        (error as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? "Unable to record the resolution.";
      toast.add({ type: "error", description: message, priority: "high" });
    }
  };

  return (
    <section className="rounded-xl border border-rose-200 bg-rose-50/50 p-4 text-sm">
      <div className="flex items-center gap-2">
        <PackageX className="size-4 text-rose-600" />
        <h2 className="font-semibold text-rose-900">
          Open rejections awaiting supplier settlement
        </h2>
      </div>
      <ul className="mt-3 space-y-2">
        {openRejections.map((entry) => (
          <li
            key={entry.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border bg-background p-3"
          >
            <div className="flex-1">
              <p className="font-medium">
                {entry.quantity} unit{entry.quantity === 1 ? "" : "s"} rejected
                {entry.category ? ` — ${entry.category.replace("_", " ")}` : ""}
              </p>
              {entry.reason && (
                <p className="text-xs text-muted-foreground">{entry.reason}</p>
              )}
            </div>
            <select
              aria-label="Resolution"
              value={resolutionByItem[entry.id] ?? "supplier_credit"}
              onChange={(event) =>
                setResolutionByItem((current) => ({
                  ...current,
                  [entry.id]: event.target.value as DiscrepancyResolution,
                }))
              }
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="supplier_credit">Supplier credit</option>
              <option value="replacement">Replacement</option>
            </select>
            <Button
              nativeButton={false}
              size="sm"
              disabled={resolve.isPending}
              onClick={() => submit(entry.id, entry.purchaseItemId)}
            >
              <CircleCheckIcon />
              Record
            </Button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        Recording the settlement completes the audit trail. It does not by
        itself create any credit or payment — money movements stay in the
        workflows that own them.
      </p>
    </section>
  );
}
