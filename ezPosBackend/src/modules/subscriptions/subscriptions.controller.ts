import type { Request, Response } from "express";
import {
  cancelSubscription,
  changePlan,
  getInvoice,
  getOpenSubscription,
  listInvoices,
  listPayments,
  reactivateSubscription,
  renewSubscription,
} from "./subscription.service.js";
import {
  cancelSubscriptionSchema,
  changePlanSchema,
} from "./subscriptions.validation.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";

/**
 * Customer portal endpoints for subscription management and billing.
 * Deliberately reachable in READ-ONLY mode: an expired/canceled customer
 * must always be able to reach their billing portal and choose a plan
 * again. The verified businessId comes from the membership middleware —
 * a customer can never touch another business's subscription or invoices.
 */

function actor(req: Request) {
  return { type: "customer" as const, userId: req.user!.id };
}

export async function changeSubscriptionPlan(req: Request, res: Response) {
  const parsed = changePlanSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "A valid plan is required.",
    });
  }
  try {
    const result = await changePlan(
      getBusinessId(req),
      parsed.data.planId,
      actor(req),
    );
    res.status(200).json({
      success: true,
      message:
        result.outcome === "upgraded"
          ? "Plan upgraded. A prorated invoice was issued."
          : result.outcome === "scheduled"
            ? "Downgrade scheduled — it takes effect at the end of the current period."
            : "Plan changed.",
      data: {
        outcome: result.outcome,
        subscription: result.subscription,
        invoice: result.invoice,
      },
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to change the plan right now.");
  }
}

export async function cancelMySubscription(req: Request, res: Response) {
  const parsed = cancelSubscriptionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: "Invalid cancellation request.",
    });
  }
  try {
    const result = await cancelSubscription(
      getBusinessId(req),
      actor(req),
      { immediate: parsed.data.immediate === true },
    );
    res.status(200).json({
      success: true,
      message:
        result.outcome === "canceled"
          ? "Subscription canceled."
          : "Cancellation scheduled — your plan stays active until the end of the current period.",
      data: result,
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to cancel the subscription right now.");
  }
}

export async function reactivateMySubscription(req: Request, res: Response) {
  try {
    await reactivateSubscription(getBusinessId(req), actor(req));
    res.status(200).json({
      success: true,
      message: "Subscription reactivated — it will renew as usual.",
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to reactivate the subscription right now.");
  }
}

export async function renewMySubscription(req: Request, res: Response) {
  try {
    const subscription = await renewSubscription(
      getBusinessId(req),
      actor(req),
    );
    res.status(200).json({
      success: true,
      message: "Subscription renewed. An invoice was issued for the new period.",
      data: subscription,
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to renew the subscription right now.");
  }
}

export async function getCurrentSubscription(req: Request, res: Response) {
  try {
    const subscription = await getOpenSubscription(getBusinessId(req));
    res.status(200).json({ success: true, data: subscription });
  } catch (err) {
    sendSafeError(res, err, "Unable to load the subscription right now.");
  }
}

export async function getInvoices(req: Request, res: Response) {
  try {
    const page = Number(req.query.page);
    const pageSize = Number(req.query.pageSize);
    res.status(200).json({
      success: true,
      data: await listInvoices(getBusinessId(req), {
        page: Number.isInteger(page) && page > 0 ? page : undefined,
        pageSize:
          Number.isInteger(pageSize) && pageSize > 0 ? pageSize : undefined,
      }),
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to load invoices right now.");
  }
}

export async function getInvoiceDetail(req: Request, res: Response) {
  const invoiceId = Number(req.params.invoiceId);
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
    return res
      .status(400)
      .json({ success: false, message: "A valid invoice ID is required." });
  }
  try {
    const invoice = await getInvoice(getBusinessId(req), invoiceId);
    if (!invoice) {
      // Same response for missing and foreign invoices.
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found." });
    }
    res.status(200).json({ success: true, data: invoice });
  } catch (err) {
    sendSafeError(res, err, "Unable to load the invoice right now.");
  }
}

export async function getPayments(req: Request, res: Response) {
  try {
    const page = Number(req.query.page);
    const pageSize = Number(req.query.pageSize);
    res.status(200).json({
      success: true,
      data: await listPayments(getBusinessId(req), {
        page: Number.isInteger(page) && page > 0 ? page : undefined,
        pageSize:
          Number.isInteger(pageSize) && pageSize > 0 ? pageSize : undefined,
      }),
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to load payments right now.");
  }
}
