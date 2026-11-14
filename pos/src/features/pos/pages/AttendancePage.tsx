import { useCallback, useEffect, useState } from "react";
import { getErrorMessage } from "@/utils/getErrorMessage";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import { PageHeader } from "@/components/common/PageHeader.js";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { usePermissions } from "@/hooks/usePermissions";
import { toast } from "@/components/ui/toast.js";
import axios from "../../../api/axios.js";

interface AttendanceStatus {
  clockedIn: boolean;
  onBreak: boolean;
  recordId: number | null;
  clockIn: string | null;
  openBreakStartedAt: string | null;
}

interface MyRecord {
  id: number;
  clockIn: string;
  clockOut: string | null;
  workedHours: number | null;
  approvedAt: string | null;
}

interface AllRecord {
  id: number;
  userName: string;
  clockIn: string;
  clockOut: string | null;
  workedHours: number | null;
  approvedAt: string | null;
}

interface SummaryRow {
  userName: string;
  shifts: number;
  workedHours: number;
  breakHours: number;
}

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString() : "—";

/**
 * Attendance / timeclock (Module 8): self-service clock in/out with breaks;
 * managers see all records, approve them, and read the hours summary.
 * Records are immutable once clocked out — approval is a signal, never a
 * time edit.
 */
export function AttendancePage() {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("attendance.manage");

  const [status, setStatus] = useState<AttendanceStatus | null>(null);
  const [history, setHistory] = useState<MyRecord[] | null>(null);
  const [allRecords, setAllRecords] = useState<AllRecord[] | null>(null);
  const [summary, setSummary] = useState<SummaryRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const statusRes = await axios.get<{ data: AttendanceStatus }>(
        "/attendance/me",
      );
      setStatus(statusRes.data.data);
      const historyRes = await axios.get<{ data: MyRecord[] }>(
        "/attendance/me/history",
      );
      setHistory(historyRes.data.data);
      if (canManage) {
        const [allRes, summaryRes] = await Promise.all([
          axios.get<{ data: AllRecord[] }>("/attendance"),
          axios.get<{ data: SummaryRow[] }>("/attendance/summary?days=30"),
        ]);
        setAllRecords(allRes.data.data);
        setSummary(summaryRes.data.data);
      }
    } catch {
      toast.add({ type: "error", description: "Could not load attendance." });
    }
  }, [canManage]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(path: string, body?: unknown) {
    setBusy(true);
    try {
      await axios.post(path, body ?? {});
      await load();
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
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-6">
      <PageHeader
        title="Attendance"
        description="Clock in at the start of your shift, take breaks as needed, and clock out at the end. Records are immutable once clocked out — managers approve them."
      />
      <Card>
        <CardContent className="space-y-3 pt-0">
          {status === null ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
              <Badge variant={status.clockedIn ? "default" : "secondary"}>
                {status.clockedIn
                  ? status.onBreak
                    ? "On break"
                    : "Clocked in"
                  : "Clocked out"}
              </Badge>
              {status.clockedIn && (
                <span className="text-sm text-muted-foreground">
                  Since {fmt(status.clockIn)}
                  {status.onBreak
                    ? ` · break started ${fmt(status.openBreakStartedAt)}`
                    : ""}
                </span>
              )}
              <div className="ml-auto flex gap-2">
                {!status.clockedIn ? (
                  <Button disabled={busy} onClick={() => void act("/attendance/clock-in", { note: null })}>
                    Clock in
                  </Button>
                ) : (
                  <>
                    {status.onBreak ? (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void act("/attendance/break/end")}
                      >
                        End break
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void act("/attendance/break/start")}
                      >
                        Start break
                      </Button>
                    )}
                    <Button
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void act("/attendance/clock-out", { note: null })}
                    >
                      Clock out
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}

          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-2 font-medium">Clock in</th>
                  <th className="p-2 font-medium">Clock out</th>
                  <th className="p-2 text-right font-medium">Hours</th>
                  <th className="p-2 font-medium">Approved</th>
                </tr>
              </thead>
              <tbody>
                {(history ?? []).map((record) => (
                  <tr key={record.id} className="border-t">
                    <td className="p-2">{fmt(record.clockIn)}</td>
                    <td className="p-2">{fmt(record.clockOut)}</td>
                    <td className="p-2 text-right font-mono">
                      {record.workedHours ?? "—"}
                    </td>
                    <td className="p-2">
                      {record.approvedAt ? "✓" : "—"}
                    </td>
                  </tr>
                ))}
                {history !== null && history.length === 0 && (
                  <tr>
                    <td colSpan={4} className="p-4 text-center text-muted-foreground">
                      No records yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {canManage && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">All records</CardTitle>
              <CardDescription>
                Approve records after reviewing — approval never edits times.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="p-2 font-medium">Employee</th>
                    <th className="p-2 font-medium">Clock in</th>
                    <th className="p-2 font-medium">Clock out</th>
                    <th className="p-2 text-right font-medium">Hours</th>
                    <th className="p-2 text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {(allRecords ?? []).map((record) => (
                    <tr key={record.id} className="border-t">
                      <td className="p-2">{record.userName}</td>
                      <td className="p-2">{fmt(record.clockIn)}</td>
                      <td className="p-2">{fmt(record.clockOut)}</td>
                      <td className="p-2 text-right font-mono">
                        {record.workedHours ?? "—"}
                      </td>
                      <td className="p-2 text-right">
                        {record.approvedAt ? (
                          <Badge variant="outline">Approved</Badge>
                        ) : record.clockOut ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              void act(`/attendance/${record.id}/approve`)
                            }
                          >
                            Approve
                          </Button>
                        ) : (
                          <Badge variant="secondary">Open</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Hours (last 30 days)</CardTitle>
              <CardDescription>
                Worked hours net of breaks, per employee.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="p-2 font-medium">Employee</th>
                    <th className="p-2 text-right font-medium">Shifts</th>
                    <th className="p-2 text-right font-medium">Worked</th>
                    <th className="p-2 text-right font-medium">Breaks</th>
                  </tr>
                </thead>
                <tbody>
                  {(summary ?? []).map((row) => (
                    <tr key={row.userName} className="border-t">
                      <td className="p-2">{row.userName}</td>
                      <td className="p-2 text-right font-mono">{row.shifts}</td>
                      <td className="p-2 text-right font-mono">
                        {row.workedHours.toFixed(1)}h
                      </td>
                      <td className="p-2 text-right font-mono">
                        {row.breakHours.toFixed(1)}h
                      </td>
                    </tr>
                  ))}
                  {summary !== null && summary.length === 0 && (
                    <tr>
                      <td colSpan={4} className="p-4 text-center text-muted-foreground">
                        No completed shifts in this window.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
