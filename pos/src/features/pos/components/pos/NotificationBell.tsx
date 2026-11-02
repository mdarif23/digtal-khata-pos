import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import axios from "@/api/axios";

/**
 * Notification center bell (Module 14): unread badge refreshed on the
 * realtime `notification.created` signal, panel with the history and
 * read/mute actions. Signals are advisory — the list is refetched through
 * the API.
 */

interface NotificationRow {
  id: number;
  kind: string;
  severity: string;
  title: string;
  body: string | null;
  createdAt: string;
  readAt: string | null;
}

export function NotificationBell({ revision }: { revision: number }) {
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NotificationRow[] | null>(null);

  const loadUnread = useCallback(async () => {
    try {
      const res = await axios.get<{ data: { count: number } }>(
        "/notifications/unread-count",
      );
      setUnread(Number(res.data.data.count));
    } catch {
      // Offline — badge just goes stale.
    }
  }, []);

  const loadList = useCallback(async () => {
    try {
      const res = await axios.get<{ data: NotificationRow[] }>("/notifications");
      setRows(res.data.data);
    } catch {
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void loadUnread();
  }, [loadUnread, revision]);

  useEffect(() => {
    if (open) void loadList();
  }, [open, loadList]);

  async function markRead(id: number) {
    await axios.post("/notifications/read", { ids: [id] }).catch(() => null);
    await Promise.all([loadUnread(), loadList()]);
  }

  async function markAll() {
    await axios.post("/notifications/read-all").catch(() => null);
    await Promise.all([loadUnread(), loadList()]);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ""}`}
        className="relative rounded-md border px-2 py-1 text-sm hover:bg-muted"
      >
        🔔
        {unread > 0 && (
          <span className="absolute -right-1.5 -top-1.5">
            <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
              {unread > 99 ? "99+" : unread}
            </Badge>
          </span>
        )}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Notifications</DialogTitle>
            <DialogDescription>
              Generated from real events — stock, expiring inventory, register
              discrepancies, integration failures. Muted kinds are hidden.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={() => void markAll()}>
              Mark all read
            </Button>
          </div>
          {rows === null ? (
            <Skeleton className="h-48 w-full" />
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing here — all quiet.
            </p>
          ) : (
            <div className="space-y-1">
              {rows.map((row) => (
                <div
                  key={row.id}
                  className={`rounded-md border p-2 text-sm ${
                    row.readAt === null ? "border-primary/40" : "opacity-70"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium">
                        {row.severity === "critical" && "🔴 "}
                        {row.severity === "warning" && "🟠 "}
                        {row.title}
                      </div>
                      {row.body && (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {row.body}
                        </div>
                      )}
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {new Date(row.createdAt).toLocaleString()}
                      </div>
                    </div>
                    {row.readAt === null && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void markRead(row.id)}
                      >
                        Mark read
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
