import { useEffect, useMemo, useRef, useState } from "react";
import { getErrorMessage } from "@/utils/getErrorMessage";
import { useWatch, type UseFormReturn } from "react-hook-form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { toast } from "@/components/ui/toast.js";
import { createExchangeApi } from "../../sales.api.js";
import { quoteSaleApi } from "../../quote.api.js";
import { useSalesStore, refreshStockAfterTransaction } from "../../stores/useSalesStore.js";
import useProductStore from "@/features/products/useProductStore.js";
import type {
  AllSoldProduct,
  SalesStoreType,
} from "../types/sales.types.js";
import { buildVariantName } from "@/lib/variantDisplay";
import type { LookupMatch } from "@/features/barcodes/barcode.api.js";
import { useBarcodeScanner } from "@/features/barcodes/scanning/useBarcodeScanner.js";
import { BarcodeScannerInput } from "@/features/barcodes/scanning/BarcodeScannerInput.js";
import { BarcodeScanFeedback } from "@/features/barcodes/scanning/BarcodeScanFeedback.js";

const tk = (n: number) => `৳${n.toFixed(2)}`;

const EXCHANGE_REASONS = [
  "customer_request",
  "wrong_item",
  "damaged",
  "quality_issue",
  "other",
] as const;

/**
 * Exchange flow (Module 5): return selected items of a completed sale and
 * sell replacements in one atomic transaction. The difference is computed
 * live via the server quote for the replacement side; the returned-value
 * side is an ESTIMATE (sum of line totals) — the backend settles the exact
 * numbers and any mismatch is surfaced with the required amount.
 */
export function ExchangeDialog({
  sale,
  open,
  onOpenChange,
}: {
  sale: AllSoldProduct;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const products = useProductStore((s) => s.products);
  // The store exposes getSales (NOT getSalesData — selecting a missing field
  // used to crash the post-exchange refresh behind a generic error toast).
  const getSales = useSalesStore((s) => s.getSales);
  const [selectedReturnIds, setSelectedReturnIds] = useState<number[]>([]);
  const [replacements, setReplacements] = useState<
    { variantId: number; name: string; quantity: number; unitPrice: number }[]
  >([]);
  const [search, setSearch] = useState("");
  const [reason, setReason] = useState<(typeof EXCHANGE_REASONS)[number]>("customer_request");
  const [notes, setNotes] = useState("");
  const [disposition, setDisposition] = useState<"restock" | "inspection" | "damaged">("restock");
  const [busy, setBusy] = useState(false);
  const [replacementTotal, setReplacementTotal] = useState<number | null>(null);

  const returnableItems = useMemo(
    () =>
      sale.items.filter(
        (item) => item.returnedQuantity < item.soldQuantity,
      ),
    [sale],
  );

  const selectedReturnValue = useMemo(() => {
    // ESTIMATE: line total of the selected returnable items. The backend
    // computes the authoritative effective value (incl. discount/VAT share).
    return returnableItems
      .filter((item) => selectedReturnIds.includes(item.saleItemsId))
      .reduce((sum, item) => sum + Number(item.lineTotal), 0);
  }, [returnableItems, selectedReturnIds]);

  // Live quote of the replacement cart (server-authoritative totals).
  useEffect(() => {
    if (replacements.length === 0) {
      setReplacementTotal(null);
      return;
    }
    let ignore = false;
    const timer = setTimeout(() => {
      quoteSaleApi({
        items: replacements.map((r) => ({
          variantId: r.variantId,
          quantity: r.quantity,
          discount: null,
        })),
        cartDiscount: null,
        vatPercent: null,
      })
        .then((totals) => {
          if (!ignore) setReplacementTotal(totals.finalTotal);
        })
        .catch(() => {
          if (!ignore) {
            setReplacementTotal(
              replacements.reduce(
                (sum, r) => sum + r.unitPrice * r.quantity,
                0,
              ),
            );
          }
        });
    }, 250);
    return () => {
      ignore = true;
      clearTimeout(timer);
    };
  }, [replacements]);

  const searchResults = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query.length < 2) return [];
    return products
      .filter(
        (p) =>
          p.status !== "inactive" &&
          (p.name.toLowerCase().includes(query) ||
            (p.variants ?? []).some(
              (v) =>
                (v.sku ?? "").toLowerCase().includes(query) ||
                (v.barcode ?? "").toLowerCase().includes(query),
            )),
      )
      .slice(0, 6);
  }, [products, search]);

  const estimatedDifference =
    replacementTotal === null ? null : replacementTotal - selectedReturnValue;

  /**
   * Module scan handler — the scanner service only IDENTIFIES a barcode;
   * the exchange rule (add the scanned variant as a replacement line, same
   * as picking it from search) lives here. Scanning never refunds anything.
   * Throwing surfaces the failure as an error scan.
   */
  const handleResolved = (match: LookupMatch) => {
    const row = products
      .flatMap((product) =>
        (product.variants ?? []).map((variant) => ({ product, variant })),
      )
      .find(({ variant }) => variant.id === match.variantId);
    if (!row) {
      throw new Error(`${match.productName} is not in the loaded catalog.`);
    }
    if (row.product.status === "inactive") {
      throw new Error(`${row.product.name} is inactive.`);
    }
    const variantLabel = buildVariantName(
      row.product.name,
      row.variant.options,
    );
    setReplacements((current) => {
      const existing = current.find((r) => r.variantId === match.variantId);
      if (existing) {
        return current.map((r) =>
          r.variantId === match.variantId
            ? { ...r, quantity: r.quantity + 1 }
            : r,
        );
      }
      return [
        ...current,
        {
          variantId: match.variantId,
          name: variantLabel,
          quantity: 1,
          unitPrice: Number(row.variant.sellingPrice),
        },
      ];
    });
  };

  // Wedge capture only while the dialog is up.
  const { scanner, state: scanState } = useBarcodeScanner({
    capture: "window",
    enabled: open,
    onResolve: handleResolved,
  });

  // Scan outcome → toast (spec §16: never silently ignore failed scans).
  const lastHandledEventId = useRef(0);
  useEffect(() => {
    const event = scanState.last;
    if (!event || event.id <= lastHandledEventId.current) return;
    lastHandledEventId.current = event.id;
    if (event.status === "not_found") {
      toast.add({
        type: "error",
        description: "No product matches that barcode.",
      });
    } else if (event.status === "ambiguous") {
      toast.add({
        type: "error",
        description:
          event.detail ?? "That barcode matches more than one product.",
        priority: "high",
      });
    } else if (event.status === "error") {
      toast.add({
        type: "error",
        description: event.detail ?? "Scan failed.",
        priority: "high",
      });
    }
  }, [scanState.last]);

  async function submit() {
    if (selectedReturnIds.length === 0 || replacements.length === 0) return;
    setBusy(true);
    try {
      const result = await createExchangeApi(sale.id, {
        returns: selectedReturnIds.map((saleItemId) => ({ saleItemId })),
        replacements: replacements.map((r) => ({
          variantId: r.variantId,
          quantity: r.quantity,
        })),
        reason,
        notes: notes.trim() || undefined,
        disposition,
      });
      toast.add({
        type: "success",
        description: `Exchange recorded: ${result.sale.invoiceNumber} (difference ${tk(result.difference)})`,
        priority: "high",
      });
      // The exchange is COMMITTED at this point — refresh failures must never
      // present it as failed. getSales catches internally (error lands on the
      // store), and the stock refresh is best-effort by design.
      try {
        await getSales();
        await refreshStockAfterTransaction();
      } catch {
        // Swallow: the sales list / grid refetch on their next trigger.
      }
      onOpenChange(false);
      setSelectedReturnIds([]);
      setReplacements([]);
      setSearch("");
      setNotes("");
    } catch (err) {
      toast.add({
        type: "error",
        description:
          getErrorMessage(err),
        priority: "high",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Exchange — {sale.invoiceNumber}</DialogTitle>
          <DialogDescription>
            Return items and sell replacements in one step. The difference is
            settled exactly; the backend confirms the final numbers.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Step 1 — returns */}
          <div>
            <div className="mb-1 text-sm font-medium">1. Items to return</div>
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
              {returnableItems.length === 0 && (
                <div className="text-sm text-muted-foreground">
                  Nothing left to return on this sale.
                </div>
              )}
              {returnableItems.map((item: SalesStoreType) => (
                <label
                  key={item.saleItemsId}
                  className="flex cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={selectedReturnIds.includes(item.saleItemsId)}
                    onChange={(e) =>
                      setSelectedReturnIds((current) =>
                        e.target.checked
                          ? [...current, item.saleItemsId]
                          : current.filter((id) => id !== item.saleItemsId),
                      )
                    }
                  />
                  <span className="flex-1">
                    {item.variantName || item.productName} × {item.soldQuantity}
                  </span>
                  <span className="font-mono">
                    {tk(Number(item.lineTotal))}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Step 2 — replacements */}
          <div>
            <div className="mb-1 text-sm font-medium">2. Replacement items</div>
            <div className="space-y-2">
              <BarcodeScannerInput
                scanner={scanner}
                placeholder="Scan a barcode to add the replacement…"
                aria-label="Scan barcode to add an exchange replacement"
              />
              <BarcodeScanFeedback state={scanState} />
            </div>
            <Input
              placeholder="Search products to add (name, SKU, barcode)…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="mt-2"
            />
            {searchResults.length > 0 && (
              <div className="mt-1 max-h-32 space-y-1 overflow-y-auto rounded-md border p-2">
                {searchResults.flatMap((product) =>
                  (product.variants ?? []).map((variant) => {
                    const variantLabel = buildVariantName(
                      product.name,
                      variant.options,
                    );
                    return (
                      <button
                        key={variant.id}
                        type="button"
                        className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-muted"
                        onClick={() => {
                          setReplacements((current) => {
                            const existing = current.find(
                              (r) => r.variantId === variant.id,
                            );
                            if (existing) {
                              return current.map((r) =>
                                r.variantId === variant.id
                                  ? { ...r, quantity: r.quantity + 1 }
                                  : r,
                              );
                            }
                            return [
                              ...current,
                              {
                                variantId: variant.id,
                                name: variantLabel,
                                quantity: 1,
                                unitPrice: Number(variant.sellingPrice),
                              },
                            ];
                          });
                          setSearch("");
                        }}
                      >
                        <span>{variantLabel}</span>
                        <span className="font-mono">
                          {tk(Number(variant.sellingPrice))}
                        </span>
                      </button>
                    );
                  }),
                )}
              </div>
            )}
            {replacements.length > 0 && (
              <div className="mt-2 space-y-1">
                {replacements.map((r) => (
                  <div
                    key={r.variantId}
                    className="flex items-center gap-2 text-sm"
                  >
                    <span className="flex-1">{r.name}</span>
                    <Input
                      type="number"
                      min={1}
                      className="h-8 w-20"
                      value={r.quantity}
                      onChange={(e) =>
                        setReplacements((current) =>
                          current.map((row) =>
                            row.variantId === r.variantId
                              ? {
                                  ...row,
                                  quantity: Math.max(1, Number(e.target.value) || 1),
                                }
                              : row,
                          ),
                        )
                      }
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setReplacements((current) =>
                          current.filter((row) => row.variantId !== r.variantId),
                        )
                      }
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Step 3 — reason / disposition */}
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">
              <span className="mb-1 block font-medium">Reason</span>
              <select
                className="w-full rounded-md border bg-background p-2 text-sm"
                value={reason}
                onChange={(e) =>
                  setReason(e.target.value as (typeof EXCHANGE_REASONS)[number])
                }
              >
                {EXCHANGE_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Returned stock</span>
              <select
                className="w-full rounded-md border bg-background p-2 text-sm"
                value={disposition}
                onChange={(e) =>
                  setDisposition(
                    e.target.value as "restock" | "inspection" | "damaged",
                  )
                }
              >
                <option value="restock">Restock</option>
                <option value="inspection">Inspection</option>
                <option value="damaged">Damaged</option>
              </select>
            </label>
          </div>
          <Input
            placeholder="Notes (optional)"
            maxLength={500}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />

          {/* Settlement summary */}
          <div className="rounded-md border p-3 text-sm">
            <div className="flex justify-between">
              <span>Returned value (estimated)</span>
              <span className="font-mono">{tk(selectedReturnValue)}</span>
            </div>
            <div className="flex justify-between">
              <span>Replacement total</span>
              <span className="font-mono">
                {replacementTotal === null ? "—" : tk(replacementTotal)}
              </span>
            </div>
            <div className="mt-1 flex justify-between border-t pt-1 font-semibold">
              <span>
                {estimatedDifference === null
                  ? "Difference"
                  : estimatedDifference > 0
                    ? "Customer pays"
                    : estimatedDifference < 0
                      ? "Refund to customer"
                      : "Even exchange"}
              </span>
              <span className="font-mono">
                {estimatedDifference === null
                  ? "—"
                  : tk(Math.abs(estimatedDifference))}
              </span>
            </div>
            {estimatedDifference !== null && estimatedDifference !== 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {estimatedDifference > 0
                  ? "Collect the difference at the register (cash/QR/card) — the backend confirms the exact amount."
                  : "The surplus goes back to the customer (cash by default)."}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                busy ||
                selectedReturnIds.length === 0 ||
                replacements.length === 0
              }
              onClick={() => void submit()}
            >
              {busy ? "Recording exchange…" : "Record exchange"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
