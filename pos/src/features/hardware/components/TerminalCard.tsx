import { useState } from "react";
import { toast } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDateTime } from "@/features/reports/utils/reportUtils";
import { ConfirmDeleteDialog } from "@/components/common/ConfirmDeleteDialog";
import { PermissionButton } from "@/components/common/PermissionGuard";
import {
  useDeleteTerminal,
  useRotateSecret,
  useTerminalCommands,
  useUpdateTerminal,
} from "../hooks/useTerminals";
import { setPreferredTerminalId, getPreferredTerminalId } from "../drawerCommands";
import api from "../../../api/axios.js";
import type { TerminalSummary } from "../terminals.api";

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

const COMMAND_STATUS_STYLES: Record<string, string> = {
  completed: "text-emerald-600",
  failed: "text-rose-600",
  expired: "text-slate-400",
  unknown_outcome: "text-amber-600",
};

/** One terminal: status, identity actions, and its command history. */
export function TerminalCard(props: { terminal: TerminalSummary }) {
  const terminal = props.terminal;
  const update = useUpdateTerminal();
  const remove = useDeleteTerminal();
  const rotate = useRotateSecret();
  const [historyOpen, setHistoryOpen] = useState(false);
  const commands = useTerminalCommands(terminal.id, historyOpen);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(terminal.name);
  const [moveOpen, setMoveOpen] = useState(false);
  const [locations, setLocations] = useState<{ id: number; name: string }[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  const isPreferred = getPreferredTerminalId() === terminal.id;

  async function onToggleStatus() {
    try {
      await update.mutateAsync({
        terminalId: terminal.id,
        status: terminal.status === "active" ? "inactive" : "active",
      });
      toast.add({
        title:
          terminal.status === "active"
            ? "Terminal deactivated — the bridge is locked out."
            : "Terminal reactivated.",
        type: "success",
      });
    } catch (error) {
      toast.add({
        title: extractError(error, "Unable to update the terminal."),
        type: "error",
        priority: "high",
      });
    }
  }

  async function onRotate() {
    try {
      const data = await rotate.mutateAsync(terminal.id);
      setRevealedSecret(data.secret);
    } catch (error) {
      toast.add({
        title: extractError(error, "Unable to rotate the secret."),
        type: "error",
        priority: "high",
      });
    }
  }

  async function onDelete() {
    try {
      await remove.mutateAsync(terminal.id);
      if (isPreferred) setPreferredTerminalId(null);
    } finally {
      // Success/failure messaging is handled by ConfirmDeleteDialog.
      setConfirmDelete(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{terminal.name}</span>
        <Badge variant={terminal.status === "active" ? "default" : "secondary"}>
          {terminal.status === "active" ? "Active" : "Inactive"}
        </Badge>
        <Badge variant={terminal.paired ? "default" : "outline"}>
          {terminal.paired ? "Paired" : "Not paired"}
        </Badge>
        {isPreferred ? <Badge variant="outline">This counter</Badge> : null}
        <span className="ml-auto text-xs text-slate-500">
          {terminal.lastSeenAt
            ? `Last seen ${formatDateTime(terminal.lastSeenAt)}`
            : "Never connected"}
        </span>
      </div>

      {terminal.deviceInfo &&
      Object.keys(terminal.deviceInfo as Record<string, unknown>).length > 0 ? (
        <div className="mt-1 text-xs text-slate-500">
          {Object.entries(terminal.deviceInfo as Record<string, unknown>)
            .slice(0, 4)
            .map(([key, value]) => `${key}: ${String(value)}`)
            .join(" · ")}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <PermissionButton
          permission="pos_terminal.manage"
          size="sm"
          variant="outline"
          onClick={() => {
            setRenameValue(terminal.name);
            setRenameOpen(true);
          }}
        >
          Rename
        </PermissionButton>
        <PermissionButton
          permission="pos_terminal.manage"
          size="sm"
          variant="outline"
          onClick={async () => {
            try {
              const res = await api.get<{
                success: boolean;
                data: { id: number; name: string }[];
              }>("/locations");
              setLocations((res.data.data ?? []).filter((l) => l.id !== terminal.locationId));
              setMoveOpen(true);
            } catch (error) {
              toast.add({
                title: extractError(error, "Unable to load locations."),
                type: "error",
              });
            }
          }}
        >
          Move
        </PermissionButton>
        <PermissionButton
          permission="pos_terminal.manage"
          size="sm"
          variant="outline"
          disabled={update.isPending}
          onClick={() => void onToggleStatus()}
        >
          {terminal.status === "active" ? "Deactivate" : "Activate"}
        </PermissionButton>
        {terminal.paired ? (
          <PermissionButton
            permission="pos_terminal.manage"
            size="sm"
            variant="outline"
            disabled={rotate.isPending}
            onClick={() => void onRotate()}
          >
            Rotate secret
          </PermissionButton>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setHistoryOpen((open) => !open)}
        >
          {historyOpen ? "Hide commands" : "Command history"}
        </Button>
        {!isPreferred && terminal.paired && terminal.status === "active" ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setPreferredTerminalId(terminal.id);
              toast.add({
                title: "This counter will use this terminal's drawer.",
                type: "success",
              });
            }}
          >
            Use as this counter
          </Button>
        ) : null}
        <PermissionButton
          permission="pos_terminal.manage"
          size="sm"
          variant="ghost"
          className="text-rose-600"
          onClick={() => setConfirmDelete(true)}
        >
          Delete
        </PermissionButton>
      </div>

      {revealedSecret !== null ? (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3">
          <div className="text-xs font-medium text-amber-800">
            New bridge secret — shown once, paste it into the bridge now:
          </div>
          <div className="mt-1 break-all font-mono text-sm">{revealedSecret}</div>
        </div>
      ) : null}

      {historyOpen ? (
        <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
          {commands.isLoading ? (
            <div className="flex items-center justify-center gap-2 p-4 text-sm text-slate-400">
              <Spinner className="size-4" /> Loading…
            </div>
          ) : (commands.data?.length ?? 0) === 0 ? (
            <div className="p-4 text-sm text-slate-400">No commands yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Command</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Sale</th>
                  <th className="px-3 py-2">Reason</th>
                </tr>
              </thead>
              <tbody>
                {(commands.data ?? []).map((command) => (
                  <tr key={command.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">#{command.id} drawer_open</td>
                    <td
                      className={`px-3 py-2 font-medium ${
                        COMMAND_STATUS_STYLES[command.status] ?? ""
                      }`}
                    >
                      {command.status}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {command.saleId ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-slate-500">
                      {command.reason ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename terminal</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={`terminal-name-${terminal.id}`}>Name</Label>
            <Input
              id={`terminal-name-${terminal.id}`}
              value={renameValue}
              maxLength={100}
              onChange={(event) => setRenameValue(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={update.isPending || renameValue.trim() === ""}
              onClick={async () => {
                try {
                  await update.mutateAsync({
                    terminalId: terminal.id,
                    name: renameValue.trim(),
                  });
                  setRenameOpen(false);
                } catch (error) {
                  toast.add({
                    title: extractError(error, "Unable to rename the terminal."),
                    type: "error",
                    priority: "high",
                  });
                }
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Move “{terminal.name}”</DialogTitle>
            <DialogDescription>
              Sales already recorded keep their original terminal attribution —
              moving only changes where this terminal is authorized from now on.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {locations.map((location) => (
              <Button
                key={location.id}
                variant="outline"
                className="justify-start"
                disabled={update.isPending}
                onClick={async () => {
                  try {
                    await update.mutateAsync({
                      terminalId: terminal.id,
                      locationId: location.id,
                    });
                    setMoveOpen(false);
                    toast.add({
                      title: `Terminal moved to ${location.name}.`,
                      type: "success",
                    });
                  } catch (error) {
                    toast.add({
                      title: extractError(error, "Unable to move the terminal."),
                      type: "error",
                      priority: "high",
                    });
                  }
                }}
              >
                Move to {location.name}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete terminal?"
        description="A terminal with command history cannot be deleted — deactivate it instead. Its bridge secret stops working immediately."
        entityName={terminal.name}
        onConfirm={onDelete}
      />
    </div>
  );
}
