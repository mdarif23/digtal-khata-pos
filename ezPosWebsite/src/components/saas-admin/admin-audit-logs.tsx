"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  fetchAuditLogs,
  type AdminAuditLog,
} from "@/lib/api/saas-admin";

function formatAction(action: string): string {
  return action.replaceAll("_", " ");
}

function formatMetadata(metadata: Record<string, unknown> | null): string {
  if (!metadata || Object.keys(metadata).length === 0) return "";
  return Object.entries(metadata)
    .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join(" · ");
}

export function AdminAuditLogs() {
  const [logs, setLogs] = useState<AdminAuditLog[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const reload = useCallback(async () => {
    const result = await fetchAuditLogs({ limit: 200 });
    if (result.ok && result.data) {
      setLogs(result.data);
      setLoadError(null);
    } else if (result.data === undefined) {
      setLoadError(result.message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">
            Audit logs
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Every admin-panel action — plan changes, suspensions, extensions —
            is recorded here as it happens.
          </p>
        </div>
        <Button variant="outline" onClick={() => void reload()}>
          Refresh
        </Button>
      </div>

      {loadError ? (
        <Alert tone="warning" title="Could not load audit logs">
          {loadError}
        </Alert>
      ) : null}

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        {logs === null && !loadError ? (
          <p className="px-5 py-8 text-sm text-slate-500">Loading…</p>
        ) : logs !== null && logs.length === 0 ? (
          <p className="px-5 py-8 text-sm text-slate-500">
            No admin actions recorded yet.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-5 py-2 font-medium">When</th>
                <th className="px-5 py-2 font-medium">Admin</th>
                <th className="px-5 py-2 font-medium">Action</th>
                <th className="px-5 py-2 font-medium">Entity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(logs ?? []).map((log) => {
                const detail = formatMetadata(log.metadata);
                const expanded = expandedId === log.id;
                return (
                  <tr
                    key={log.id}
                    className={detail ? "cursor-pointer" : undefined}
                    onClick={detail ? () => setExpandedId(expanded ? null : log.id) : undefined}
                  >
                    <td className="whitespace-nowrap px-5 py-3 text-slate-600">
                      {new Date(log.createdAt).toLocaleString()}
                    </td>
                    <td className="px-5 py-3 text-slate-600">
                      {log.adminName ?? log.adminEmail}
                      <span className="block text-xs text-slate-400">{log.adminEmail}</span>
                    </td>
                    <td className="px-5 py-3 font-medium text-slate-800">
                      {formatAction(log.action)}
                    </td>
                    <td className="px-5 py-3 text-slate-600">
                      {log.entityType}
                      {log.entityId !== null ? ` #${log.entityId}` : ""}
                      {detail ? (
                        expanded ? (
                          <span className="mt-1 block max-w-xl whitespace-pre-wrap break-words text-xs text-slate-500">
                            {detail}
                          </span>
                        ) : (
                          <span className="block text-xs text-slate-400">
                            click for details
                          </span>
                        )
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
