import type { Request, Response } from "express";
import { z } from "zod";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import {
  assertFeature,
  assertWithinWebhookLimit,
  countWebhookEndpoints,
  getEntitlements,
} from "../../services/entitlements.js";
import {
  WEBHOOK_EVENTS,
  createEndpoint,
  deleteEndpoint,
  listDeliveries,
  listEndpoints,
  sendTestEvent,
  type WebhookEvent,
} from "./webhookDelivery.service.js";

const createSchema = z.object({
  url: z
    .string()
    .trim()
    .url("Enter a valid HTTPS endpoint URL")
    .max(500)
    .refine(
      (value) =>
        value.startsWith("https://") ||
        value.startsWith("http://localhost") ||
        value.startsWith("http://127.0.0.1"),
      {
        message: "Use HTTPS (or localhost for development).",
      },
    ),
  events: z
    .array(z.enum(WEBHOOK_EVENTS))
    .min(1, "Select at least one event"),
});

export async function createWebhookEndpoint(req: Request, res: Response) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Invalid webhook data.",
    });
  }
  try {
    const businessId = getBusinessId(req);
    const entitlements = await getEntitlements(businessId);
    await assertFeature(entitlements, "advancedWebhooks");
    assertWithinWebhookLimit(entitlements, await countWebhookEndpoints(businessId));
    const created = await createEndpoint(
      businessId,
      parsed.data as { url: string; events: WebhookEvent[] },
    );
    res.status(201).json({
      success: true,
      message:
        "Webhook endpoint created. The signing secret is shown once — store it securely.",
      data: created,
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to create the webhook endpoint right now.");
  }
}

export async function getWebhookEndpoints(req: Request, res: Response) {
  try {
    res.status(200).json({
      success: true,
      data: await listEndpoints(getBusinessId(req)),
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to load webhook endpoints right now.");
  }
}

export async function removeWebhookEndpoint(req: Request, res: Response) {
  const endpointId = Number(req.params.endpointId);
  if (!Number.isInteger(endpointId) || endpointId <= 0) {
    return res
      .status(400)
      .json({ success: false, message: "A valid endpoint ID is required." });
  }
  try {
    await deleteEndpoint(getBusinessId(req), endpointId);
    res.status(200).json({
      success: true,
      message: "Webhook endpoint removed. Delivery history is preserved.",
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to remove the webhook endpoint right now.");
  }
}

export async function getWebhookDeliveries(req: Request, res: Response) {
  const endpointId = Number(req.params.endpointId);
  if (!Number.isInteger(endpointId) || endpointId <= 0) {
    return res
      .status(400)
      .json({ success: false, message: "A valid endpoint ID is required." });
  }
  try {
    res.status(200).json({
      success: true,
      data: await listDeliveries(getBusinessId(req), endpointId),
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to load deliveries right now.");
  }
}

export async function testWebhookEndpoint(req: Request, res: Response) {
  const endpointId = Number(req.params.endpointId);
  if (!Number.isInteger(endpointId) || endpointId <= 0) {
    return res
      .status(400)
      .json({ success: false, message: "A valid endpoint ID is required." });
  }
  try {
    await sendTestEvent(getBusinessId(req), endpointId);
    res.status(200).json({
      success: true,
      message: "Test event queued. Check the delivery history in a moment.",
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to send the test event right now.");
  }
}
