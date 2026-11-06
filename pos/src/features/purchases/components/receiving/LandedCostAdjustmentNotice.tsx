import { Link } from "react-router";
import { Landmark, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LandedCostFeedback } from "../../purchase.types";

/**
 * Post-operation landed-cost feedback banner. The amounts shown are the
 * backend's authoritative figures — this component never computes
 * landed-cost amounts itself.
 */
function LandedCostFeedbackNotice({
  purchaseId,
  landedCost,
  kind,
  onDismiss,
}: {
  purchaseId: number;
  landedCost: LandedCostFeedback;
  kind: "adjustment" | "reversal";
  onDismiss?: () => void;
}) {
  if (!landedCost.adjusted) return null;

  const amountLabel = new Intl.NumberFormat("en-BD", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(landedCost.amount);
  const sentence =
    kind === "adjustment"
      ? `Landed cost adjusted by ৳ ${amountLabel} for this receipt — the posted landed-cost document was updated automatically.`
      : `Landed cost reversed by ৳ ${amountLabel} for this return — the allocated cost of the returned units left inventory valuation.`;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm"
    >
      <Landmark className="size-4 shrink-0 text-violet-600" />
      <p className="flex-1 text-violet-900">{sentence}</p>
      <Button
        nativeButton={false}
        size="sm"
        variant="outline"
        render={
          <Link to={`/purchases/landed-cost/${purchaseId}`} />
        }
      >
        View landed-cost document
      </Button>
      {onDismiss && (
        <Button
          nativeButton={false}
          size="icon"
          variant="ghost"
          aria-label="Dismiss landed cost notice"
          onClick={onDismiss}
        >
          <X className="size-4" />
        </Button>
      )}
    </div>
  );
}

/** Shown after a receive that triggered a landed-cost adjustment delta. */
export function LandedCostAdjustmentNotice(
  props: Omit<Parameters<typeof LandedCostFeedbackNotice>[0], "kind">,
) {
  return <LandedCostFeedbackNotice {...props} kind="adjustment" />;
}

/** Shown after a purchase return that reversed allocated landed cost. */
export function LandedCostReversalNotice(
  props: Omit<Parameters<typeof LandedCostFeedbackNotice>[0], "kind">,
) {
  return <LandedCostFeedbackNotice {...props} kind="reversal" />;
}
