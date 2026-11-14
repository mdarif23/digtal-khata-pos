import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { PageContainer } from "@/components/common/PageContainer";
import { PageHeader } from "@/components/common/PageHeader";
import { usePermissions } from "@/hooks/usePermissions";
import { toast } from "@/components/ui/toast";
import { extractApiError } from "../components/RuleDialog";
import { usePricingSettings, useUpdatePricingSettings } from "../hooks/usePricing";
import type {
  PricingMethod,
  RoundingDirection,
  RoundingIncrement,
} from "../pricing.types";

const METHODS: { value: PricingMethod; label: string; hint: string }[] = [
  { value: "fixed", label: "Fixed prices", hint: "No automatic calculation — prices are managed manually." },
  { value: "markup", label: "Cost + markup", hint: "Price = cost × (1 + markup). Cost 100 at 30% → 130." },
  { value: "margin", label: "Target margin", hint: "Price = cost ÷ (1 − margin). Cost 100 at 20% → 125." },
];

const INCREMENTS: { value: RoundingIncrement; label: string }[] = [
  { value: "none", label: "No rounding (nearest 0.01)" },
  { value: "1", label: "Nearest 1" },
  { value: "5", label: "Nearest 5" },
  { value: "10", label: "Nearest 10" },
];

const DIRECTIONS: { value: RoundingDirection; label: string }[] = [
  { value: "nearest", label: "Nearest" },
  { value: "up", label: "Always round up" },
  { value: "down", label: "Always round down" },
];

/**
 * Business-wide pricing defaults (pricing_settings singleton). Rules on the
 * Rules page override these per category/product/variant; nothing here
 * changes a selling price by itself.
 */
export function PricingSettingsPage() {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("pricing.manage");
  const settingsQuery = usePricingSettings();
  const updateSettings = useUpdatePricingSettings();

  const [method, setMethod] = useState<PricingMethod>("fixed");
  const [percentage, setPercentage] = useState("");
  const [roundingIncrement, setRoundingIncrement] = useState<RoundingIncrement>("none");
  const [roundingDirection, setRoundingDirection] = useState<RoundingDirection>("nearest");
  const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(false);
  const [autoUpdateFixedPrices, setAutoUpdateFixedPrices] = useState(false);
  const [minMarginPercent, setMinMarginPercent] = useState("");

  useEffect(() => {
    const s = settingsQuery.data;
    if (!s) return;
    setMethod(s.defaultMethod);
    setPercentage(s.defaultPercentage != null ? String(s.defaultPercentage) : "");
    setRoundingIncrement(s.roundingIncrement);
    setRoundingDirection(s.roundingDirection);
    setAutoUpdateEnabled(s.autoUpdateEnabled);
    setAutoUpdateFixedPrices(s.autoUpdateFixedPrices);
    setMinMarginPercent(s.minMarginPercent != null ? String(s.minMarginPercent) : "");
  }, [settingsQuery.data]);

  async function save() {
    const target: Partial<Omit<PricingSettings, "updatedAt">> = {
      defaultMethod: method,
      defaultPercentage: method === "fixed" ? null : Number(percentage),
      roundingIncrement,
      roundingDirection,
      autoUpdateEnabled,
      autoUpdateFixedPrices,
      minMarginPercent: minMarginPercent.trim() === "" ? null : Number(minMarginPercent),
    };
    if (method !== "fixed") {
      const pct = Number(percentage);
      if (!Number.isFinite(pct) || pct < 0) {
        toast.add({ type: "error", description: "Enter a percentage of 0 or more.", priority: "high" });
        return;
      }
      if (method === "margin" && pct >= 100) {
        toast.add({ type: "error", description: "Margin must be below 100%.", priority: "high" });
        return;
      }
    }
    try {
      await updateSettings.mutateAsync(target);
      toast.add({ type: "success", description: "Pricing settings saved." });
    } catch (err) {
      toast.add({
        type: "error",
        description: extractApiError(err, "Could not save pricing settings."),
        priority: "high",
      });
    }
  }

  const selectedHint = METHODS.find((m) => m.value === method)?.hint ?? "";
  const busy = updateSettings.isPending;

  return (
    <PageContainer width="narrow">
      <PageHeader
        title="Pricing settings"
        description="Business-wide defaults used when no pricing rule matches a product. Rules win over these defaults; previews and applies never change a price on their own."
      />
      <Card>
        <CardContent className="space-y-4">
          {settingsQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label>Default pricing method</Label>
                <div className="flex flex-wrap gap-1.5">
                  {METHODS.map((m) => (
                    <Button
                      key={m.value}
                      type="button"
                      size="sm"
                      variant={method === m.value ? "default" : "outline"}
                      disabled={!canManage}
                      onClick={() => setMethod(m.value)}
                      className={!canManage ? "opacity-60" : undefined}
                    >
                      {m.label}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">{selectedHint}</p>
              </div>

              {method !== "fixed" && (
                <div className="space-y-1">
                  <Label>Default percentage (%)</Label>
                  <Input
                    className="w-40"
                    type="number"
                    min={0}
                    max={100}
                    step={0.001}
                    disabled={!canManage}
                    value={percentage}
                    onChange={(e) => setPercentage(e.target.value)}
                  />
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>Price rounding</Label>
                  <select
                    className="w-full rounded-md border bg-background p-2 text-sm"
                    disabled={!canManage}
                    value={roundingIncrement}
                    onChange={(e) => setRoundingIncrement(e.target.value as RoundingIncrement)}
                  >
                    {INCREMENTS.map((i) => (
                      <option key={i.value} value={i.value}>
                        {i.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label>Rounding direction</Label>
                  <select
                    className="w-full rounded-md border bg-background p-2 text-sm"
                    disabled={!canManage}
                    value={roundingDirection}
                    onChange={(e) => setRoundingDirection(e.target.value as RoundingDirection)}
                  >
                    {DIRECTIONS.map((d) => (
                      <option key={d.value} value={d.value}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <Label>Minimum profit margin floor (%) — optional</Label>
                <Input
                  className="w-40"
                  type="number"
                  min={0}
                  max={100}
                  step={0.01}
                  disabled={!canManage}
                  value={minMarginPercent}
                  onChange={(e) => setMinMarginPercent(e.target.value)}
                  placeholder="e.g. 15"
                />
                <p className="text-xs text-muted-foreground">
                  Recommended prices below this margin are blocked until the
                  floor is adjusted.
                </p>
              </div>

              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Automatic price updates</p>
                    <p className="text-xs text-muted-foreground">
                      When purchase costs change, apply recalculated prices
                      without manual review. Only products with active
                      percentage rules are touched.
                    </p>
                  </div>
                  <Switch
                    checked={autoUpdateEnabled}
                    onCheckedChange={(v) => canManage && setAutoUpdateEnabled(v)}
                    disabled={!canManage}
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">
                      Also overwrite manually managed fixed prices
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Off by default — explicit fixed rules stay untouched by
                      automatic updates.
                    </p>
                  </div>
                  <Switch
                    checked={autoUpdateFixedPrices}
                    onCheckedChange={(v) => canManage && setAutoUpdateFixedPrices(v)}
                    disabled={!canManage}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Note: the automatic-update sweep ships in a later phase of
                  the pricing program; these preferences are stored now.
                </p>
              </div>

              {canManage && (
                <div className="flex justify-end">
                  <Button onClick={() => void save()} disabled={busy}>
                    Save settings
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
