import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useBackupModules, useCreateBackup } from "../hooks/useBackups";
import { getErrorMessage } from "@/utils/getErrorMessage";

/**
 * "Back up now" — optional module selection (default: everything), starts
 * an async job. Progress shows up in the history table automatically.
 */
export function BackupNowDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted?: () => void;
}) {
  const modulesInfo = useBackupModules();
  const create = useCreateBackup();
  const [selected, setSelected] = useState<string[] | null>(null);

  const groups = modulesInfo.data?.groups ?? [];
  const effective = selected ?? groups.map((g) => g.key);

  const toggle = (key: string) => {
    const next = effective.includes(key)
      ? effective.filter((k) => k !== key)
      : [...effective, key];
    setSelected(next.length === groups.length ? null : next);
  };

  const start = () => {
    if (effective.length === 0) {
      toast.add({ title: "Select at least one module", type: "warning" });
      return;
    }
    create.mutate(selected, {
      onSuccess: () => {
        toast.add({
          title: "Backup started",
          description: "You will be notified when it completes.",
          type: "success",
        });
        props.onStarted?.();
        props.onOpenChange(false);
        setSelected(null);
      },
      onError: (err) =>
        toast.add({
          title: "Backup could not start",
          description: getErrorMessage(err),
          type: "error",
        }),
    });
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create a backup</DialogTitle>
          <DialogDescription>
            Packages are compressed and encrypted. Large backups run in the
            background — you can keep working.
          </DialogDescription>
        </DialogHeader>
        {modulesInfo.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading modules…
          </div>
        ) : (
          <div className="grid gap-2 py-2">
            {groups.map((g) => (
              <Label
                key={g.key}
                className="flex items-center gap-2 rounded-md border p-2 text-sm font-normal"
              >
                <Checkbox
                  checked={effective.includes(g.key)}
                  onCheckedChange={() => toggle(g.key)}
                />
                <span>{g.label}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {g.tables} tables
                </span>
              </Label>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={start} disabled={create.isPending}>
            {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Start backup
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
