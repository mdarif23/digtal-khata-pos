import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { useCreateRule, useUpdateRule } from "../hooks/usePricing";
import type { PricingMethod, PricingRule } from "../pricing.types";

export interface RuleDialogCategory {
  value: number;
  label: string;
}

export interface RuleDialogVariant {
  variantId: number;
  label: string;
}

export type RuleScope = "Global" | "Category" | "Product" | "Variant";

interface RuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the dialog edits that rule; otherwise it creates one. */
  rule?: PricingRule | null;
  /** Initial scope (e.g. Variant overrides opened from the matrix). */
  initialScope?: RuleScope;
  initialVariant?: RuleDialogVariant | null;
  categories: RuleDialogCategory[];
  products: { productId: number; label: string; variants: RuleDialogVariant[] }[];
}

/** Extract a readable message from an axios error response. */
export function extractApiError(err: unknown, fallback: string): string {
  if (
    typeof err === "object" &&
    err !== null &&
    "response" in err &&
    typeof (err as { response?: { data?: { message?: string } } }).response === "object"
  ) {
    const message = (err as { response?: { data?: { message?: string } } }).response?.data
      ?.message;
    if (message) return message;
  }
  return fallback;
}

/**
 * Create/edit dialog for pricing rules. Scope: whole business, one category,
 * one product or one variant — exactly one (mirrors the DB scope CHECK).
 */
export function RuleDialog({
  open,
  onOpenChange,
  rule,
  initialScope,
  initialVariant,
  categories,
  products,
}: RuleDialogProps) {
  const createRule = useCreateRule();
  const updateRule = useUpdateRule();
  const editing = rule != null;

  const [scope, setScope] = useState<RuleScope>("Global");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [productId, setProductId] = useState<number | null>(null);
  const [variantId, setVariantId] = useState<number | null>(null);
  const [method, setMethod] = useState<PricingMethod>("markup");
  const [percentage, setPercentage] = useState("");
  const [fixedPrice, setFixedPrice] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (rule) {
      setScope(rule.scope);
      setCategoryId(rule.categoryId);
      setProductId(rule.productId);
      setVariantId(rule.variantId);
      setMethod(rule.method);
      setPercentage(rule.percentage != null ? String(rule.percentage) : "");
      setFixedPrice(rule.fixedPrice != null ? String(rule.fixedPrice) : "");
      setIsActive(rule.isActive);
    } else {
      setScope(initialScope ?? "Global");
      setCategoryId(null);
      setVariantId(initialVariant?.variantId ?? null);
      // Derive the product from the initial variant when provided.
      setProductId(null);
      if (initialVariant) {
        const owner = products.find((p) =>
          p.variants.some((v) => v.variantId === initialVariant.variantId),
        );
        setProductId(owner?.productId ?? null);
      }
      setMethod("markup");
      setPercentage("");
      setFixedPrice("");
      setIsActive(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule]);

  const variantsForProduct = useMemo(
    () => products.find((p) => p.productId === productId)?.variants ?? [],
    [products, productId],
  );

  async function submit() {
    const payload: {
      categoryId: number | null;
      productId: number | null;
      variantId: number | null;
      method: PricingMethod;
      percentage: number | null;
      fixedPrice: number | null;
      isActive: boolean;
    } = {
      categoryId: scope === "Category" ? categoryId : null,
      productId: scope === "Product" || scope === "Variant" ? productId : null,
      variantId: scope === "Variant" ? variantId : null,
      method,
      percentage: method === "fixed" ? null : Number(percentage),
      fixedPrice: method === "fixed" ? Number(fixedPrice) : null,
      isActive,
    };
    if (method === "fixed") {
      if (!Number.isFinite(payload.fixedPrice) || payload.fixedPrice! < 0) {
        toast.add({ type: "error", description: "Enter a valid fixed price.", priority: "high" });
        return;
      }
    } else {
      const pct = payload.percentage;
      if (!Number.isFinite(pct) || pct! < 0 || pct! > 100) {
        toast.add({
          type: "error",
          description: "Enter a percentage between 0 and 100 (margin below 100).",
          priority: "high",
        });
        return;
      }
      if (method === "margin" && pct! >= 100) {
        toast.add({
          type: "error",
          description: "Margin must be below 100%.",
          priority: "high",
        });
        return;
      }
    }
    if (scope === "Category" && categoryId == null) {
      toast.add({ type: "error", description: "Pick a category.", priority: "high" });
      return;
    }
    if ((scope === "Product" || scope === "Variant") && productId == null) {
      toast.add({ type: "error", description: "Pick a product.", priority: "high" });
      return;
    }
    if (scope === "Variant" && variantId == null) {
      toast.add({ type: "error", description: "Pick a variant.", priority: "high" });
      return;
    }

    setBusy(true);
    try {
      if (editing) {
        await updateRule.mutateAsync({ id: rule!.id, payload });
        toast.add({ type: "success", description: "Pricing rule updated." });
      } else {
        await createRule.mutateAsync(payload);
        toast.add({ type: "success", description: "Pricing rule created." });
      }
      onOpenChange(false);
    } catch (err) {
      toast.add({
        type: "error",
        description: extractApiError(err, "Could not save the pricing rule."),
        priority: "high",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit pricing rule" : "New pricing rule"}</DialogTitle>
          <DialogDescription>
            Rules say how to CALCULATE a price. Applying one to the effective
            selling price is a separate, audited action on the Product Pricing
            page.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-1.5">
            {(["Global", "Category", "Product", "Variant"] as RuleScope[]).map((s) => (
              <button
                key={s}
                type="button"
                disabled={editing}
                onClick={() => setScope(s)}
                className={`rounded-md border px-2.5 py-1.5 text-sm ${
                  scope === s ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                } ${editing ? "opacity-60" : ""}`}
              >
                {s}
              </button>
            ))}
          </div>
          {scope === "Category" && (
            <div className="space-y-1">
              <Label>Category</Label>
              <select
                className="w-full rounded-md border bg-background p-2 text-sm"
                value={categoryId ?? ""}
                onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="" disabled>
                  Select a category…
                </option>
                {categories.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {(scope === "Product" || scope === "Variant") && (
            <div className="space-y-1">
              <Label>Product</Label>
              <select
                className="w-full rounded-md border bg-background p-2 text-sm"
                value={productId ?? ""}
                onChange={(e) => {
                  setProductId(e.target.value ? Number(e.target.value) : null);
                  setVariantId(null);
                }}
              >
                <option value="" disabled>
                  Select a product…
                </option>
                {products.map((p) => (
                  <option key={p.productId} value={p.productId}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {scope === "Variant" && (
            <div className="space-y-1">
              <Label>Variant</Label>
              <select
                className="w-full rounded-md border bg-background p-2 text-sm"
                value={variantId ?? ""}
                onChange={(e) => setVariantId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="" disabled>
                  Select a variant…
                </option>
                {variantsForProduct.map((v) => (
                  <option key={v.variantId} value={v.variantId}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex gap-1.5">
            {(["markup", "margin", "fixed"] as PricingMethod[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMethod(m)}
                className={`rounded-md border px-2.5 py-1.5 text-sm capitalize ${
                  method === m ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          {method === "fixed" ? (
            <div className="space-y-1">
              <Label>Fixed selling price</Label>
              <Input
                type="number"
                min={0}
                step={0.01}
                value={fixedPrice}
                onChange={(e) => setFixedPrice(e.target.value)}
                placeholder="199.99"
              />
            </div>
          ) : (
            <div className="space-y-1">
              <Label>{method === "markup" ? "Markup (%)" : "Target margin (%)"}</Label>
              <Input
                type="number"
                min={0}
                max={100}
                step={0.001}
                value={percentage}
                onChange={(e) => setPercentage(e.target.value)}
                placeholder={method === "markup" ? "30" : "20"}
              />
              {method === "margin" && (
                <p className="text-xs text-muted-foreground">
                  Margin is profit ÷ price — cost 100 at 20% margin → price 125.
                </p>
              )}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Switch checked={isActive} onCheckedChange={setIsActive} />
            <span className="text-sm">Active</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {editing ? "Save changes" : "Create rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
