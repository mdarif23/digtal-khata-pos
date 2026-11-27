import { useTranslation } from "react-i18next";
import { Gift } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/format";
import { useActiveBundles } from "../../bundles.api.js";
import { useBundleQuickAdd, summarizeComponents } from "../../hooks/useBundleQuickAdd.js";
import { bundleSavings } from "../../bundleCart.js";

/**
 * Bundle & Combo Phase 2 — POS offer strip: live fixed bundles with a
 * one-tap "Add bundle" action (tops the cart up to the requirement).
 * Renders nothing while loading, offline, or when the business has no live
 * bundles — scanning and the product grid stay untouched.
 */
export function BundleCards() {
  const { t } = useTranslation();
  const bundlesQuery = useActiveBundles();
  const quickAdd = useBundleQuickAdd();

  if (!bundlesQuery.isSuccess) return null;
  const bundles = bundlesQuery.data;
  if (bundles.length === 0) return null;

  return (
    <div className="col-span-full">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Gift className="h-3.5 w-3.5" />
        {t("pos:bundleOffers", { defaultValue: "Bundle offers" })}
      </div>
      <div className="mt-1.5 flex gap-2 overflow-x-auto pb-1">
        {bundles.map((bundle) => {
          const savings = bundleSavings(bundle);
          const price =
            typeof bundle.rule?.bundlePrice === "number"
              ? bundle.rule.bundlePrice
              : null;
          return (
            <div
              key={bundle.id}
              className="flex min-w-[16rem] max-w-[22rem] shrink-0 items-center justify-between gap-2 rounded-md border bg-muted/30 p-2.5"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{bundle.name}</span>
                  {savings != null && savings > 0 && (
                    <Badge variant="outline" className="shrink-0 text-success">
                      {t("pos:bundleSave", {
                        defaultValue: "Save {{amount}}",
                        amount: formatCurrency(savings),
                      })}
                    </Badge>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {summarizeComponents(bundle)}
                  {price != null && ` · ${formatCurrency(price)}`}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => void quickAdd(bundle)}
              >
                {t("pos:bundleAdd", { defaultValue: "Add bundle" })}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The "complete the bundle" affordance on a near-miss chip (Bundle & Combo
 * Phase 2): renders ONLY for bundle promotions — other kinds keep their
 * static chip. Topping up uses the same one-tap path as the cards.
 */
export function BundleCompleteButton({ promotionId }: { promotionId: number }) {
  const { t } = useTranslation();
  const bundlesQuery = useActiveBundles();
  const quickAdd = useBundleQuickAdd();
  const bundle = bundlesQuery.data?.find((b) => b.id === promotionId);
  if (!bundle) return null; // non-bundle near-miss — not actionable
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-5 shrink-0 px-1.5 py-0 text-xs text-warning"
      onClick={() => void quickAdd(bundle)}
    >
      {t("pos:bundleComplete", { defaultValue: "Add missing" })}
    </Button>
  );
}
