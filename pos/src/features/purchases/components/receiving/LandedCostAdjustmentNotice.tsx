import { Link } from "react-router";
import { Landmark, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LandedCostFeedback } from "../../purchase.types";

/**
 * Post-operation landed-cost feedback banner. The amounts shown are the
 * backend's authoritative figures — this component never computes
 * landed-cost amounts itself.
 *
 * Phase 3: the RETURN variant also carries the supplier-credit split and
 * renders whenever there is return feedback — even with no landed-cost
 * reversal (a credit is real money owed by the supplier regardless).
 * Supplier credit is NOT cash: the system records credits on the supplier
 * ledger; recording an actual cash refund is a separate future feature.
 */
function LandedCostFeedbackNotice({
  purchaseId,
  landedCost,
  kind,
  supplierBalance,
  returnedSerials,
  onDismiss,
}: {
  purchaseId: number;
  landedCost: LandedCostFeedback;
  kind: "adjustment" | "reversal";
  supplierBalance?:
    | {
        outstandingBefore: number;
        goodsCredit: number;
        outstandingAfter: number;
        supplierCreditCreated: number;
      }
    | undefined;
  returnedSerials?: string[] | undefined;
  onDismiss?: (() => void) | undefined;
}) {
  if (kind === "adjustment" && !landedCost.adjusted) return null;
  if (kind === "reversal" && !landedCost.adjusted && !supplierBalance) {
    return null;
  }

  const money = new Intl.NumberFormat("en-BD", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const amountLabel = money.format(landedCost.amount);
  const sentence =
    kind === "adjustment"
      ? `Landed cost adjusted by ৳ ${amountLabel} for this receipt — the posted landed-cost document was updated automatically.`
      : `Landed cost reversed by ৳ ${amountLabel} for this return — the allocated cost of the returned units left inventory valuation.`;

  // Phase 3 credit split (return only): total supplier credit = goods
  // credit + landed reversal; credit beyond the outstanding due is a
  // credit balance, not cash.
  const totalSupplierCredit =
    kind === "reversal" && supplierBalance
      ? money.format(
          supplierBalance.goodsCredit +
            (landedCost.adjusted ? landedCost.amount : 0),
        )
      : null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm"
    >
      <Landmark className="size-4 shrink-0 text-violet-600" />
      <div className="min-w-0 flex-1">
        {kind === "reversal" ? (
          <>
            {landedCost.adjusted && (
              <p className="text-violet-900">{sentence}</p>
            )}
            {returnedSerials && returnedSerials.length > 0 && (
              <p
                className="text-violet-900"
                data-testid="returned-serials-line"
              >
                Returned serial numbers ({returnedSerials.length}):{" "}
                <span className="font-mono">
                  {returnedSerials.slice(0, 10).join(", ")}
                  {returnedSerials.length > 10
                    ? ` … and ${returnedSerials.length - 10} more`
                    : ""}
                </span>
              </p>
            )}
            {supplierBalance && (
              <p className="text-violet-900">
                Supplier credit: ৳ {money.format(supplierBalance.goodsCredit)}{" "}
                goods credit
                {landedCost.adjusted
                  ? " + landed-cost reversal"
                  : ` (no reversal — ${landedCost.reason ?? "not applicable"})`}{" "}
                = ৳ {totalSupplierCredit} total.{" "}
                {supplierBalance.supplierCreditCreated > 0 ? (
                  <>
                    The purchase is fully settled — ৳{" "}
                    {money.format(supplierBalance.supplierCreditCreated)}{" "}
                    becomes supplier credit balance (owed by the supplier —
                    not a cash refund).
                  </>
                ) : (
                  <>
                    Purchase outstanding reduced to ৳{" "}
                    {money.format(supplierBalance.outstandingAfter)}.
                  </>
                )}
              </p>
            )}
          </>
        ) : (
          <p className="flex-1 text-violet-900">{sentence}</p>
        )}
      </div>
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
          nativeButton
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
