import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import axios from "../../../../api/axios.js";
import { readVariantBatches } from "../../offline/catalog.js";

export interface BatchOption {
  id: number;
  batchNumber: string;
  quantityRemaining: number;
  expiryDate: string | null;
  expiryStatus: "valid" | "expiring_soon" | "expired" | "no_expiry";
}

const statusBadgeVariant = (status: BatchOption["expiryStatus"]) =>
  status === "expired"
    ? "destructive"
    : status === "expiring_soon"
      ? "outline"
      : "secondary";

/**
 * P3 Phase 2 (F.1): the POS batch picker — the serial picker's UX applied
 * to batches, single-select (a cart line sells from ONE batch; FEFO picks
 * automatically when the cashier leaves it alone). Expired batches appear
 * only when the server's policy surfaces them, pre-flagged for the approval
 * flow. Offline the dialog reads the catalog cache (D10).
 */
export function BatchPickerDialog({
  variantId,
  selectedBatchId,
  onConfirm,
  dialogOpen,
  setDialogOpen,
}: {
  variantId: number | undefined;
  selectedBatchId: number | null;
  onConfirm: (batch: BatchOption | null) => void;
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
}) {
  const [available, setAvailable] = useState<BatchOption[]>([]);
  const [pickedId, setPickedId] = useState<number | null>(selectedBatchId);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!dialogOpen) return;
    setPickedId(selectedBatchId);
    setSearch("");
    setError("");
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      // D10: offline — the catalog cache carries the batch snapshot taken at
      // allowance-refresh time.
      readVariantBatches(variantId ?? 0)
        .then((cached) => setAvailable((cached as BatchOption[] | null) ?? []))
        .catch(() => setAvailable([]));
      return;
    }
    axios
      .get<{ data: BatchOption[] }>(`variants/${variantId}/batches`)
      .then((res) => setAvailable(res.data.data))
      .catch(() => setError("Could not load batches"));
  }, [dialogOpen, variantId]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = available.filter((b) =>
    b.batchNumber.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogContent className="z-100 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Select batch</DialogTitle>
          <DialogDescription>
            FEFO picks the earliest expiry automatically when no batch is
            chosen. Manual selection takes precedence over FEFO.
          </DialogDescription>
        </DialogHeader>

        <Input
          autoFocus
          value={search}
          placeholder="Search batch number"
          onChange={(e) => setSearch(e.target.value)}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="max-h-64 space-y-1 overflow-y-auto">
          {visible.map((batch) => (
            <label
              key={batch.id}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-muted"
            >
              <input
                type="checkbox"
                checked={pickedId === batch.id}
                onChange={() =>
                  setPickedId(pickedId === batch.id ? null : batch.id)
                }
              />
              <span className="min-w-0 flex-1 truncate font-medium">
                {batch.batchNumber}
              </span>
              <Badge variant={statusBadgeVariant(batch.expiryStatus)}>
                {batch.expiryStatus === "no_expiry"
                  ? "no expiry"
                  : batch.expiryStatus === "expired"
                    ? "expired"
                    : batch.expiryStatus === "expiring_soon"
                      ? "expiring soon"
                      : "valid"}
              </Badge>
              <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">
                × {batch.quantityRemaining}
              </span>
            </label>
          ))}
          {visible.length === 0 && (
            <p className="text-sm text-muted-foreground">No batches found</p>
          )}
        </div>

        <DialogFooter>
          <DialogClose
            render={
              <Button type="button" variant="outline">
                Cancel
              </Button>
            }
          />
          {selectedBatchId !== null && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                onConfirm(null); // back to FEFO default
                setDialogOpen(false);
              }}
            >
              Use FEFO
            </Button>
          )}
          <Button
            type="button"
            disabled={pickedId === null}
            onClick={() => {
              const batch = available.find((b) => b.id === pickedId) ?? null;
              onConfirm(batch);
              setDialogOpen(false);
            }}
          >
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
