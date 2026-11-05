import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useBackupSchedule, useSaveSchedule } from "../hooks/useBackups";
import { getErrorMessage } from "@/utils/getErrorMessage";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Automatic backup schedule (daily/weekly at a business-timezone hour) and
 * the retention window. Scheduled backups need server-side object storage —
 * the backend refuses to depend on ephemeral disk.
 */
export function BackupScheduleCard() {
  const { data, isLoading } = useBackupSchedule();
  const save = useSaveSchedule();
  const [enabled, setEnabled] = useState(true);
  const [frequency, setFrequency] = useState<"daily" | "weekly">("daily");
  const [hour, setHour] = useState(2);
  const [dayOfWeek, setDayOfWeek] = useState(0);
  const [retentionDays, setRetentionDays] = useState(30);

  useEffect(() => {
    const s = data?.schedule;
    if (s) {
      setEnabled(s.enabled);
      setFrequency(s.frequency);
      setHour(s.hour);
      setDayOfWeek(s.dayOfWeek ?? 0);
      setRetentionDays(s.retentionDays);
    }
  }, [data]);

  const saveSettings = () => {
    save.mutate(
      {
        enabled,
        frequency,
        hour,
        ...(frequency === "weekly" ? { dayOfWeek } : {}),
        retentionDays,
      },
      {
        onSuccess: (s) =>
          toast.add({
            title: "Schedule saved",
            description: s.enabled && s.nextRunAt
              ? `Next backup: ${new Date(s.nextRunAt).toLocaleString()}`
              : "Automatic backups are off.",
            type: "success",
          }),
        onError: (err) =>
          toast.add({ title: "Could not save schedule", description: getErrorMessage(err), type: "error" }),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Automatic backups</CardTitle>
        <CardDescription>
          {data?.storageEnabled
            ? "Runs hourly sweeps; the backup starts within the hour after the scheduled time (business timezone)."
            : "Automatic backups need object storage configured on the server (S3 credentials). Manual backups still work."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading schedule…
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <Label htmlFor="backup-enabled" className="text-sm font-normal">
                Enable automatic backups
              </Label>
              <Switch id="backup-enabled" checked={enabled} onCheckedChange={setEnabled} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label className="text-sm">Frequency</Label>
                <Select
                  value={frequency}
                  onValueChange={(v) => setFrequency(v as "daily" | "weekly")}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {frequency === "weekly" && (
                <div className="grid gap-1.5">
                  <Label className="text-sm">Day</Label>
                  <Select
                    value={String(dayOfWeek)}
                    onValueChange={(v) => setDayOfWeek(Number(v))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DAYS.map((d, i) => (
                        <SelectItem key={d} value={String(i)}>
                          {d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="grid gap-1.5">
                <Label className="text-sm">Hour (0–23)</Label>
                <Input
                  type="number"
                  min={0}
                  max={23}
                  value={hour}
                  onChange={(e) => setHour(Math.max(0, Math.min(23, Number(e.target.value) || 0)))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-sm">Retention (days)</Label>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={retentionDays}
                  onChange={(e) =>
                    setRetentionDays(Math.max(1, Math.min(365, Number(e.target.value) || 30)))
                  }
                />
              </div>
            </div>
            {data?.schedule?.lastRunAt && (
              <div className="text-xs text-muted-foreground">
                Last scheduled run: {new Date(data.schedule.lastRunAt).toLocaleString()}
              </div>
            )}
            <div>
              <Button onClick={saveSettings} disabled={save.isPending}>
                {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save schedule
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
