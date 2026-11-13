import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { usePermissions } from "@/hooks/usePermissions";
import { toast } from "@/components/ui/toast";
import axios from "@/api/axios";
import { extractApiError } from "../components/RuleDialog";
import {
  useCreatePromotion,
  useDeletePromotion,
  usePromotions,
  useUpdatePromotion,
} from "../hooks/usePricing";
import type { Promotion } from "../pricing.types";

const tk = (n: number) => `৳${n.toFixed(2)}`;

/**
 * Auto-applied promotions (Phase 5): store configuration that discounts by
 * itself at checkout — stacking with the group layer and coupons is decided
 * per promotion, and the backend re-verifies every rule server-side.
 */
export function PromotionsPage() {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("promotions.manage");
  const promotionsQuery = usePromotions();
  const createPromotion = useCreatePromotion();
  const updatePromotion = useUpdatePromotion();
  const deletePromotion = useDeletePromotion();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Promotion | null>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"whole" | "category" | "product" | "variant">("whole");
  const [scopeId, setScopeId] = useState("");
  const [discountType, setDiscountType] = useState<"percentage" | "fixed">("percentage");
  const [discountValue, setDiscountValue] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [minOrderValue, setMinOrderValue] = useState("");
  const [minQuantity, setMinQuantity] = useState("");
  const [maxDiscountAmount, setMaxDiscountAmount] = useState("");
  const [stackGroup, setStackGroup] = useState(false);
  const [stackCoupons, setStackCoupons] = useState(false);
  // ---- Phase 3 (Feature 8) ----
  const [promoKind, setPromoKind] = useState<
    "discount" | "bogo" | "buy_x_get_y" | "mix_match" | "quantity_tier"
  >("discount");
  const [ruleBuyQty, setRuleBuyQty] = useState("1");
  const [ruleGetQty, setRuleGetQty] = useState("1");
  const [ruleComboSize, setRuleComboSize] = useState("2");
  const [ruleDiscountPercent, setRuleDiscountPercent] = useState("20");
  const [ruleTierMinQty, setRuleTierMinQty] = useState("3");
  const [ruleTierPercent, setRuleTierPercent] = useState("10");
  const [flashDays, setFlashDays] = useState<number[]>([]);
  const [flashStart, setFlashStart] = useState("");
  const [flashEnd, setFlashEnd] = useState("");
  const [usageLimit, setUsageLimit] = useState("");
  const [perCustomerLimit, setPerCustomerLimit] = useState("");
  const [priority, setPriority] = useState("0");
  const [isActive, setIsActive] = useState(true);

  async function openCreate() {
    setEditing(null);
    resetForm();
    setDialogOpen(true);
  }

  function openEdit(promo: Promotion) {
    setEditing(promo);
    setName(promo.name);
    setScope(
      promo.variantId != null
        ? "variant"
        : promo.productId != null
          ? "product"
          : promo.categoryId != null
            ? "category"
            : "whole",
    );
    setScopeId(
      String(promo.variantId ?? promo.productId ?? promo.categoryId ?? ""),
    );
    setDiscountType(promo.discountType);
    setDiscountValue(String(promo.discountValue));
    setStartsAt(promo.startsAt ? promo.startsAt.slice(0, 10) : "");
    setEndsAt(promo.endsAt ? promo.endsAt.slice(0, 10) : "");
    setMinOrderValue(promo.minOrderValue ? String(promo.minOrderValue) : "");
    setMinQuantity(promo.minQuantity != null ? String(promo.minQuantity) : "");
    setMaxDiscountAmount(
      promo.maxDiscountAmount != null ? String(promo.maxDiscountAmount) : "",
    );
    setStackGroup(promo.canStackWithGroupDiscount);
    setStackCoupons(promo.canStackWithCoupons);
    setIsActive(promo.isActive);
    setDialogOpen(true);
  }

  function resetForm() {
    setName("");
    setScope("whole");
    setScopeId("");
    setDiscountType("percentage");
    setDiscountValue("");
    setStartsAt("");
    setEndsAt("");
    setMinOrderValue("");
    setMinQuantity("");
    setMaxDiscountAmount("");
    setStackGroup(false);
    setStackCoupons(false);
    setIsActive(true);
  }

  async function save() {
    if (!name.trim() || discountValue === "") {
      toast.add({
        type: "error",
        description: "Name and discount value are required.",
        priority: "high",
      });
      return;
    }
    const scopeIdNum = scopeId === "" ? null : Number(scopeId);
    if (scope !== "whole" && (scopeIdNum == null || !Number.isInteger(scopeIdNum) || scopeIdNum <= 0)) {
      toast.add({ type: "error", description: "Pick a valid scope target.", priority: "high" });
      return;
    }
    const payload = {
      name: name.trim(),
      categoryId: scope === "category" ? scopeIdNum : null,
      productId: scope === "product" ? scopeIdNum : null,
      variantId: scope === "variant" ? scopeIdNum : null,
      discountType,
      discountValue: Number(discountValue),
      startsAt: startsAt ? new Date(`${startsAt}T00:00:00`).toISOString() : null,
      endsAt: endsAt ? new Date(`${endsAt}T23:59:59`).toISOString() : null,
      minOrderValue: minOrderValue === "" ? 0 : Number(minOrderValue),
      minQuantity: minQuantity === "" ? null : Number(minQuantity),
      maxDiscountAmount: maxDiscountAmount === "" ? null : Number(maxDiscountAmount),
      canStackWithGroupDiscount: stackGroup,
      canStackWithCoupons: stackCoupons,
      promoKind,
      rule:
        promoKind === "bogo"
          ? { buyQty: Number(ruleBuyQty) || 1, getQty: Number(ruleGetQty) || 1 }
          : promoKind === "mix_match"
            ? {
                comboSize: Number(ruleComboSize) || 2,
                discountPercent: Number(ruleDiscountPercent) || 0,
              }
            : promoKind === "quantity_tier"
              ? {
                  tiers: [
                    {
                      minQty: Number(ruleTierMinQty) || 3,
                      discountPercent: Number(ruleTierPercent) || 0,
                    },
                  ],
                }
              : null,
      daysOfWeek: flashDays.length > 0 ? flashDays : null,
      startTime: flashStart === "" ? null : flashStart,
      endTime: flashEnd === "" ? null : flashEnd,
      usageLimit: usageLimit === "" ? null : Number(usageLimit),
      perCustomerLimit: perCustomerLimit === "" ? null : Number(perCustomerLimit),
      priority: Number(priority) || 0,
      isActive,
    };
    try {
      if (editing) {
        await updatePromotion.mutateAsync({ id: editing.id, payload });
        toast.add({ type: "success", description: "Promotion updated." });
      } else {
        await createPromotion.mutateAsync(payload);
        toast.add({ type: "success", description: "Promotion created." });
      }
      setDialogOpen(false);
    } catch (err) {
      toast.add({
        type: "error",
        description: extractApiError(err, "Could not save the promotion."),
        priority: "high",
      });
    }
  }

  async function toggleActive(promo: Promotion) {
    try {
      await updatePromotion.mutateAsync({
        id: promo.id,
        payload: { isActive: !promo.isActive },
      });
    } catch (err) {
      toast.add({
        type: "error",
        description: extractApiError(err, "Could not update the promotion."),
        priority: "high",
      });
    }
  }

  async function remove(promo: Promotion) {
    if (!window.confirm(`Delete the promotion "${promo.name}"?`)) return;
    try {
      await deletePromotion.mutateAsync(promo.id);
      toast.add({
        type: "success",
        description: "Promotion deleted. Sale snapshots keep their attribution.",
      });
    } catch (err) {
      toast.add({
        type: "error",
        description: extractApiError(err, "Could not delete the promotion."),
        priority: "high",
      });
    }
  }

  const rows = promotionsQuery.data ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Promotions</CardTitle>
            <CardDescription>
              Auto-applied at checkout — no code needed. Stacking order: group
              pricing → promotions → manual discounts → VAT. A promotion stacks
              with a customer-group discount or a coupon only when its stacking
              switches allow it.
            </CardDescription>
          </div>
          {canManage && <Button onClick={() => void openCreate()}>New promotion</Button>}
        </CardHeader>
        <CardContent>
          {promotionsQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No promotions yet.</p>
          ) : (
            <div className="overflow-hidden rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="p-2 font-medium">Name</th>
                    <th className="p-2 font-medium">Scope</th>
                    <th className="p-2 font-medium">Discount</th>
                    <th className="p-2 font-medium">Window / minimums</th>
                    <th className="p-2 font-medium">Stacking</th>
                    <th className="p-2 font-medium">Status</th>
                    {canManage && <th className="p-2" />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((promo) => (
                    <tr key={promo.id} className="border-t">
                      <td className="p-2 font-medium">{promo.name}</td>
                      <td className="p-2 text-muted-foreground">{promo.scopeLabel}</td>
                      <td className="p-2 font-mono">
                        {promo.discountType === "percentage"
                          ? `${promo.discountValue}%`
                          : tk(promo.discountValue)}
                        {promo.maxDiscountAmount != null && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            cap {tk(promo.maxDiscountAmount)}
                          </span>
                        )}
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">
                        {promo.startsAt || promo.endsAt
                          ? `${promo.startsAt?.slice(0, 10) ?? "…"} → ${promo.endsAt?.slice(0, 10) ?? "…"}`
                          : "Always"}
                        {promo.minOrderValue > 0 && ` · min ${tk(promo.minOrderValue)}`}
                        {promo.minQuantity != null && ` · min qty ${promo.minQuantity}`}
                      </td>
                      <td className="p-2 text-xs">
                        {promo.canStackWithGroupDiscount && <Badge variant="outline" className="mr-1">+groups</Badge>}
                        {promo.canStackWithCoupons && <Badge variant="outline">+coupons</Badge>}
                        {!promo.canStackWithGroupDiscount && !promo.canStackWithCoupons && (
                          <span className="text-muted-foreground">solo</span>
                        )}
                      </td>
                      <td className="p-2">
                        {promo.isActive ? <Badge>Active</Badge> : <Badge variant="secondary">Inactive</Badge>}
                      </td>
                      {canManage && (
                        <td className="p-2 text-right">
                          <div className="flex justify-end gap-1.5">
                            <Button variant="outline" size="sm" onClick={() => openEdit(promo)}>
                              Edit
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={updatePromotion.isPending}
                              onClick={() => void toggleActive(promo)}
                            >
                              {promo.isActive ? "Deactivate" : "Activate"}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={deletePromotion.isPending}
                              onClick={() => void remove(promo)}
                            >
                              Delete
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit promotion" : "New promotion"}</DialogTitle>
            <DialogDescription>
              Applies automatically at checkout when every condition matches.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="promo-name">Name</Label>
              <Input id="promo-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="promo-scope">Scope</Label>
                <select
                  id="promo-scope"
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={scope}
                  onChange={(e) => {
                    setScope(e.target.value as typeof scope);
                    setScopeId("");
                  }}
                >
                  <option value="whole">Whole business</option>
                  <option value="category">Category</option>
                  <option value="product">Product</option>
                  <option value="variant">Variant</option>
                </select>
              </div>
              {scope !== "whole" && (
                <div className="space-y-1.5">
                  <Label htmlFor="promo-scope-id">{scope} id</Label>
                  <Input
                    id="promo-scope-id"
                    type="number"
                    min="1"
                    value={scopeId}
                    onChange={(e) => setScopeId(e.target.value)}
                  />
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="promo-type">Discount type</Label>
                <select
                  id="promo-type"
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={discountType}
                  onChange={(e) => setDiscountType(e.target.value as typeof discountType)}
                >
                  <option value="percentage">Percentage</option>
                  <option value="fixed">Fixed amount</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="promo-value">Value {discountType === "percentage" ? "(%)" : "(৳)"}</Label>
                <Input
                  id="promo-value"
                  type="number"
                  min="0"
                  step="0.01"
                  value={discountValue}
                  onChange={(e) => setDiscountValue(e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="promo-start">Starts at</Label>
                <Input id="promo-start" type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="promo-end">Ends at</Label>
                <Input id="promo-end" type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="promo-min-order">Min order (৳)</Label>
                <Input id="promo-min-order" type="number" min="0" value={minOrderValue} onChange={(e) => setMinOrderValue(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="promo-min-qty">Min quantity</Label>
                <Input id="promo-min-qty" type="number" min="1" value={minQuantity} onChange={(e) => setMinQuantity(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="promo-max">Max discount (৳)</Label>
                <Input id="promo-max" type="number" min="0" value={maxDiscountAmount} onChange={(e) => setMaxDiscountAmount(e.target.value)} />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border p-2">
              <span className="text-sm">Stacks with customer-group pricing</span>
              <Switch checked={stackGroup} onCheckedChange={setStackGroup} />
            </div>
            <div className="flex items-center justify-between rounded-md border p-2">
              <span className="text-sm">Stacks with coupons</span>
              <Switch checked={stackCoupons} onCheckedChange={setStackCoupons} />
            </div>
            <div className="flex items-center justify-between rounded-md border p-2">
              <span className="text-sm">Active</span>
              <Switch checked={isActive} onCheckedChange={setIsActive} />
            </div>

            {/* ---- Phase 3: promo kind + rule + windows + limits ---- */}
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">Promotion type</span>
              <select
                className="rounded-md border bg-background p-2 text-sm"
                value={promoKind}
                onChange={(e) =>
                  setPromoKind(
                    e.target.value as
                      | "discount"
                      | "bogo"
                      | "buy_x_get_y"
                      | "mix_match"
                      | "quantity_tier",
                  )
                }
              >
                <option value="discount">Percentage / fixed discount</option>
                <option value="bogo">BOGO (buy X get Y free, same item)</option>
                <option value="buy_x_get_y">Buy X get Y free (across items)</option>
                <option value="mix_match">Mix &amp; match (N units, % off)</option>
                <option value="quantity_tier">Quantity tier discount</option>
              </select>
            </div>
            {promoKind === "bogo" ? (
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1">
                  <span className="text-xs text-muted-foreground">Buy (qty)</span>
                  <Input type="number" min={1} value={ruleBuyQty} onChange={(e) => setRuleBuyQty(e.target.value)} />
                </div>
                <div className="grid gap-1">
                  <span className="text-xs text-muted-foreground">Get free (qty)</span>
                  <Input type="number" min={1} value={ruleGetQty} onChange={(e) => setRuleGetQty(e.target.value)} />
                </div>
              </div>
            ) : null}
            {promoKind === "mix_match" ? (
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1">
                  <span className="text-xs text-muted-foreground">Combo size (units)</span>
                  <Input type="number" min={2} value={ruleComboSize} onChange={(e) => setRuleComboSize(e.target.value)} />
                </div>
                <div className="grid gap-1">
                  <span className="text-xs text-muted-foreground">Discount %</span>
                  <Input type="number" min={1} max={100} value={ruleDiscountPercent} onChange={(e) => setRuleDiscountPercent(e.target.value)} />
                </div>
              </div>
            ) : null}
            {promoKind === "quantity_tier" ? (
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1">
                  <span className="text-xs text-muted-foreground">Min quantity</span>
                  <Input type="number" min={2} value={ruleTierMinQty} onChange={(e) => setRuleTierMinQty(e.target.value)} />
                </div>
                <div className="grid gap-1">
                  <span className="text-xs text-muted-foreground">Discount %</span>
                  <Input type="number" min={1} max={100} value={ruleTierPercent} onChange={(e) => setRuleTierPercent(e.target.value)} />
                </div>
              </div>
            ) : null}
            <div className="grid gap-1.5 rounded-md border border-dashed p-2">
              <span className="text-xs font-medium text-muted-foreground">
                Flash window (Asia/Dhaka time)
              </span>
              <div className="flex flex-wrap gap-1">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, idx) => (
                  <Button
                    key={day}
                    type="button"
                    size="sm"
                    variant={flashDays.includes(idx) ? "default" : "outline"}
                    onClick={() =>
                      setFlashDays(
                        flashDays.includes(idx)
                          ? flashDays.filter((d) => d !== idx)
                          : [...flashDays, idx].sort((a, b) => a - b),
                      )
                    }
                  >
                    {day}
                  </Button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input type="time" value={flashStart} onChange={(e) => setFlashStart(e.target.value)} />
                <Input type="time" value={flashEnd} onChange={(e) => setFlashEnd(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="grid gap-1">
                <span className="text-xs text-muted-foreground">Total usage limit</span>
                <Input type="number" min={1} placeholder="∞" value={usageLimit} onChange={(e) => setUsageLimit(e.target.value)} />
              </div>
              <div className="grid gap-1">
                <span className="text-xs text-muted-foreground">Per customer</span>
                <Input type="number" min={1} placeholder="∞" value={perCustomerLimit} onChange={(e) => setPerCustomerLimit(e.target.value)} />
              </div>
              <div className="grid gap-1">
                <span className="text-xs text-muted-foreground">Priority</span>
                <Input type="number" min={0} value={priority} onChange={(e) => setPriority(e.target.value)} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void save()}
              disabled={createPromotion.isPending || updatePromotion.isPending}
            >
              {editing ? "Save changes" : "Create promotion"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
