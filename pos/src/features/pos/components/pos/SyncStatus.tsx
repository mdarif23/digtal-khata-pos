import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useOfflineStore } from "../../offline/offlineStore.js";
import api from "../../../../api/axios.js";

/**
 * Register-side offline status (Module 10): an offline pill when the
 * backend is unreachable, a pending-sync counter once transactions are
 * queued, and a dialog with the full synchronization history — recorded,
 * pending, synced (with invoice numbers), and REJECTED (requires manual
 * review). Nothing is ever silently dropped.
 */
export function SyncStatusIndicator() {
  const offlineMode = useOfflineStore((s) => s.offlineMode);
  const online = useOfflineStore((s) => s.online);
  const pendingCount = useOfflineStore((s) => s.pendingCount);
  const failedCount = useOfflineStore((s) => s.failedCount);
  const syncing = useOfflineStore((s) => s.syncing);
  const [open, setOpen] = useState(false);

  const isOffline = offlineMode || (!online && pendingCount >= 0);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1"
        aria-label="Synchronization status"
      >
        {isOffline && (
          <Badge variant="outline" className="border-amber-500 text-amber-600">
            ● Offline mode
          </Badge>
        )}
        {syncing && <Badge variant="outline">Syncing…</Badge>}
        {pendingCount > 0 && (
          <Badge variant="outline" className="border-blue-500 text-blue-600">
            Pending sync: {pendingCount}
          </Badge>
        )}
        {failedCount > 0 && (
          <Badge variant="destructive">Needs review: {failedCount}</Badge>
        )}
      </button>
      <SyncHistoryDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function SyncHistoryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const history = useOfflineStore((s) => s.history);
  const log = useOfflineStore((s) => s.log);
  const syncing = useOfflineStore((s) => s.syncing);
  const pendingCount = useOfflineStore((s) => s.pendingCount);
  const failedCount = useOfflineStore((s) => s.failedCount);
  const syncNow = useOfflineStore((s) => s.syncNow);
  const retryFailed = useOfflineStore((s) => s.retryFailed);
  const refresh = useOfflineStore((s) => s.refresh);
  const lastSyncAt = useOfflineStore((s) => s.lastSyncAt);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh, tick]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <ConflictSection />
        <DialogHeader>
          <DialogTitle>Offline sales & synchronization</DialogTitle>
          <DialogDescription>
            Sales recorded offline are queued here with their own transaction
            ids and replayed safely (duplicates are impossible).{" "}
            {lastSyncAt
              ? `Last sync: ${new Date(lastSyncAt).toLocaleTimeString()}.`
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={syncing || pendingCount === 0}
            onClick={() => void syncNow().then(() => setTick((t) => t + 1))}
          >
            {syncing ? "Syncing…" : "Sync now"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={syncing || failedCount === 0}
            onClick={() => void retryFailed().then(() => setTick((t) => t + 1))}
          >
            Re-queue reviewed ({failedCount})
          </Button>
        </div>

        <div className="space-y-1">
          {history.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No offline transactions recorded on this device.
            </p>
          )}
          {history.map((entry) => (
            <div
              key={entry.clientSaleId}
              className="rounded-md border p-2 text-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">
                  ৳{entry.summary.total.toFixed(2)} · {entry.summary.itemCount}{" "}
                  item(s)
                  {entry.summary.customerName
                    ? ` · ${entry.summary.customerName}`
                    : ""}
                </span>
                {entry.status === "pending" && (
                  <Badge variant="outline" className="border-blue-500 text-blue-600">
                    Pending
                  </Badge>
                )}
                {entry.status === "synced" && (
                  <Badge variant="outline" className="border-emerald-600 text-emerald-700">
                    Synced {entry.invoiceNumber ?? ""}
                  </Badge>
                )}
                {entry.status === "failed" && (
                  <Badge variant="destructive">Review required</Badge>
                )}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                Recorded {new Date(entry.recordedAt).toLocaleString()} ·{" "}
                {entry.attempts} attempt(s)
                {entry.lastError ? ` · ${entry.lastError}` : ""}
              </div>
            </div>
          ))}
        </div>

        {log.length > 0 && (
          <div className="rounded-md border p-2">
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              Event log
            </div>
            <div className="max-h-32 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
              {log.map((entry, index) => (
                <div key={`${entry.at}-${index}`}>
                  {new Date(entry.at).toLocaleTimeString()} — {entry.detail}
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface ConflictRow {
  id: number;
  opType: string;
  reason: string;
  message: string;
  status: string;
  createdAt: string;
}

/** Phase 3: server-flagged sync conflicts (allocation overages, negative
 * stock, batch gaps, capped refunds) with manager acknowledgment. */
function ConflictSection() {
  const [conflicts, setConflicts] = useState<ConflictRow[] | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<{ data: ConflictRow[] }>("/offline/conflicts")
      .then((res) => {
        if (!cancelled) setConflicts(res.data.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setConflicts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const openConflicts = (conflicts ?? []).filter((c) => c.status === "open");
  if (conflicts === null || openConflicts.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
      <div className="text-sm font-semibold text-amber-900">
        Conflicts needing review ({openConflicts.length})
      </div>
      <div className="mt-2 space-y-2">
        {openConflicts.map((conflict) => (
          <div
            key={conflict.id}
            className="rounded-md border border-amber-200 bg-white p-2 text-sm"
          >
            <div className="font-medium">{conflict.reason}</div>
            <div className="text-slate-600">{conflict.message}</div>
            <div className="mt-1 flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void api
                    .post(`/offline/conflicts/${conflict.id}/resolve`, {
                      action: "discard",
                    })
                    .then(() => setTick((t) => t + 1));
                }}
              >
                Acknowledge
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
