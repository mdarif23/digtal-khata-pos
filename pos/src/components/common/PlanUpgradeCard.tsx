import { Lock, ExternalLink } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { EntitlementErrorInfo } from "@/hooks/usePlanUpgrade";

/**
 * Shown instead of a generic error when a feature is gated behind the
 * business's subscription plan (403 FEATURE_NOT_IN_PLAN). Names the plans
 * that include the feature and links to the website's subscription page
 * where the plan can be changed. Shared by every requireFeature-gated
 * surface (reports pioneered it; stock transfers and others reuse it).
 */
export function PlanUpgradeCard({
  gate,
  title = "Plan upgrade required",
  featureLabel = "This feature",
}: {
  gate: EntitlementErrorInfo;
  title?: string;
  featureLabel?: string;
}) {
  const websiteUrl =
    import.meta.env.VITE_WEBSITE_URL || "http://localhost:3001";
  const planNames =
    gate.upgradePlans.length > 0
      ? gate.upgradePlans.join(" or ")
      : "a higher";

  return (
    <Card className="border-amber-200 bg-amber-50/60">
      <CardContent className="flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700">
          <Lock className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          <p className="mt-0.5 text-sm text-slate-600">
            {featureLabel} is not available on your current plan. Upgrade to
            the{" "}
            <span className="font-medium text-slate-900">{planNames}</span>{" "}
            plan to unlock it.
          </p>
        </div>
        <a
          href={`${websiteUrl}/account/subscription`}
          target="_blank"
          rel="noreferrer"
          className={cn(buttonVariants())}
        >
          Upgrade plan
          <ExternalLink className="ml-1 size-4" />
        </a>
      </CardContent>
    </Card>
  );
}
