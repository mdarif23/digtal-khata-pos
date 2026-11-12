import { useCallback, useEffect, useState } from "react";
import { Download, Search } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  exportAuditLogApi,
  getAuditLogApi,
  type AuditLogFilters,
  type AuditLogRow,
} from "./audit.api";

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

const PAGE_SIZE = 50;

function formatJson(value: Record<string, unknown> | null): string {
  if (!value || Object.keys(value).length === 0) return "—";
  return JSON.stringify(value, null, 2);
}

/**
 * Centralized audit trail view (Phase 1): search/filter the append-only
 * audit log, inspect before/after snapshots, and export a guarded CSV.
 * Backend gates every row by audit.view; the export needs audit.export.
 */
export function AuditLogsPage() {
  const [rows, setRows] = useState<AuditLogRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [detail, setDetail] = useState<AuditLogRow | null>(null);

  const [actionPrefix, setActionPrefix] = useState("");
  const [entityType, setEntityType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const filters: AuditLogFilters = {
    ...(actionPrefix.trim() ? { actionPrefix: actionPrefix.trim() } : {}),
    ...(entityType.trim() ? { entityType: entityType.trim() } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit: PAGE_SIZE,
    offset,
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAuditLogApi(filters);
      setRows(data.rows);
      setTotal(data.total);
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to load the audit log."), type: "error" });
      setRows([]);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionPrefix, entityType, from, to, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleExport() {
    setExporting(true);
    try {
      await exportAuditLogApi(filters);
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to export the audit log."), type: "error" });
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="grid gap-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Audit log</h1>
          <p className="text-sm text-muted-foreground">
            Append-only activity trail — cash, registers, sales, users, roles
            and more.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => void handleExport()}
          disabled={exporting}
        >
          {exporting ? <Spinner className="size-4" /> : <Download className="size-4" />}
          Export CSV
        </Button>
      </div>

      <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
        <div className="grid gap-1.5">
          <Label htmlFor="audit-prefix">Event</Label>
          <div className="relative">
            <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
            <Input
              id="audit-prefix"
              placeholder="e.g. cash, register, sale"
              className="pl-8"
              value={actionPrefix}
              onChange={(e) => {
                setActionPrefix(e.target.value);
                setOffset(0);
              }}
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="audit-entity">Entity type</Label>
          <Input
            id="audit-entity"
            placeholder="e.g. register_session"
            value={entityType}
            onChange={(e) => {
              setEntityType(e.target.value);
              setOffset(0);
            }}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="audit-from">From</Label>
          <Input
            id="audit-from"
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setOffset(0);
            }}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="audit-to">To</Label>
          <Input
            id="audit-to"
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setOffset(0);
            }}
          />
        </div>
      </div>

      {rows === null || loading ? (
        <div className="grid gap-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No audit events match these filters.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="p-2 font-medium">When</th>
                <th className="p-2 font-medium">Event</th>
                <th className="p-2 font-medium">Entity</th>
                <th className="p-2 font-medium">Actor</th>
                <th className="p-2 font-medium">Location</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="cursor-pointer border-t hover:bg-muted/40"
                  onClick={() => setDetail(row)}
                >
                  <td className="p-2 text-xs whitespace-nowrap text-muted-foreground">
                    {row.createdAt ? new Date(row.createdAt).toLocaleString() : "—"}
                  </td>
                  <td className="p-2">
                    <Badge variant="outline" className="font-mono text-xs">
                      {row.action}
                    </Badge>
                  </td>
                  <td className="p-2 font-mono text-xs">
                    {row.entityType}
                    {row.entityId !== null ? `#${row.entityId}` : ""}
                  </td>
                  <td className="p-2">
                    {row.actorName ?? "System"}
                    {row.actorRole ? (
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({row.actorRole})
                      </span>
                    ) : null}
                  </td>
                  <td className="p-2 text-xs text-muted-foreground">
                    {row.locationName ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          Showing {rows === null ? 0 : Math.max(rows.length, 0)} of {total}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={rows === null || offset + PAGE_SIZE >= total || loading}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      </div>

      <Dialog open={detail !== null} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono text-base">
              {detail?.action}
            </DialogTitle>
            <DialogDescription>
              {detail
                ? `${detail.entityType}${detail.entityId !== null ? `#${detail.entityId}` : ""} · ${detail.createdAt ? new Date(detail.createdAt).toLocaleString() : ""}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {detail ? (
            <div className="grid gap-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-xs text-muted-foreground">Actor</div>
                  <div>
                    {detail.actorName ?? "System"}
                    {detail.actorRole ? ` (${detail.actorRole})` : ""}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Location</div>
                  <div>{detail.locationName ?? "—"}</div>
                </div>
                {detail.requestId ? (
                  <div className="col-span-2">
                    <div className="text-xs text-muted-foreground">Request</div>
                    <div className="font-mono text-xs">{detail.requestId}</div>
                  </div>
                ) : null}
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  Details
                </div>
                <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
                  {formatJson(detail.metadata)}
                </pre>
              </div>
              {detail.beforeState || detail.afterState ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">
                      Before
                    </div>
                    <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
                      {formatJson(detail.beforeState)}
                    </pre>
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">
                      After
                    </div>
                    <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
                      {formatJson(detail.afterState)}
                    </pre>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
