import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { getEntitlements, type PlanFeatureKey } from "../services/entitlements.js";
import { getBusinessId } from "./business.js";
import { db } from "../db/schema/index.js";
import { subscriptionPlans } from "../db/schema/subscriptionPlans.js";

/**
 * Names of the active plans whose feature flags include `feature` — so the
 * 403 body can tell the user exactly which plan to upgrade to instead of a
 * generic "not in your plan".
 */
async function plansWithFeature(feature: PlanFeatureKey): Promise<string[]> {
  const rows = await db
    .select({ name: subscriptionPlans.name, features: subscriptionPlans.features })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.isActive, true));
  return rows
    .filter((row) => row.features?.[feature] === true)
    .map((row) => row.name);
}

/**
 * Route-level feature gate: the business's current plan must include the
 * feature. Read-only (GET) so it works regardless of subscription access
 * mode — plan gating is orthogonal to trial-expiry gating (requireFullAccess).
 * Returns 403 FEATURE_NOT_IN_PLAN when the plan lacks the feature.
 */
export function requireFeature(feature: PlanFeatureKey) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const entitlements = await getEntitlements(getBusinessId(req));
      if (entitlements.plan?.features?.[feature] === true) {
        next();
        return;
      }
      const upgradePlans = await plansWithFeature(feature);
      return res.status(403).json({
        success: false,
        code: "FEATURE_NOT_IN_PLAN",
        message:
          "This feature is not part of your current plan. Upgrade to unlock it.",
        upgradePlans,
      });
    } catch (err) {
      console.error("Feature check failed:", err);
      return res.status(500).json({
        success: false,
        message: "Unable to verify your plan entitlements right now.",
      });
    }
  };
}
