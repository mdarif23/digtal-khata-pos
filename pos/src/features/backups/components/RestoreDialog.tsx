import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRestore, useRestoreJob, useRestorePreview } from "../hooks/useBackups";
import { useOfflineStore } from "../../pos/offline/offlineStore";
import type { BackupRow, RestoreResult } from "../backups.api";
import { getErrorMessage } from "@/utils/getErrorMessage";

type Mode = "full" | "new_business" | "selective";

const MODES: Array<{ value: Mode; label: string; hint: string }> = [
  {
    value: "full",
    label: "Full restore (this business)",
    hint: "Replaces this business's data with the backup. A safety backup is taken first; rows created after the backup are removed.",
  },
  {
    value: "new_business",
    label: "Restore into a NEW business",
    hint: "Creates a fresh business from the package with all references remapped. Staff and subscriptions are not imported.",
  },
  {
    value: "selective",
    label: "Selective modules",
    hint: "Upserts only the chosen modules — never deletes rows outside them.",
  },
];

/**
 * Restore wizard: mode → preview (integrity + identity checks) → typed
 * confirmation → progress → verification report.
 *
 * Phase K gate: destructive restore is refused while this device still has
 * unsynced offline sales — sync first (they would be lost by a restore of
 * older data).
 */
export function RestoreDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  backup: BackupRow | null;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [jobId, setJobId] = useState<number | null>(null);
  const pendingCount = useOfflineStore((s) => s.pendingCount);
  const preview = useRestorePreview({
    backupId: mode ? (props.backup?.id ?? null) : null,
    mode,
  });
  const restore = useRestore();
  const job = useRestoreJob(jobId);

  useEffect(() => {
    if (!props.open) {
      setMode(null);
      setConfirmText("");
      setJobId(null);
    }
  }, [props.open]);

  const blockingCheckFailed =
    preview.data && !preview.data.checks.every((c) => c.ok);

  const run = () => {
    if (!props.backup || !mode) return;
    restore.mutate(
      { backupId: props.backup.id, mode },
      {
        onSuccess: (job) => {
          setJobId(job.id);
          toast.add({
            title: "Restore started",
            description: "You will be notified when it finishes.",
            type: "success",
          });
        },
        onError: (err) =>
          toast.add({ title: "Restore failed to start", description: getErrorMessage(err), type: "error" }),
      },
    );
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Restore from backup</DialogTitle>
          <DialogDescription>
            {props.backup?.fileName ?? `Backup #${props.backup?.id}`} —{" "}
            {props.backup?.manifest?.createdAt
              ? new Date(props.backup.manifest.createdAt).toLocaleString()
              : ""}
          </DialogDescription>
        </DialogHeader>

        {jobId !== null ? (
          <RestoreProgress jobId={jobId} onDone={() => props.onOpenChange(false)} />
        ) : (
          <>
            {pendingCount > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600" />
                <span>
                  This device has <strong>{pendingCount} unsynced sale(s)</strong>.
                  Restore is blocked until they sync — open the POS screen and let
                  the sync finish, or export them from the sync panel first.
                </span>
              </div>
            )}

            <div className="grid gap-2">
              {MODES.map((m) => (
                <Label
                  key={m.value}
                  className="flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm font-normal data-[state=checked]:border-primary"
                  onClick={() => setMode(m.value)}
                >
                  <span className="flex items-center gap-2 font-medium">
                    <input
                      type="radio"
                      checked={mode === m.value}
                      onChange={() => setMode(m.value)}
                    />
                    {m.label}
                  </span>
                  <span className="text-xs text-muted-foreground">{m.hint}</span>
                </Label>
              ))}
            </div>

            {preview.isFetching && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Checking the package…
              </div>
            )}
            {preview.isError && (
              <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
                {getErrorMessage(preview.error)}
              </div>
            )}
            {preview.data && (
              <div className="grid gap-2">
                <div className="grid gap-1 rounded-md border p-3 text-sm">
                  <div className="font-medium">Preview</div>
                  <div className="text-muted-foreground">
                    {preview.data.manifest.businessName} · {new Date(preview.data.manifest.createdAt).toLocaleString()} · v{preview.data.manifest.appVersion}
                  </div>
                  <div className="text-muted-foreground">
                    Products {preview.data.manifest.recordCounts["products"] ?? 0} · Sales {preview.data.manifest.recordCounts["sales"] ?? 0} · Customers {preview.data.manifest.recordCounts["customers"] ?? 0}
                  </div>
                </div>
                {preview.data.checks.map((c) => (
                  <div key={c.check} className="flex items-start gap-2 text-sm">
                    <Badge variant={c.ok ? "default" : "destructive"}>
                      {c.ok ? "PASS" : "BLOCK"}
                    </Badge>
                    <span className="text-muted-foreground">{c.detail}</span>
                  </div>
                ))}
                {preview.data.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm">
                    <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}

            {!blockingCheckFailed && preview.data?.readyForRestore && mode && (
              <div className="grid gap-2">
                <Label htmlFor="restore-confirm" className="text-sm">
                  Type <strong>RESTORE</strong> to confirm this destructive
                  operation.
                </Label>
                <Input
                  id="restore-confirm"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="RESTORE"
                />
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => props.onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={
                  !mode ||
                  !preview.data?.readyForRestore ||
                  pendingCount > 0 ||
                  confirmText !== "RESTORE" ||
                  restore.isPending
                }
                onClick={run}
              >
                {restore.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Restore now
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RestoreProgress(props: { jobId: number; onDone: () => void }) {
  const job = useRestoreJob(props.jobId);
  const status = job.data?.status;
  const result = job.data?.result as RestoreResult | null;

  return (
    <div className="grid gap-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        {["pending", "validating", "running", "verifying"].includes(status ?? "") && (
          <Loader2 className="h-4 w-4 animate-spin" />
        )}
        <span className="font-medium capitalize">{status ?? "starting"}</span>
        {job.data?.stage && (
          <span className="text-muted-foreground">— {job.data.stage}</span>
        )}
      </div>
      {job.data?.progress?.percent !== undefined && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${Math.min(100, job.data.progress.percent)}%` }}
          />
        </div>
      )}
      {status === "failed" && (
        <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
          {job.data?.error ?? "Restore failed."}
        </div>
      )}
      {status === "completed" && result && (
        <RestoreResultSummary result={result} />
      )}
      <div className="flex justify-end">
        <Button variant="outline" onClick={props.onDone}>
          Close
        </Button>
      </div>
    </div>
  );
}

export function RestoreResultSummary(props: { result: RestoreResult }) {
  const { result } = props;
  const mismatched = result.countMismatches ?? [];
  return (
    <div className="grid gap-2 text-sm">
      <div className="rounded-md border border-emerald-500/50 bg-emerald-500/10 p-3">
        Restore <strong>{result.mode}</strong> completed and verified.
        {mismatched.length > 0 && (
          <span> {mismatched.length} count mismatch(es) — review below.</span>
        )}
      </div>
      {mismatched.length > 0 && (
        <div className="rounded-md border p-3">
          <div className="font-medium">Count mismatches</div>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {mismatched.map((c) => (
              <li key={c.table}>
                {c.table}: expected {c.expected}, found {c.actual}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.warnings.length > 0 && (
        <div className="rounded-md border p-3">
          <div className="font-medium">Notes</div>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {result.keptRows.length > 0 && (
        <div className="rounded-md border p-3">
          <div className="font-medium">Rows kept (still referenced)</div>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {result.keptRows.map((k) => (
              <li key={k.table}>
                {k.table}: {k.count}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="text-xs text-muted-foreground">
        Sequences reset: {result.sequencesReset} · Attachments restored:{" "}
        {result.attachmentsRestored} · Missing: {result.attachmentsMissing}
      </div>
    </div>
  );
}
