import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createTierApi,
  deleteTierApi,
  getEarnRuleApi,
  getLoyaltyProgramApi,
  getTiersApi,
  putEarnRuleApi,
  putLoyaltyProgramApi,
  updateTierApi,
  type EarnRule,
  type LoyaltyProgram,
  type LoyaltyTier,
} from "./loyalty.api";

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

/**
 * Loyalty engine settings (Phase 2A): program (rates, expiry, redemption
 * caps), earning rules (minimum spend, exclusions, multiplier, bonus,
 * campaign window) and spend-derived tiers with earn multipliers.
 */
export function LoyaltySettingsPage() {
  const [program, setProgram] = useState<LoyaltyProgram | null>(null);
  const [rule, setRule] = useState<EarnRule | null>(null);
  const [tiers, setTiers] = useState<LoyaltyTier[] | null>(null);
  const [savingProgram, setSavingProgram] = useState(false);
  const [savingRule, setSavingRule] = useState(false);
  const [newTier, setNewTier] = useState({ name: "", minSpend: "500", earnMultiplier: "1", rank: "10" });

  const load = useCallback(async () => {
    try {
      const [p, r, t] = await Promise.all([
        getLoyaltyProgramApi(),
        getEarnRuleApi(),
        getTiersApi(),
      ]);
      setProgram(p);
      setRule(r);
      setTiers(t);
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to load loyalty settings."), type: "error" });
      setProgram(null);
      setRule(null);
      setTiers([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveProgram() {
    if (!program) return;
    setSavingProgram(true);
    try {
      const saved = await putLoyaltyProgramApi(program);
      setProgram(saved);
      toast.add({ title: "Loyalty program saved.", type: "success" });
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to save the program."), type: "error" });
    } finally {
      setSavingProgram(false);
    }
  }

  async function saveRule() {
    if (!rule) return;
    setSavingRule(true);
    try {
      const saved = await putEarnRuleApi(rule);
      setRule(saved);
      toast.add({ title: "Earning rule saved.", type: "success" });
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to save the rule."), type: "error" });
    } finally {
      setSavingRule(false);
    }
  }

  async function addTier() {
    try {
      await createTierApi({
        name: newTier.name.trim(),
        minSpend: Number(newTier.minSpend) || 0,
        qualificationMonths: null,
        earnMultiplier: Number(newTier.earnMultiplier) || 1,
        rank: Number(newTier.rank) || 0,
        isActive: true,
      });
      setNewTier({ name: "", minSpend: "500", earnMultiplier: "1", rank: "10" });
      setTiers(await getTiersApi());
      toast.add({ title: "Tier created.", type: "success" });
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to create the tier."), type: "error" });
    }
  }

  async function saveTier(tier: LoyaltyTier) {
    try {
      await updateTierApi(tier.id, {
        name: tier.name,
        minSpend: tier.minSpend,
        qualificationMonths: tier.qualificationMonths,
        earnMultiplier: tier.earnMultiplier,
        rank: tier.rank,
        isActive: tier.isActive,
      });
      setTiers(await getTiersApi());
      toast.add({ title: "Tier updated.", type: "success" });
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to update the tier."), type: "error" });
    }
  }

  async function removeTier(id: number) {
    try {
      await deleteTierApi(id);
      setTiers((prev) => prev?.filter((t) => t.id !== id) ?? null);
    } catch (error) {
      toast.add({ title: extractError(error, "Unable to delete the tier."), type: "error" });
    }
  }

  if (program === null || rule === null || tiers === null) {
    return (
      <div className="grid gap-3 p-4 lg:p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="grid gap-5 p-4 lg:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Loyalty program</h1>
        <p className="text-sm text-muted-foreground">
          Points earn and redemption policy for this business.
        </p>
      </div>

      {/* Program */}
      <section className="grid gap-3 rounded-md border p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Program</h2>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Active</span>
            <Switch
              checked={program.isActive}
              onCheckedChange={(v) => setProgram({ ...program, isActive: v })}
            />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="loy-earn">Earn rate (points per ৳1)</Label>
            <Input
              id="loy-earn"
              type="number"
              step="0.0001"
              value={program.earnRate}
              onChange={(e) => setProgram({ ...program, earnRate: Number(e.target.value) })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="loy-redeem">Redeem value (৳ per point)</Label>
            <Input
              id="loy-redeem"
              type="number"
              step="0.0001"
              value={program.redeemValue}
              onChange={(e) => setProgram({ ...program, redeemValue: Number(e.target.value) })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Expiry</Label>
            <div className="flex gap-2">
              <Select
                value={program.expiryMode}
                onValueChange={(v) =>
                  setProgram({ ...program, expiryMode: v === "fixed" ? "fixed" : "none" })
                }
                items={[
                  { value: "none", label: "Never expires" },
                  { value: "fixed", label: "Fixed days" },
                ]}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Never expires</SelectItem>
                  <SelectItem value="fixed">Fixed days</SelectItem>
                </SelectContent>
              </Select>
              {program.expiryMode === "fixed" ? (
                <Input
                  type="number"
                  min={1}
                  className="w-24"
                  placeholder="Days"
                  value={program.expiryDays ?? ""}
                  onChange={(e) =>
                    setProgram({ ...program, expiryDays: Number(e.target.value) || null })
                  }
                />
              ) : null}
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="loy-minred">Minimum redemption (points)</Label>
            <Input
              id="loy-minred"
              type="number"
              min={0}
              value={program.minRedemptionPoints}
              onChange={(e) =>
                setProgram({ ...program, minRedemptionPoints: Number(e.target.value) || 0 })
              }
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="loy-maxred">Max redemption per sale (points)</Label>
            <Input
              id="loy-maxred"
              type="number"
              min={1}
              placeholder="Empty = no cap"
              value={program.maxRedemptionPointsPerSale ?? ""}
              onChange={(e) =>
                setProgram({
                  ...program,
                  maxRedemptionPointsPerSale: e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
          </div>
        </div>
        <div>
          <Button size="sm" onClick={() => void saveProgram()} disabled={savingProgram}>
            {savingProgram ? "Saving…" : "Save program"}
          </Button>
        </div>
      </section>

      {/* Earning rule */}
      <section className="grid gap-3 rounded-md border p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Earning rule</h2>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Enabled</span>
            <Switch
              checked={rule.isActive}
              onCheckedChange={(v) => setRule({ ...rule, isActive: v })}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          points = eligible spend × earn rate × rule multiplier × tier multiplier + bonus
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="grid gap-1.5">
            <Label htmlFor="rule-min">Minimum spend (৳)</Label>
            <Input
              id="rule-min"
              type="number"
              min={0}
              value={rule.minTransactionAmount}
              onChange={(e) =>
                setRule({ ...rule, minTransactionAmount: Number(e.target.value) || 0 })
              }
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rule-mult">Multiplier</Label>
            <Input
              id="rule-mult"
              type="number"
              step="0.1"
              min={0}
              value={rule.multiplier}
              onChange={(e) => setRule({ ...rule, multiplier: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rule-bonus">Bonus points per sale</Label>
            <Input
              id="rule-bonus"
              type="number"
              min={0}
              value={rule.bonusPoints}
              onChange={(e) => setRule({ ...rule, bonusPoints: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rule-excl">Excluded product IDs (comma-separated)</Label>
            <Input
              id="rule-excl"
              placeholder="e.g. 12, 34"
              value={rule.excludedProductIds.join(", ")}
              onChange={(e) =>
                setRule({
                  ...rule,
                  excludedProductIds: e.target.value
                    .split(",")
                    .map((v) => Number(v.trim()))
                    .filter((v) => Number.isInteger(v) && v > 0),
                })
              }
            />
          </div>
        </div>
        <div>
          <Button size="sm" onClick={() => void saveRule()} disabled={savingRule}>
            {savingRule ? "Saving…" : "Save rule"}
          </Button>
        </div>
      </section>

      {/* Tiers */}
      <section className="grid gap-3 rounded-md border p-4">
        <h2 className="font-medium">Tiers (derived from qualifying spend)</h2>
        {tiers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tiers yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-2 font-medium">Name</th>
                  <th className="p-2 font-medium">Min spend (৳)</th>
                  <th className="p-2 font-medium">Earn ×</th>
                  <th className="p-2 font-medium">Rank</th>
                  <th className="p-2 font-medium">Active</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {tiers.map((tier) => (
                  <tr key={tier.id} className="border-t">
                    <td className="p-2">
                      <Input
                        className="h-8 w-32"
                        value={tier.name}
                        onChange={(e) =>
                          setTiers(
                            tiers.map((t) =>
                              t.id === tier.id ? { ...t, name: e.target.value } : t,
                            ),
                          )
                        }
                      />
                    </td>
                    <td className="p-2">
                      <Input
                        className="h-8 w-28"
                        type="number"
                        value={tier.minSpend}
                        onChange={(e) =>
                          setTiers(
                            tiers.map((t) =>
                              t.id === tier.id
                                ? { ...t, minSpend: Number(e.target.value) || 0 }
                                : t,
                            ),
                          )
                        }
                      />
                    </td>
                    <td className="p-2">
                      <Input
                        className="h-8 w-20"
                        type="number"
                        step="0.1"
                        value={tier.earnMultiplier}
                        onChange={(e) =>
                          setTiers(
                            tiers.map((t) =>
                              t.id === tier.id
                                ? { ...t, earnMultiplier: Number(e.target.value) || 0 }
                                : t,
                            ),
                          )
                        }
                      />
                    </td>
                    <td className="p-2">
                      <Input
                        className="h-8 w-16"
                        type="number"
                        value={tier.rank}
                        onChange={(e) =>
                          setTiers(
                            tiers.map((t) =>
                              t.id === tier.id
                                ? { ...t, rank: Number(e.target.value) || 0 }
                                : t,
                            ),
                          )
                        }
                      />
                    </td>
                    <td className="p-2">
                      <Badge variant={tier.isActive ? "default" : "secondary"}>
                        {tier.isActive ? "active" : "off"}
                      </Badge>
                    </td>
                    <td className="p-2 text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="outline" onClick={() => void saveTier(tier)}>
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void removeTier(tier.id)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="tier-name">New tier</Label>
            <Input
              id="tier-name"
              placeholder="Name"
              className="w-32"
              value={newTier.name}
              onChange={(e) => setNewTier({ ...newTier, name: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tier-spend">Min spend</Label>
            <Input
              id="tier-spend"
              type="number"
              className="w-28"
              value={newTier.minSpend}
              onChange={(e) => setNewTier({ ...newTier, minSpend: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tier-mult">Earn ×</Label>
            <Input
              id="tier-mult"
              type="number"
              step="0.1"
              className="w-20"
              value={newTier.earnMultiplier}
              onChange={(e) => setNewTier({ ...newTier, earnMultiplier: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tier-rank">Rank</Label>
            <Input
              id="tier-rank"
              type="number"
              className="w-20"
              value={newTier.rank}
              onChange={(e) => setNewTier({ ...newTier, rank: e.target.value })}
            />
          </div>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void addTier()} disabled={!newTier.name.trim()}>
            <Plus className="size-4" /> Add tier
          </Button>
        </div>
      </section>
    </div>
  );
}
