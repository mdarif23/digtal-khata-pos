import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ArrowRight, Plus, Trash2 } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSessionStore } from "@/auth/sessionStore";
import {
  cancelTransferApi,
  createTransferApi,
  getTransferApi,
  getTransfersApi,
  getVariantOptionsApi,
  receiveTransferApi,
  authorizeTransferApi,
  shipTransferApi,
  type TransferDetail,
  type TransferListItem,
  type TransferStatus,
  type VariantOption,
} from "../stockTransfers.api";
import type { LookupMatch } from "@/features/barcodes/barcode.api";
import { useBarcodeScanner } from "@/features/barcodes/scanning/useBarcodeScanner";
import { BarcodeScannerInput } from "@/features/barcodes/scanning/BarcodeScannerInput";
import { BarcodeScanFeedback } from "@/features/barcodes/scanning/BarcodeScanFeedback";

const STATUS_LABELS: Record<TransferStatus, string> = {
  draft: "Draft",
  shipped: "Shipped",
  partially_received: "Partially received",
  received: "Received",
  cancelled: "Cancelled",
};

function statusVariant(status: TransferStatus): "default" | "secondary" | "outline" | "destructive" {
  switch (status) {
    case "received":
      return "default";
    case "shipped":
    case "partially_received":
      return "secondary";
    case "cancelled":
      return "destructive";
    default:
      return "outline";
  }
}

interface DraftItem {
  variantId: number | null;
  quantity: string;
}

export function StockTransfersPage() {
  const locations = useSessionStore((state) => state.locations);
  const [transfers, setTransfers] = useState<TransferListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [fromLocationId, setFromLocationId] = useState<string>("");
  const [toLocationId, setToLocationId] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<DraftItem[]>([
    { variantId: null, quantity: "1" },
  ]);
  const [variantOptions, setVariantOptions] = useState<VariantOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [detail, setDetail] = useState<TransferDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [receiveQuantities, setReceiveQuantities] = useState<
    Record<number, string>
  >({});

  // Phase 4 (Feature 17): per-item shortfall reasons + explicit close-short.
  const [shortfallReasons, setShortfallReasons] = useState<Record<number, string>>({});
  const [showShortfallReasons, setShowShortfallReasons] = useState(false);
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getTransfersApi();
      setTransfers(data);
    } catch {
      toast.add({ title: "Unable to load transfers", type: "error" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function openCreate() {
    setFormError(null);
    setNotes("");
    setItems([{ variantId: null, quantity: "1" }]);
    setCreateOpen(true);
    if (variantOptions.length === 0) {
      try {
        setVariantOptions(await getVariantOptionsApi());
      } catch {
        toast.add({ title: "Unable to load products", type: "error" });
      }
    }
  }

  function extractError(error: unknown, fallback: string): string {
    if (
      typeof error === "object" &&
      error !== null &&
      "response" in error &&
      typeof (error as { response?: { data?: { message?: string } } }).response
        ?.data?.message === "string"
    ) {
      return (error as { response: { data: { message: string } } }).response.data
        .message;
    }
    return fallback;
  }

  /**
   * Module scan handler — the scanner service only IDENTIFIES a barcode;
   * the transfer rule (fill or increment a draft row) lives here. Scanning
   * never ships or moves stock — the draft is confirmed manually.
   */
  const handleResolved = (match: LookupMatch) => {
    setItems((prev) => {
      const existingIndex = prev.findIndex(
        (item) => item.variantId === match.variantId,
      );
      if (existingIndex >= 0) {
        return prev.map((item, i) =>
          i === existingIndex
            ? { ...item, quantity: String((Number(item.quantity) || 0) + 1) }
            : item,
        );
      }
      // Fill the untouched default row before appending a new one.
      const emptyIndex = prev.findIndex((item) => item.variantId === null);
      if (emptyIndex >= 0) {
        return prev.map((item, i) =>
          i === emptyIndex ? { ...item, variantId: match.variantId } : item,
        );
      }
      return [...prev, { variantId: match.variantId, quantity: "1" }];
    });
  };

  // Wedge capture only while the draft dialog is up; the scan box inside
  // the dialog covers scans typed while an input holds focus.
  const { scanner, state: scanState } = useBarcodeScanner({
    capture: "window",
    enabled: createOpen,
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

  async function handleCreate() {
    setFormError(null);
    if (fromLocationId === "" || toLocationId === "") {
      setFormError("Choose both source and destination locations.");
      return;
    }
    if (fromLocationId === toLocationId) {
      setFormError("Source and destination must be different locations.");
      return;
    }
    const payloadItems: { variantId: number; quantity: number }[] = [];
    for (const item of items) {
      if (item.variantId === null) {
        setFormError("Select a product for every row.");
        return;
      }
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        setFormError("Quantities must be whole numbers of at least 1.");
        return;
      }
      payloadItems.push({ variantId: item.variantId, quantity });
    }
    setSaving(true);
    try {
      const created = await createTransferApi({
        fromLocationId: Number(fromLocationId),
        toLocationId: Number(toLocationId),
        notes: notes.trim() || undefined,
        items: payloadItems,
      });
      toast.add({
        title: `Transfer ${created.transferNumber} drafted`,
        type: "success",
      });
      setCreateOpen(false);
      void load();
    } catch (error) {
      setFormError(extractError(error, "Unable to create the transfer."));
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(id: number) {
    setDetailLoading(true);
    try {
      const data = await getTransferApi(id);
      setDetail(data);
      const initial: Record<number, string> = {};
      for (const item of data.items) {
        const outstanding = item.quantityShipped - item.quantityReceived;
        initial[item.id] = String(outstanding);
      }
      setReceiveQuantities(initial);
    } catch {
      toast.add({ title: "Unable to load the transfer", type: "error" });
    } finally {
      setDetailLoading(false);
    }
  }

  async function act(
    action: () => Promise<TransferDetail>,
    successTitle: string,
  ) {
    setActing(true);
    try {
      const updated = await action();
      toast.add({ title: successTitle, type: "success" });
      setDetail(updated);
      void load();
    } catch (error) {
      toast.add({ title: extractError(error, "Action failed."), type: "error" });
    } finally {
      setActing(false);
    }
  }

  async function handleReceive(forceComplete = false) {
    if (!detail) return;
    const payload: { itemId: number; quantity: number }[] = [];
    const reasons: Record<string, string> = {};
    let hasShortfall = false;
    for (const item of detail.items) {
      const outstanding = item.quantityShipped - item.quantityReceived;
      if (outstanding <= 0) continue;
      const raw = receiveQuantities[item.id] ?? "0";
      const quantity = Number(raw);
      if (!Number.isInteger(quantity) || quantity < 0) {
        toast.add({
          title: "Received quantities must be whole numbers ≥ 0.",
          type: "error",
        });
        return;
      }
      if (quantity > 0) payload.push({ itemId: item.id, quantity });
      // Phase 4 (Feature 17): shortfall reason captured per item — recorded
      // as an explicit discrepancy when the transfer closes short.
      const shortfall = outstanding - quantity;
      if (shortfall > 0) {
        hasShortfall = true;
        const reason = shortfallReasons[item.id]?.trim();
        if (reason) reasons[String(item.id)] = reason;
      }
    }
    if (hasShortfall && !forceComplete) {
      toast.add({
        title:
          "Received less than shipped — fill shortfall reasons and confirm “Close with shortfalls” to finish with discrepancies.",
        type: "error",
        priority: "high",
      });
      return;
    }
    await act(
      () =>
        receiveTransferApi(detail.id, payload, {
          ...(hasShortfall ? { reasons } : {}),
          forceComplete,
        }),
      hasShortfall
        ? "Transfer received with recorded discrepancies"
        : "Transfer received",
    );
    setShowShortfallReasons(false);
  }

  const activeLocations = useMemo(
    () => locations.filter((l) => l.status === "active"),
    [locations],
  );

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Stock Transfers</h1>
          <p className="text-sm text-muted-foreground">
            Move stock between locations. Shipped stock is in transit until it
            is received.
          </p>
        </div>
        <Button onClick={() => void openCreate()}>
          <Plus /> New transfer
        </Button>
      </div>

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Number</TableHead>
              <TableHead>Route</TableHead>
              <TableHead>Items</TableHead>
              <TableHead>Qty</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  Loading transfers…
                </TableCell>
              </TableRow>
            ) : transfers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No transfers yet.
                </TableCell>
              </TableRow>
            ) : (
              transfers.map((transfer) => (
                <TableRow key={transfer.id}>
                  <TableCell className="font-medium">
                    {transfer.transferNumber}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 text-sm">
                      {transfer.fromLocationName}
                      <ArrowRight className="size-3.5 text-muted-foreground" />
                      {transfer.toLocationName}
                    </span>
                  </TableCell>
                  <TableCell>{transfer.itemCount}</TableCell>
                  <TableCell>{transfer.totalQuantity}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(transfer.status)}>
                      {STATUS_LABELS[transfer.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void openDetail(transfer.id)}
                    >
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>New stock transfer</DialogTitle>
            <DialogDescription>
              The transfer starts as a draft — stock moves when you ship it.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>From</Label>
                <Select
                  value={fromLocationId || undefined}
                  onValueChange={(value) => setFromLocationId(value ?? "")}
                  // Base UI renders Select.Value as the RAW selected value
                  // unless the root knows the value->label mapping.
                  items={activeLocations.map((location) => ({
                    value: String(location.id),
                    label: location.name,
                  }))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Source location" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeLocations.map((location) => (
                      <SelectItem key={location.id} value={String(location.id)}>
                        {location.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>To</Label>
                <Select
                  value={toLocationId || undefined}
                  onValueChange={(value) => setToLocationId(value ?? "")}
                  items={activeLocations.map((location) => ({
                    value: String(location.id),
                    label: location.name,
                  }))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Destination location" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeLocations.map((location) => (
                      <SelectItem key={location.id} value={String(location.id)}>
                        {location.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-2">
              <Label>Items</Label>
              <div className="space-y-1 rounded-lg border bg-muted/30 p-2">
                <BarcodeScannerInput
                  scanner={scanner}
                  placeholder="Scan a barcode to add it to the draft…"
                  aria-label="Scan barcode to add a transfer item"
                />
                <BarcodeScanFeedback state={scanState} />
              </div>
              {items.map((item, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Select
                    value={item.variantId !== null ? String(item.variantId) : undefined}
                    onValueChange={(value) =>
                      setItems((prev) =>
                        prev.map((entry, i) =>
                          i === index
                            ? { ...entry, variantId: Number(value) }
                            : entry,
                        ),
                      )
                    }
                    items={variantOptions.map((option) => ({
                      value: String(option.variantId),
                      label: `${option.label}${option.sku ? ` (${option.sku})` : ""}`,
                    }))}
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="Select product" />
                    </SelectTrigger>
                    <SelectContent>
                      {variantOptions.map((option) => (
                        <SelectItem
                          key={option.variantId}
                          value={String(option.variantId)}
                        >
                          {option.label}
                          {option.sku ? ` (${option.sku})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    min={1}
                    className="w-24"
                    value={item.quantity}
                    onChange={(event) =>
                      setItems((prev) =>
                        prev.map((entry, i) =>
                          i === index
                            ? { ...entry, quantity: event.target.value }
                            : entry,
                        ),
                      )
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      setItems((prev) => prev.filter((_, i) => i !== index))
                    }
                    disabled={items.length === 1}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() =>
                  setItems((prev) => [
                    ...prev,
                    { variantId: null, quantity: "1" },
                  ])
                }
              >
                <Plus /> Add row
              </Button>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="transfer-notes">Notes (optional)</Label>
              <Input
                id="transfer-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </div>
            {formError ? (
              <p className="text-sm text-destructive">{formError}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void handleCreate()} disabled={saving}>
              {saving ? "Creating…" : "Create draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail / workflow dialog */}
      <Dialog
        open={detail !== null || detailLoading}
        onOpenChange={(open) => !open && setDetail(null)}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          {detail ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {detail.transferNumber}
                  <Badge variant={statusVariant(detail.status)}>
                    {STATUS_LABELS[detail.status]}
                  </Badge>
                </DialogTitle>
                <DialogDescription>
                  {detail.fromLocationName} → {detail.toLocationName}
                  {detail.notes ? ` · ${detail.notes}` : ""}
                </DialogDescription>
              </DialogHeader>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Requested</TableHead>
                    <TableHead>Shipped</TableHead>
                    {detail.status !== "draft" && detail.status !== "cancelled" ? (
                      <TableHead>Receive now</TableHead>
                    ) : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.items.map((item) => {
                    const outstanding =
                      item.quantityShipped - item.quantityReceived;
                    return (
                      <TableRow key={item.id}>
                        <TableCell>
                          {item.variantName || item.productName || "—"}
                          {item.sku ? (
                            <span className="block text-xs text-muted-foreground">
                              {item.sku}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell>{item.quantity}</TableCell>
                        <TableCell>
                          {item.quantityShipped}
                          {item.quantityReceived > 0 ? (
                            <span className="block text-xs text-muted-foreground">
                              {item.quantityReceived} received ·{" "}
                              {outstanding} in transit
                            </span>
                          ) : null}
                        </TableCell>
                        {detail.status !== "draft" &&
                        detail.status !== "cancelled" ? (
                          <TableCell>
                            {outstanding > 0 ? (
                              <Input
                                type="number"
                                min={0}
                                max={outstanding}
                                className="w-20"
                                value={receiveQuantities[item.id] ?? "0"}
                                onChange={(event) =>
                                  setReceiveQuantities((prev) => ({
                                    ...prev,
                                    [item.id]: event.target.value,
                                  }))
                                }
                              />
                            ) : (
                              <span className="text-sm text-muted-foreground">
                                done
                              </span>
                            )}
                          </TableCell>
                        ) : null}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>

              {showShortfallReasons &&
              (detail.status === "shipped" ||
                detail.status === "partially_received") ? (
                <div className="grid gap-2 rounded-md border border-dashed p-3">
                  <p className="text-xs text-muted-foreground">
                    Receiving less than shipped records explicit discrepancies.
                    Add a reason per short line, then “Close with shortfalls”.
                  </p>
                  {detail.items
                    .filter((item) => item.quantityShipped - item.quantityReceived > 0)
                    .map((item) => (
                      <div key={item.id} className="grid gap-1">
                        <Label className="text-xs">
                          {item.variantName ?? `Item ${item.id}`} — short by{" "}
                          {item.quantityShipped - item.quantityReceived}
                        </Label>
                        <Input
                          className="h-8"
                          placeholder="Reason (optional)"
                          value={shortfallReasons[item.id] ?? ""}
                          onChange={(e) =>
                            setShortfallReasons((previous) => ({
                              ...previous,
                              [item.id]: e.target.value,
                            }))
                          }
                        />
                      </div>
                    ))}
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={acting}
                    onClick={() => void handleReceive(true)}
                  >
                    {acting ? "Closing…" : "Close with shortfalls"}
                  </Button>
                </div>
              ) : null}
              <DialogFooter className="gap-2">
                {detail.status === "draft" ? (
                  <>
                    <Button
                      variant="outline"
                      disabled={acting}
                      onClick={() =>
                        void act(
                          () => cancelTransferApi(detail.id),
                          "Transfer cancelled",
                        )
                      }
                    >
                      Cancel draft
                    </Button>
                    <Button
                      variant="outline"
                      disabled={acting}
                      onClick={() =>
                        void act(
                          () => authorizeTransferApi(detail.id),
                          "Transfer authorized",
                        )
                      }
                    >
                      Authorize
                    </Button>
                    <Button
                      disabled={acting}
                      onClick={() =>
                        void act(
                          () => shipTransferApi(detail.id),
                          "Transfer shipped — stock in transit",
                        )
                      }
                    >
                      {acting ? "Shipping…" : "Ship"}
                    </Button>
                  </>
                ) : null}
                {detail.status === "shipped" ||
                detail.status === "partially_received" ? (
                  <>
                    <Button
                      disabled={acting}
                      onClick={() => void handleReceive(false)}
                    >
                      {acting ? "Receiving…" : "Receive"}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={acting}
                      onClick={() => setShowShortfallReasons((v) => !v)}
                    >
                      Close with shortfalls…
                    </Button>
                  </>
                ) : null}
                {detail.status === "received" ||
                detail.status === "cancelled" ? (
                  <span className="text-sm text-muted-foreground">
                    Nothing further to do.
                  </span>
                ) : null}
                {detail.discrepancies && detail.discrepancies.length > 0 ? (
                  <div className="grid gap-1 rounded-md border border-red-200 bg-red-50 p-2 text-xs dark:border-red-900 dark:bg-red-950">
                    <span className="font-medium text-red-700 dark:text-red-400">
                      Recorded discrepancies
                    </span>
                    {detail.discrepancies.map((row) => (
                      <div key={row.id}>
                        {`Item ${row.itemId}: shipped ${row.shippedQty}, received ${row.receivedQty} (short ${row.difference})${row.reason ? ` — ${row.reason}` : ""}`}
                      </div>
                    ))}
                  </div>
                ) : null}
              </DialogFooter>
            </>
          ) : (
            <p className="py-8 text-center text-muted-foreground">Loading…</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
