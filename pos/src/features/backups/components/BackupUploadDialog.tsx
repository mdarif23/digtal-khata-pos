import { useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { downloadBackupApi, presignUploadApi, registerUploadApi } from "../backups.api";
import { useBackupModules } from "../hooks/useBackups";
import { getErrorMessage } from "@/utils/getErrorMessage";

const MAX_MB = 200;

/**
 * .ezbackup upload via the codebase's presign-PUT-register pattern (the
 * same three-step flow expense attachments use; there is no multipart
 * endpoint anywhere in the backend by design).
 */
export function BackupUploadDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRegistered?: () => void;
}) {
  const modulesInfo = useBackupModules();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const storageEnabled = modulesInfo.data?.storageEnabled ?? false;

  const upload = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".ezbackup")) {
      toast.add({ title: "Only .ezbackup files are accepted", type: "warning" });
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      toast.add({ title: `File exceeds the ${MAX_MB} MB limit`, type: "warning" });
      return;
    }
    setBusy(true);
    try {
      const { storageKey, uploadUrl } = await presignUploadApi();
      const put = await fetch(uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": "application/octet-stream" },
      });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      await registerUploadApi(storageKey, file.name);
      toast.add({
        title: "Package registered",
        description: "Integrity was verified — it is ready to restore.",
        type: "success",
      });
      props.onOpenChange(false);
      props.onRegistered?.();
    } catch (err) {
      toast.add({
        title: "Upload failed",
        description: getErrorMessage(err),
        type: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upload a backup package</DialogTitle>
          <DialogDescription>
            Upload a <code>.ezbackup</code> file (max {MAX_MB} MB). It is
            integrity-checked immediately; a failed check is rejected and
            deleted.
          </DialogDescription>
        </DialogHeader>
        {!storageEnabled ? (
          <div className="rounded-md border p-3 text-sm text-muted-foreground">
            Uploads need object storage configured on the server (S3
            credentials).
          </div>
        ) : (
          <input
            ref={inputRef}
            type="file"
            accept=".ezbackup"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.target.value = "";
            }}
          />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          {storageEnabled && (
            <Button disabled={busy} onClick={() => inputRef.current?.click()}>
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              Choose file…
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Shared action handler for row buttons. */
export async function downloadBackup(id: number, fileName: string | null) {
  try {
    await downloadBackupApi(id, fileName ?? `backup-${id}.ezbackup`);
  } catch (err) {
    toast.add({ title: "Download failed", description: getErrorMessage(err), type: "error" });
  }
}
