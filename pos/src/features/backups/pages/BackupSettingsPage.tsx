import { useState } from "react";
import {
  CloudUpload,
  DatabaseBackup,
  Download,
  Loader2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useBackups, useDeleteBackup, useVerifyBackup } from "../hooks/useBackups";
import type { BackupRow } from "../backups.api";
import { BackupNowDialog } from "../components/BackupNowDialog";
import { BackupScheduleCard } from "../components/BackupScheduleCard";
import { BackupUploadDialog, downloadBackup } from "../components/BackupUploadDialog";
import { RestoreDialog } from "../components/RestoreDialog";
import { useOfflineStore } from "../../pos/offline/offlineStore";
import { listOutbox } from "../../pos/offline/db";
import { getErrorMessage } from "@/utils/getErrorMessage";

function formatBytes(bytes: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function statusBadge(status: BackupRow["status"]) {
  const variant =
    status === "completed"
      ? "default"
      : status === "failed"
        ? "destructive"
        : "secondary";
  return <Badge variant={variant}>{status}</Badge>;
}

/**
 * /settings/backup — BackupOverview (status cards), BackupNowDialog,
 * BackupScheduleSettings, BackupHistoryTable + details/restore/upload.
 * Phase K: destructive restore is blocked on this page while the device
 * holds unsynced offline sales.
 */
export default function BackupSettingsPage() {
  const backups = useBackups({ page: 1, pageSize: 50 });
  const verify = useVerifyBackup();
  const remove = useDeleteBackup();
  const pendingCount = useOfflineStore((s) => s.pendingCount);

  const [nowOpen, setNowOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [details, setDetails] = useState<BackupRow | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupRow | null>(null);

  const items = (backups.data?.items ?? []).filter(
    (b) => b.status !== "deleted" && b.status !== "expired",
  );
  const completed = items.filter((b) => b.status === "completed");
  const totalBytes = completed.reduce((sum, b) => sum + (b.fileSize ?? 0), 0);
  const latest = completed[0];

  const exportUnsynced = async () => {
    const entries = await listOutbox();
    const pending = entries.filter((e) => e.status === "pending" || e.status === "failed");
    if (pending.length === 0) {
      toast.add({ title: "No unsynced sales to export", type: "info" });
      return;
    }
    const blob = new Blob([JSON.stringify(pending, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ezpos-unsynced-sales-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Backup &amp; Restore</h1>
          <p className="text-sm text-muted-foreground">
            Encrypted business backups — create, schedule, download, upload and restore.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setUploadOpen(true)}>
            <CloudUpload className="mr-2 h-4 w-4" /> Upload package
          </Button>
          <Button onClick={() => setNowOpen(true)}>
            <DatabaseBackup className="mr-2 h-4 w-4" /> Back up now
          </Button>
        </div>
      </div>

      {pendingCount > 0 && (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <span className="font-medium">{pendingCount} sale(s) recorded offline are not synced yet.</span>{" "}
          They live only in this browser — sync from the POS screen, or{" "}
          <button className="underline" onClick={() => void exportUnsynced()}>
            export them as JSON
          </button>{" "}
          before restoring older data.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Latest backup</CardDescription>
            <CardTitle className="text-base">
              {latest
                ? new Date(latest.createdAt).toLocaleString()
                : "No completed backup yet"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {latest?.verifiedAt
              ? `Verified ${new Date(latest.verifiedAt).toLocaleString()}`
              : latest
                ? "Not re-verified since creation"
                : "Create one with “Back up now”."}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Storage used</CardDescription>
            <CardTitle className="text-base">{formatBytes(totalBytes)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {completed.length} completed backup(s) · private, encrypted storage
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Protection</CardDescription>
            <CardTitle className="flex items-center gap-1.5 text-base">
              <ShieldCheck className="h-4 w-4 text-success" /> AES-256-GCM
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Packages are compressed, encrypted and checksummed; integrity is
            verified before a backup counts as completed.
          </CardContent>
        </Card>
      </div>

      <BackupScheduleCard />

      <Card>
        <CardHeader>
          <CardTitle>Backup history</CardTitle>
          <CardDescription>
            Downloads use short-lived authorized links. The newest completed
            backup can never be deleted (last known-good protection).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {backups.isLoading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading history…
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              No backups yet — create the first one with “Back up now”.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="whitespace-nowrap">
                      {new Date(b.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{b.type}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {statusBadge(b.status)}
                        {(b.status === "pending" || b.status === "running") && (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        )}
                      </div>
                      {b.error && (
                        <div className="mt-1 max-w-64 truncate text-xs text-destructive" title={b.error}>
                          {b.error}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>{formatBytes(b.fileSize)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDetails(b)}
                        >
                          Details
                        </Button>
                        {b.status === "completed" && (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void downloadBackup(b.id, b.fileName)}
                            >
                              <Download className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setRestoreTarget(b)}
                            >
                              Restore
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <BackupNowDialog open={nowOpen} onOpenChange={setNowOpen} />
      <BackupUploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />
      <RestoreDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => !open && setRestoreTarget(null)}
        backup={restoreTarget}
      />
      <BackupDetailsDialog
        backup={details}
        onClose={() => setDetails(null)}
        onRestore={(b) => {
          setDetails(null);
          setRestoreTarget(b);
        }}
      />
    </div>
  );
}

function BackupDetailsDialog(props: {
  backup: BackupRow | null;
  onClose: () => void;
  onRestore: (b: BackupRow) => void;
}) {
  const verify = useVerifyBackup();
  const remove = useDeleteBackup();

  const manifest = props.backup?.manifest;
  const counts = Object.entries(manifest?.recordCounts ?? {})
    .filter(([, v]) => v > 0)
    .slice(0, 24);

  return (
    <Dialog open={props.backup !== null} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{props.backup?.fileName ?? `Backup #${props.backup?.id}`}</DialogTitle>
          <DialogDescription>
            {props.backup?.type} · {formatBytes(props.backup?.fileSize ?? null)} ·{" "}
            {props.backup?.verifiedAt ? "verified" : "not re-verified"}
          </DialogDescription>
        </DialogHeader>
        {manifest && (
          <div className="grid gap-2 text-sm">
            <div className="text-muted-foreground">
              Created {new Date(manifest.createdAt).toLocaleString()} · app v
              {manifest.appVersion} · format v{manifest.formatVersion} · modules:{" "}
              {manifest.modules.join(", ")}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
              {counts.map(([table, count]) => (
                <div key={table} className="flex justify-between gap-2">
                  <span className="truncate text-muted-foreground" title={table}>
                    {table}
                  </span>
                  <span>{count}</span>
                </div>
              ))}
            </div>
            {manifest.warnings.length > 0 && (
              <div className="rounded-md border p-2 text-xs text-muted-foreground">
                {manifest.warnings.map((w, i) => (
                  <div key={i}>⚠ {w}</div>
                ))}
              </div>
            )}
          </div>
        )}
        {props.backup?.error && (
          <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-sm">
            {props.backup.error}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {props.backup?.status === "completed" && (
            <>
              <Button
                variant="outline"
                disabled={verify.isPending}
                onClick={() =>
                  verify.mutate(props.backup!.id, {
                    onSuccess: (r) =>
                      toast.add({
                        title: r.verified ? "Integrity verified" : "Verification FAILED",
                        description: r.error,
                        type: r.verified ? "success" : "error",
                      }),
                    onError: (err) =>
                      toast.add({ title: "Verification error", description: getErrorMessage(err), type: "error" }),
                  })
                }
              >
                {verify.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Verify
              </Button>
              <Button variant="outline" onClick={() => props.onRestore(props.backup!)}>
                Restore
              </Button>
            </>
          )}
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => {
              if (!props.backup) return;
              remove.mutate(props.backup.id, {
                onSuccess: () => {
                  toast.add({ title: "Backup deleted", type: "success" });
                  props.onClose();
                },
                onError: (err) =>
                  toast.add({ title: "Delete refused", description: getErrorMessage(err), type: "error" }),
              });
            }}
          >
            {remove.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
            Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
