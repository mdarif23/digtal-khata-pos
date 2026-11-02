import type { Request, Response } from "express";
import * as saasAdminService from "./saasAdmin.service.js";
import { runSubscriptionSweeps } from "../../jobs/subscriptionJobs.js";
import { runCommerceSweeps } from "../../jobs/commerceJobs.js";
import { sendSafeError } from "../../utils/safeError.js";
import { z } from "zod";

const changePlanSchema = z.object({ planId: z.number().int().positive() });
const extendSchema = z.object({ days: z.number().int().min(1).max(365) });
const grantTrialSchema = z.object({ days: z.number().int().min(1).max(90) });
const suspendSchema = z.object({ reason: z.string().trim().max(500).optional() });
const ticketReplySchema = z.object({ body: z.string().trim().min(1).max(5000) });
const ticketStatusSchema = z.object({
  status: z.enum(["open", "pending", "resolved", "closed"]),
});

export async function getOverview(_req: Request, res: Response) {
  try {
    res
      .status(200)
      .json({ success: true, data: await saasAdminService.getOverview() });
  } catch (err) {
    sendSafeError(res, err, "Unable to load SaaS metrics right now.");
  }
}

export async function getBusinesses(req: Request, res: Response) {
  try {
    res.status(200).json({
      success: true,
      data: await saasAdminService.listBusinesses({
        search: typeof req.query.search === "string" ? req.query.search : undefined,
        status: typeof req.query.status === "string" ? req.query.status : undefined,
      }),
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to load businesses right now.");
  }
}

export async function setBusinessStatus(req: Request, res: Response) {
  const businessId = Number(req.params.businessId);
  const status = req.body?.status === "suspended" ? "suspended" : req.body?.status === "active" ? "active" : null;
  if (!Number.isInteger(businessId) || businessId <= 0 || status === null) {
    return res.status(400).json({
      success: false,
      message: "A valid business ID and status (active|suspended) are required.",
    });
  }
  try {
    await saasAdminService.setBusinessStatus(
      businessId,
      status,
      { adminUserId: req.user!.id },
      typeof req.body?.reason === "string" ? req.body.reason : undefined,
    );
    res.status(200).json({
      success: true,
      message: status === "suspended" ? "Business suspended." : "Business reactivated.",
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to update the business right now.");
  }
}

export async function getSubscriptions(req: Request, res: Response) {
  try {
    res.status(200).json({
      success: true,
      data: await saasAdminService.listSubscriptions({
        status: typeof req.query.status === "string" ? req.query.status : undefined,
      }),
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to load subscriptions right now.");
  }
}

export async function changeSubscriptionPlan(req: Request, res: Response) {
  const subscriptionId = Number(req.params.subscriptionId);
  const parsed = changePlanSchema.safeParse(req.body);
  if (!Number.isInteger(subscriptionId) || subscriptionId <= 0 || !parsed.success) {
    return res.status(400).json({
      success: false,
      message: "A valid subscription ID and planId are required.",
    });
  }
  try {
    const result = await saasAdminService.adminChangePlan(
      subscriptionId,
      parsed.data.planId,
      req.user!.id,
    );
    res.status(200).json({ success: true, data: { outcome: result.outcome } });
  } catch (err) {
    sendSafeError(res, err, "Unable to change the plan right now.");
  }
}

export async function extendSubscription(req: Request, res: Response) {
  const subscriptionId = Number(req.params.subscriptionId);
  const parsed = extendSchema.safeParse(req.body);
  if (!Number.isInteger(subscriptionId) || subscriptionId <= 0 || !parsed.success) {
    return res.status(400).json({
      success: false,
      message: "A valid subscription ID and days (1-365) are required.",
    });
  }
  try {
    const newEnd = await saasAdminService.adminExtend(
      subscriptionId,
      parsed.data.days,
      req.user!.id,
    );
    res.status(200).json({
      success: true,
      message: `Subscription extended by ${parsed.data.days} days.`,
      data: { currentPeriodEnd: newEnd },
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to extend the subscription right now.");
  }
}

export async function grantTrial(req: Request, res: Response) {
  const businessId = Number(req.params.businessId);
  const parsed = grantTrialSchema.safeParse(req.body);
  if (!Number.isInteger(businessId) || businessId <= 0 || !parsed.success) {
    return res.status(400).json({
      success: false,
      message: "A valid business ID and days (1-90) are required.",
    });
  }
  try {
    const subscription = await saasAdminService.adminGrantTrial(
      businessId,
      parsed.data.days,
      req.user!.id,
    );
    res.status(200).json({
      success: true,
      message: `Trial granted for ${parsed.data.days} days.`,
      data: subscription,
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to grant the trial right now.");
  }
}

export async function subscriptionStatusAction(req: Request, res: Response) {
  const subscriptionId = Number(req.params.subscriptionId);
  // The route is registered as three explicit paths (Express 5 path-to-regexp
  // rejects regex params), so the action comes from the URL tail.
  const action = (req.originalUrl ?? "").split("?")[0]!.split("/").pop() ?? "";
  if (!Number.isInteger(subscriptionId) || subscriptionId <= 0) {
    return res
      .status(400)
      .json({ success: false, message: "A valid subscription ID is required." });
  }
  try {
    if (action === "suspend") {
      await saasAdminService.adminSuspendSubscription(
        subscriptionId,
        req.user!.id,
        typeof req.body?.reason === "string" ? req.body.reason : undefined,
      );
      return res.status(200).json({ success: true, message: "Subscription suspended." });
    }
    if (action === "reactivate") {
      await saasAdminService.adminUnsuspendSubscription(subscriptionId, req.user!.id);
      return res.status(200).json({ success: true, message: "Subscription reactivated." });
    }
    if (action === "cancel") {
      await saasAdminService.adminCancelSubscription(subscriptionId, req.user!.id);
      return res.status(200).json({ success: true, message: "Subscription canceled." });
    }
    return res.status(404).json({ success: false, message: "Unknown action." });
  } catch (err) {
    sendSafeError(res, err, "Unable to update the subscription right now.");
  }
}

export async function getPayments(req: Request, res: Response) {
  try {
    res.status(200).json({
      success: true,
      data: await saasAdminService.listAllPayments({
        status: typeof req.query.status === "string" ? req.query.status : undefined,
        provider: typeof req.query.provider === "string" ? req.query.provider : undefined,
      }),
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to load payments right now.");
  }
}

export async function getInvoices(_req: Request, res: Response) {
  try {
    res
      .status(200)
      .json({ success: true, data: await saasAdminService.listAllInvoices() });
  } catch (err) {
    sendSafeError(res, err, "Unable to load invoices right now.");
  }
}

export async function getTickets(req: Request, res: Response) {
  try {
    res.status(200).json({
      success: true,
      data: await saasAdminService.listAllTickets({
        status: typeof req.query.status === "string" ? req.query.status : undefined,
      }),
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to load tickets right now.");
  }
}

export async function getTicket(req: Request, res: Response) {
  const ticketId = Number(req.params.ticketId);
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    return res
      .status(400)
      .json({ success: false, message: "A valid ticket ID is required." });
  }
  try {
    res.status(200).json({
      success: true,
      data: await saasAdminService.getTicketAdmin(ticketId),
    });
  } catch (err) {
    sendSafeError(res, err, "Ticket not found.");
  }
}

export async function replyTicket(req: Request, res: Response) {
  const ticketId = Number(req.params.ticketId);
  const parsed = ticketReplySchema.safeParse(req.body);
  if (!Number.isInteger(ticketId) || ticketId <= 0 || !parsed.success) {
    return res.status(400).json({
      success: false,
      message: "A valid ticket ID and message body are required.",
    });
  }
  try {
    const message = await saasAdminService.adminReplyToTicket(
      ticketId,
      req.user!.id,
      parsed.data.body,
    );
    res.status(201).json({ success: true, data: message });
  } catch (err) {
    sendSafeError(res, err, "Unable to add the reply right now.");
  }
}

export async function updateTicketStatus(req: Request, res: Response) {
  const ticketId = Number(req.params.ticketId);
  const parsed = ticketStatusSchema.safeParse(req.body);
  if (!Number.isInteger(ticketId) || ticketId <= 0 || !parsed.success) {
    return res.status(400).json({
      success: false,
      message: "A valid ticket ID and status are required.",
    });
  }
  try {
    await saasAdminService.setTicketStatus(
      ticketId,
      parsed.data.status,
      req.user!.id,
    );
    res.status(200).json({ success: true, message: "Ticket status updated." });
  } catch (err) {
    sendSafeError(res, err, "Unable to update the ticket right now.");
  }
}

/** Manual trigger for the subscription lifecycle sweeps (ops convenience). */
export async function runJobs(_req: Request, res: Response) {
  try {
    const [results, commerce] = await Promise.all([
      runSubscriptionSweeps(),
      runCommerceSweeps(),
    ]);
    const merged = { ...results, ...commerce };
    await saasAdminService.audit(
      { adminUserId: _req.user!.id },
      "jobs_manual_run",
      "system",
      null,
      merged as unknown as Record<string, unknown>,
    );
    res.status(200).json({ success: true, data: merged });
  } catch (err) {
    sendSafeError(res, err, "Unable to run the background jobs right now.");
  }
}
