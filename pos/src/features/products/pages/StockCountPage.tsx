import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getErrorMessage } from "@/utils/getErrorMessage";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Badge } from "@/components/ui/badge.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { toast } from "@/components/ui/toast.js";
import axios from "../../../api/axios.js";
import type { LookupMatch } from "@/features/barcodes/barcode.api.js";
import { useBarcodeScanner } from "@/features/barcodes/scanning/useBarcodeScanner.js";
import { BarcodeScannerInput } from "@/features/barcodes/scanning/BarcodeScannerInput.js";
import { BarcodeScanFeedback } from "@/features/barcodes/scanning/BarcodeScanFeedback.js";

const tkCount = (n: number) => (n > 0 ? `+${n}` : `${n}`);

interface CountSession {
  id: number;
  status: string;
  note: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface CountLine {
  id: number;
  variantId: number;
  productName: string;
  variantName?: string | null | undefined;
  sku: string | null;
  barcode: string | null;
  expectedQuantity: number;
  countedQuantity: number | null;
}

/**
 * Stock-count sessions (Module 2): barcode stocktaking + cycle counting.
 * Count by scanning (barcode/SKU search) or typing; partial counts are
 * fine; approval applies counted − CURRENT stock so concurrent sales never
 * produce a wrong adjustment (the backend guarantees this).
 */
export function StockCountPage() {
  const [sessions, setSessions] = useState<CountSession[] | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [detail, setDetail] = useState<{
    lines: CountLine[];
    counted: number;
    total: number;
    status: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [counts, setCounts] = useState<Record<number, string>>({});

  const loadSessions = useCallback(async () => {
    try {
      const res = await axios.get<{ data: CountSession[] }>("/stock-counts");
      setSessions(res.data.data);
    } catch {
      toast.add({ type: "error", description: "Could not load sessions." });
      setSessions([]);
    }
  }, []);

  const loadDetail = useCallback(async (sessionId: number) => {
    try {
      const res = await axios.get<{
        data: { lines: CountLine[]; counted: number; total: number; session: CountSession };
      }>(`/stock-counts/${sessionId}`);
      setDetail({
        lines: res.data.data.lines,
        counted: res.data.data.counted,
        total: res.data.data.total,
        status: res.data.data.session.status,
      });
      setCounts(
        Object.fromEntries(
          res.data.data.lines
            .filter((l) => l.countedQuantity !== null)
            .map((l) => [l.variantId, String(l.countedQuantity)]),
        ),
      );
    } catch {
      toast.add({ type: "error", description: "Could not load the session." });
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (activeId !== null) void loadDetail(activeId);
  }, [activeId, loadDetail]);

  async function createSession() {
    setBusy(true);
    try {
      const res = await axios.post<{ data: { sessionId: number } }>(
        "/stock-counts",
        {},
      );
      toast.add({
        type: "success",
        description: "Stock count started.",
      });
      await loadSessions();
      setActiveId(res.data.data.sessionId);
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

  // Scan/entry handled by the shared scanner service (barcode | SKU |
  // server alias resolution). Each scan counts ONE physical unit into the
  // working count — expected stock is display-only until approval applies
  // the corrections (counted − CURRENT stock) server-side.
  const handleResolved = useCallback((match: LookupMatch) => {
    const line = detail?.lines.find((l) => l.variantId === match.variantId);
    if (!detail) {
      throw new Error("Open a count session first.");
    }
    if (!line) {
      throw new Error(
        `${match.productName} has no line in this count session.`,
      );
    }
    if (detail.status !== "open") {
      throw new Error("This count session is closed.");
    }
    setCounts((c) => {
      const current = Number.parseInt(c[line.variantId] ?? "", 10);
      const next = (Number.isFinite(current) ? current : 0) + 1;
      return { ...c, [line.variantId]: String(next) };
    });
  }, [detail]);

  const { scanner, state: scanState } = useBarcodeScanner({
    capture: "window",
    enabled: detail?.status === "open",
    onResolve: handleResolved,
  });

  const lastScanMatch =
    scanState.last &&
    (scanState.last.status === "resolved" ||
      scanState.last.status === "duplicate")
      ? scanState.last.match
      : undefined;
  const scannedLine = lastScanMatch
    ? (detail?.lines.find((l) => l.variantId === lastScanMatch.variantId) ??
      null)
    : null;

  const addToCount = useCallback((variantId: number) => {
    setCounts((c) => {
      const current = Number.parseInt(c[variantId] ?? "", 10);
      const next = (Number.isFinite(current) ? current : 0) + 1;
      return { ...c, [variantId]: String(next) };
    });
  }, []);

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

  async function submitCounts() {
    if (activeId === null || !detail) return;
    const entries = Object.entries(counts)
      .map(([variantId, value]) => ({
        variantId: Number(variantId),
        countedQuantity: Number(value),
      }))
      .filter((c) => Number.isInteger(c.countedQuantity) && c.countedQuantity >= 0);
    if (entries.length === 0) {
      toast.add({
        type: "error",
        description: "Enter at least one counted quantity.",
      });
      return;
    }
    setBusy(true);
    try {
      await axios.post(`/stock-counts/${activeId}/counts`, { counts: entries });
      toast.add({ type: "success", description: "Counts recorded." });
      setCounts({});
      await loadDetail(activeId);
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

  async function approve() {
    if (activeId === null) return;
    setBusy(true);
    try {
      const res = await axios.post<{
        data: { countedLines: number; adjustmentsApplied: number };
      }>(`/stock-counts/${activeId}/approve`);
      toast.add({
        type: "success",
        description: `Approved — ${res.data.data.adjustmentsApplied} adjustment(s) applied.`,
        priority: "high",
      });
      await loadSessions();
      setActiveId(null);
      setDetail(null);
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

  async function cancelSession() {
    if (activeId === null) return;
    setBusy(true);
    try {
      await axios.post(`/stock-counts/${activeId}/cancel`);
      toast.add({ type: "info", description: "Stock count cancelled." });
      await loadSessions();
      setActiveId(null);
      setDetail(null);
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
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle>Stock counts</CardTitle>
            <CardDescription>
              Count physical stock; approval corrects the system using
              counted − current (concurrent sales never cause wrong
              adjustments). Partial counts are fine.
            </CardDescription>
          </div>
          <Button disabled={busy} onClick={() => void createSession()}>
            New count
          </Button>
        </CardHeader>
        <CardContent>
          {sessions === null ? (
            <Skeleton className="h-24 w-full" />
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No stock counts yet.
            </p>
          ) : (
            <div className="space-y-1">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className={`flex w-full items-center justify-between rounded-md border p-2 text-left text-sm hover:bg-muted ${
                    activeId === session.id ? "border-primary" : ""
                  }`}
                  onClick={() => setActiveId(session.id)}
                >
                  <span>
                    #{session.id}
                    {session.note ? ` — ${session.note}` : ""}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {new Date(session.createdAt).toLocaleString()}
                    </span>
                    <Badge
                      variant={
                        session.status === "open" ? "default" : "secondary"
                      }
                    >
                      {session.status}
                    </Badge>
                  </span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {detail && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Session #{activeId} — counted {detail.counted}/{detail.total}
            </CardTitle>
            <CardDescription>
              Scan a barcode or search a product, enter what is physically on
              the shelf, then record. Approve to apply the corrections.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {detail.status === "open" && (
              <div className="space-y-2">
                <BarcodeScannerInput
                  scanner={scanner}
                  placeholder="Scan barcode / SKU, or type and press Enter…"
                  aria-label="Scan a product to count it"
                />
                <BarcodeScanFeedback state={scanState} />
              </div>
            )}
            {scannedLine && detail.status === "open" && (
              <div className="rounded-md border border-primary/40 bg-primary/5 p-2 text-sm">
                <span className="font-medium">
                  {scannedLine.variantName || scannedLine.productName}
                </span>{" "}
                <span className="text-muted-foreground">
                  expected {scannedLine.expectedQuantity}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-2"
                  onClick={() => addToCount(scannedLine.variantId)}
                >
                  Count one more
                </Button>
              </div>
            )}

            <div className="max-h-[45vh] overflow-y-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="p-2 font-medium">Product</th>
                    <th className="p-2 text-right font-medium">Expected</th>
                    <th className="p-2 text-right font-medium">Counted</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines.map((line) => (
                    <tr key={line.id} className="border-t">
                      <td className="p-2">
                        {line.variantName || line.productName}
                        {line.sku && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            {line.sku}
                          </span>
                        )}
                      </td>
                      <td className="p-2 text-right font-mono">
                        {line.expectedQuantity}
                      </td>
                      <td className="p-2 text-right">
                        {detail.status === "open" ? (
                          <Input
                            type="number"
                            min={0}
                            className="ml-auto h-8 w-24 text-right"
                            value={counts[line.variantId] ?? ""}
                            onChange={(e) =>
                              setCounts((c) => ({
                                ...c,
                                [line.variantId]: e.target.value,
                              }))
                            }
                            placeholder="—"
                          />
                        ) : line.countedQuantity === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span
                            className={`font-mono ${
                              line.countedQuantity !== line.expectedQuantity
                                ? "text-amber-600"
                                : ""
                            }`}
                          >
                            {line.countedQuantity} (
                            {tkCount(
                              line.countedQuantity - line.expectedQuantity,
                            )}
                            )
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {detail.status === "open" && (
              <div className="flex justify-end gap-2">
                <Button variant="outline" disabled={busy} onClick={() => void cancelSession()}>
                  Cancel session
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => void submitCounts()}>
                  Record counts
                </Button>
                <Button disabled={busy} onClick={() => void approve()}>
                  Approve & apply
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
