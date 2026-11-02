"use client";

import { useCallback, useEffect, useState } from "react";
import { API_BASE, getAccessToken } from "@/lib/api/auth";

interface AuditLog {
  id: number;
  adminName: string;
  adminEmail: string;
  action: string;
  entityType: string;
  entityId: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

const ENTITY_FILTERS = ["", "business", "subscription", "ticket", "system"] as const;

export function AdminAuditLogs() {
  const [logs, setLogs] = useState<AuditLog[] | null>(null);
  const [entityFilter, setEntityFilter] = useState<string>("");

  const reload = useCallback(async (entityType: string) => {
    const token = getAccessToken();
    let res: Response;
    try {
      res = await fetch(
        `${API_BASE}/api/saas/audit-logs${
          entityType ? `?entityType=${entityType}` : ""
        }`,
        { headers: { Authorization: `Bearer ${token ?? ""}` } },
      );
    } catch {
      setLogs([]);
      return;
    }
    const body = (await res.json().catch(() => null)) as {
      data?: AuditLog[];
    } | null;
    setLogs(res.ok ? (body?.data ?? []) : []);
  }, []);

  useEffect(() => {
    void (async () => {
      await reload(entityFilter);
    })();
  }, [reload, entityFilter]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-slate-900">
          Audit logs
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Every administrative action with who, what, and when. Rows are
          append-only.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {ENTITY_FILTERS.map((entity) => (
          <button
            key={entity || "all"}
            type="button"
            className={
              entityFilter === entity
                ? "rounded-full bg-indigo-600 px-3 py-1 text-xs font-medium text-white"
                : "rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 hover:border-slate-400"
            }
            onClick={() => setEntityFilter(entity)}
          >
            {entity || "all"}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        {logs === null ? (
          <p className="px-5 py-8 text-sm text-slate-500">Loading…</p>
        ) : logs.length === 0 ? (
          <p className="px-5 py-8 text-sm text-slate-500">No audit entries.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-5 py-2 font-medium">Action</th>
                <th className="px-5 py-2 font-medium">Admin</th>
                <th className="px-5 py-2 font-medium">Entity</th>
                <th className="px-5 py-2 font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {logs.map((log) => (
                <tr key={log.id}>
                  <td className="px-5 py-3 font-medium text-slate-900">
                    {log.action}
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {log.adminName}
                    <span className="block text-xs text-slate-400">
                      {log.adminEmail}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {log.entityType}
                    {log.entityId ? ` #${log.entityId}` : ""}
                  </td>
                  <td className="px-5 py-3 text-slate-600">
                    {new Date(log.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
