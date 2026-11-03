import type { Request, Response } from "express";
import { z } from "zod";
import {
  createBusinessForUser,
  deleteBusinessForMembership,
  getBusinessForMembership,
  removeBusinessLogoForMembership,
  setBusinessLogoForMembership,
  updateBusinessForMembership,
} from "./businesses.service.js";
import {
  createBusinessSchema,
  updateBusinessSchema,
} from "./businesses.validation.js";
import { sendSafeError } from "../../utils/safeError.js";
import { env } from "../../config/env.js";
import { getEntitlements, getBusinessUsage } from "../../services/entitlements.js";
import { getSubscriptionHistory } from "../subscriptions/subscription.service.js";
import { sendEmail } from "../../services/email/email.service.js";
import { renderWelcome, renderTrialStarted } from "../../services/email/email.templates.js";

export async function createBusiness(req: Request, res: Response) {
  try {
    if (!req.user) {
      return res
        .status(401)
        .json({ success: false, message: "Authentication required." });
    }
    const parsed = createBusinessSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message:
          parsed.error.issues[0]?.message ?? "Invalid business details.",
      });
    }
    const result = await createBusinessForUser(req.user.id, parsed.data);

    // Best-effort onboarding emails — never fail the creation itself.
    if (req.user.email) {
      void sendEmail({
        to: req.user.email,
        ...renderWelcome(req.user.fullName),
      }).then((delivery) => {
        if (!delivery.ok) {
          console.error(
            `Welcome email failed for ${req.user?.email}: ${delivery.error}`,
          );
        }
      });
      if (result.subscription?.currentPeriodEnd && !result.trialSkipped) {
        void sendEmail({
          to: req.user.email,
          ...renderTrialStarted(
            result.business.name,
            env.trialDays,
            result.subscription.currentPeriodEnd,
          ),
        }).then((delivery) => {
          if (!delivery.ok) {
            console.error(
              `Trial-started email failed for ${req.user?.email}: ${delivery.error}`,
            );
          }
        });
      }
    }

    return res.status(201).json({
      success: true,
      message: result.trialSkipped
        ? "Business created. Free-trial activation is pending until the trial plan is configured."
        : "Business created. Your free trial is active.",
      ...result,
    });
  } catch (err) {
    return sendSafeError(res, err, "Unable to create the business right now.");
  }
}

export async function getBusiness(req: Request, res: Response) {
  try {
    if (!req.user || !req.membership) {
      return res
        .status(401)
        .json({ success: false, message: "Authentication required." });
    }
    const detail = await getBusinessForMembership(
      req.user.id,
      req.membership.businessId,
    );
    return res.status(200).json({ success: true, business: detail });
  } catch (err) {
    return sendSafeError(res, err, "Unable to load the business right now.");
  }
}

export async function updateBusiness(req: Request, res: Response) {
  try {
    if (!req.user || !req.membership) {
      return res
        .status(401)
        .json({ success: false, message: "Authentication required." });
    }
    const parsed = updateBusinessSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message ?? "Invalid business details.",
      });
    }
    const detail = await updateBusinessForMembership(
      req.user.id,
      req.membership.businessId,
      parsed.data,
    );
    return res.status(200).json({ success: true, business: detail });
  } catch (err) {
    return sendSafeError(res, err, "Unable to update the business right now.");
  }
}

export async function deleteBusiness(req: Request, res: Response) {
  try {
    if (!req.user || !req.membership) {
      return res
        .status(401)
        .json({ success: false, message: "Authentication required." });
    }
    // Deliberately available regardless of subscription access mode: an
    // owner must always be able to close a business, even read-only ones.
    await deleteBusinessForMembership(
      req.user.id,
      req.membership.businessId,
    );
    return res.status(200).json({
      success: true,
      message: "Business deleted. It no longer appears in your account.",
    });
  } catch (err) {
    return sendSafeError(res, err, "Unable to delete the business right now.");
  }
}

const setLogoSchema = z.object({
  dataUrl: z.string(),
});

/** PUT /api/businesses/:businessId/logo — body { dataUrl } (validated in service). */
export async function setBusinessLogo(req: Request, res: Response) {
  try {
    if (!req.user || !req.membership) {
      return res
        .status(401)
        .json({ success: false, message: "Authentication required." });
    }
    const parsed = setLogoSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Provide the logo as a { dataUrl } string.",
      });
    }
    const detail = await setBusinessLogoForMembership(
      req.user.id,
      req.membership.businessId,
      parsed.data.dataUrl,
    );
    return res.status(200).json({
      success: true,
      message: "Logo saved.",
      logoUrl: detail.logoUrl,
    });
  } catch (err) {
    return sendSafeError(res, err, "Unable to save the logo right now.");
  }
}

/** DELETE /api/businesses/:businessId/logo — clears the business logo. */
export async function removeBusinessLogo(req: Request, res: Response) {
  try {
    if (!req.user || !req.membership) {
      return res
        .status(401)
        .json({ success: false, message: "Authentication required." });
    }
    const detail = await removeBusinessLogoForMembership(
      req.user.id,
      req.membership.businessId,
    );
    return res.status(200).json({
      success: true,
      message: "Logo removed.",
      logoUrl: detail.logoUrl,
    });
  } catch (err) {
    return sendSafeError(res, err, "Unable to remove the logo right now.");
  }
}

export async function getBusinessSubscription(req: Request, res: Response) {
  try {
    if (!req.user || !req.membership) {
      return res
        .status(401)
        .json({ success: false, message: "Authentication required." });
    }
    if (!req.subscriptionAccess) {
      return res.status(500).json({
        success: false,
        message: "Subscription state was not evaluated for this request.",
      });
    }
    const businessId = req.membership.businessId;
    // Portal-ready payload: access state plus the plan's entitlements, the
    // business's usage against plan limits, and the lifecycle audit trail.
    const [entitlements, usage, history] = await Promise.all([
      getEntitlements(businessId),
      getBusinessUsage(businessId),
      getSubscriptionHistory(businessId),
    ]);
    return res.status(200).json({
      success: true,
      subscription: req.subscriptionAccess,
      plan: entitlements.plan,
      usage,
      events: history,
    });
  } catch (err) {
    return sendSafeError(
      res,
      err,
      "Unable to load the subscription state right now.",
    );
  }
}
