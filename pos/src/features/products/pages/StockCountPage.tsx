import { useCallback, useEffect, useMemo, useState } from "react";
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
  const [scan, setScan] = useState("");
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
          err instanceof Error ? err.message : "Could not start the count.",
        priority: "high",
      });
    } finally {
      setBusy(false);
    }
  }

  // Scan/entry: resolve barcode | SKU | name against the session's lines.
  const scanMatch = useMemo(() => {
    const query = scan.trim().toLowerCase();
    if (query.length < 3 || !detail) return null;
    return (
      detail.lines.find(
        (l) =>
          (l.barcode ?? "").toLowerCase() === query ||
          (l.sku ?? "").toLowerCase() === query ||
          l.productName.toLowerCase().includes(query),
      ) ?? null
    );
  }, [scan, detail]);

  async function submitCounts() {
    if (activeId === null || !detail) return;
    const counts = Object.entries(counts)
      .map(([variantId, value]) => ({
        variantId: Number(variantId),
        countedQuantity: Number(value),
      }))
      .filter((c) => Number.isInteger(c.countedQuantity) && c.countedQuantity >= 0);
    if (counts.length === 0) {
      toast.add({
        type: "error",
        description: "Enter at least one counted quantity.",
      });
      return;
    }
    setBusy(true);
    try {
      await axios.post(`/stock-counts/${activeId}/counts`, { counts });
      toast.add({ type: "success", description: "Counts recorded." });
      setCounts({});
      setScan("");
      await loadDetail(activeId);
    } catch (err) {
      toast.add({
        type: "error",
        description:
          err instanceof Error ? err.message : "Could not record the counts.",
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
          err instanceof Error ? err.message : "Could not approve the count.",
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
          err instanceof Error ? err.message : "Could not cancel.",
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
              <Input
                placeholder="Scan barcode / SKU / product name…"
                value={scan}
                onChange={(e) => setScan(e.target.value)}
              />
            )}
            {scanMatch && detail.status === "open" && (
              <div className="rounded-md border border-primary/40 bg-primary/5 p-2 text-sm">
                <span className="font-medium">{scanMatch.productName}</span>{" "}
                <span className="text-muted-foreground">
                  expected {scanMatch.expectedQuantity}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-2"
                  onClick={() =>
                    setCounts((c) => ({
                      ...c,
                      [scanMatch.variantId]: c[scanMatch.variantId] ?? "",
                    }))
                  }
                >
                  Add to count
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
                        {line.productName}
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
