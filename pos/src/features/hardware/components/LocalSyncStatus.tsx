import { useEffect, useState } from "react";
import api from "../../../api/axios.js";
import { formatDateTime } from "@/features/reports/utils/reportUtils";

interface SyncStatusData {
  agentEnabled: boolean;
  pendingCount: number;
  streams: {
    stream: string;
    cursor: string | null;
    lastPushAt: string | null;
    lastPullAt: string | null;
    lastError: string | null;
    updatedAt: string | null;
  }[];
}

/**
 * Local server sync card (multi-terminal Phase 2). Rendered on the
 * hardware settings page; meaningful only on a LAN server
 * (agentEnabled=true). On the cloud the endpoint reports agentEnabled
 * false and no streams — the card hides itself.
 */
export function LocalSyncStatus() {
  const [status, setStatus] = useState<SyncStatusData | null>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.get<{ data: SyncStatusData }>("/sync/status");
        if (!cancelled) {
          const data = res.data.data;
          if (!data.agentEnabled && (data.streams?.length ?? 0) === 0) {
            setGone(true); // cloud deployment — nothing to show
          } else {
            setStatus(data);
          }
        }
      } catch {
        if (!cancelled) setGone(true); // endpoint unavailable — hide quietly
      }
    };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (gone || !status) return null;

  return (
    <div className="space-y-2 rounded-xl border border-slate-200 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">Local server sync</h3>
          <p className="text-sm text-slate-500">
            This machine is the shop's LAN server. It pushes sales to the
            cloud and pulls identity, catalog and stock.
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            status.pendingCount === 0
              ? "bg-emerald-50 text-emerald-700"
              : "bg-amber-50 text-amber-700"
          }`}
        >
          {status.pendingCount === 0
            ? "All sales synced"
            : `Pending: ${status.pendingCount}`}
        </span>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <th className="py-1">Stream</th>
            <th className="py-1">Last push</th>
            <th className="py-1">Last pull</th>
            <th className="py-1">Error</th>
          </tr>
        </thead>
        <tbody>
          {status.streams.map((stream) => (
            <tr key={stream.stream} className="border-t border-slate-100">
              <td className="py-1.5 font-medium">{stream.stream}</td>
              <td className="py-1.5 text-slate-500">
                {stream.lastPushAt ? formatDateTime(stream.lastPushAt) : "—"}
              </td>
              <td className="py-1.5 text-slate-500">
                {stream.lastPullAt ? formatDateTime(stream.lastPullAt) : "—"}
              </td>
              <td className="py-1.5 text-rose-600">{stream.lastError ?? "—"}</td>
            </tr>
          ))}
          {status.streams.length === 0 ? (
            <tr>
              <td className="py-2 text-slate-400" colSpan={4}>
                No sync activity yet — waiting for the first sweep.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
