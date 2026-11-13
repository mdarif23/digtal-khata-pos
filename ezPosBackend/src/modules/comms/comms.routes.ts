import express from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import {
  getBusinessId,
  requireBusinessContext,
} from "../../middleware/business.js";
import { requirePermission } from "../../middleware/permissions.js";
import { sendSafeError } from "../../utils/safeError.js";
import { BadRequestError } from "../../utils/handleError.js";
import {
  applyDeliveryWebhook,
  ensureWebhookSecret,
  getCommSettingsWithDefaults,
  listMessages,
  listProviders,
  listTemplates,
  sendManualMessage,
  upsertCommSettings,
  upsertProvider,
  upsertTemplate,
  verifyWebhookSignature,
  type SendInput,
} from "../../services/comms.js";

const router = express.Router();

const read = [requireAuth, requireBusinessContext()] as const;
const manage = [...read, requirePermission("comms.manage")] as const;

const channelSchema = z.enum(["sms", "whatsapp", "email"]);
const templateKeySchema = z.enum([
  "sale_receipt",
  "due_reminder",
  "payment_received",
  "custom",
]);

// ---- providers ----
router.get("/api/comms/providers", ...manage, async (req: Request, res: Response) => {
  try {
    const data = await listProviders(getBusinessId(req));
    res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    sendSafeError(res, err, "Unable to load communication providers.");
  }
});

const providerSchema = z.object({
  channel: channelSchema,
  providerKey: z.enum(["console", "generic_http", "whatsapp_cloud", "resend"]),
  displayName: z.string().trim().max(80).nullable().optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

router.put("/api/comms/providers", ...manage, async (req: Request, res: Response) => {
  try {
    const parsed = providerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid provider configuration.",
        errors: parsed.error.flatten(),
      });
    }
    const data = await upsertProvider(getBusinessId(req), {
      channel: parsed.data.channel,
      providerKey: parsed.data.providerKey,
      displayName: parsed.data.displayName ?? null,
      config: parsed.data.config ?? null,
      isDefault: parsed.data.isDefault,
      isActive: parsed.data.isActive,
    });
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to save the provider.");
  }
});

// ---- templates ----
router.get("/api/comms/templates", ...manage, async (req: Request, res: Response) => {
  try {
    const data = await listTemplates(getBusinessId(req));
    res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    sendSafeError(res, err, "Unable to load templates.");
  }
});

const templateSchema = z.object({
  templateKey: templateKeySchema,
  channel: channelSchema,
  name: z.string().trim().min(1).max(120),
  body: z.string().min(1).max(4000),
  isActive: z.boolean(),
});

router.put("/api/comms/templates", ...manage, async (req: Request, res: Response) => {
  try {
    const parsed = templateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid template.",
        errors: parsed.error.flatten(),
      });
    }
    const data = await upsertTemplate(getBusinessId(req), parsed.data);
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to save the template.");
  }
});

// ---- settings ----
router.get("/api/comms/settings", ...manage, async (req: Request, res: Response) => {
  try {
    const data = await getCommSettingsWithDefaults(getBusinessId(req));
    res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    sendSafeError(res, err, "Unable to load communication settings.");
  }
});

const settingsSchema = z.object({
  autoReceiptEnabled: z.boolean().optional(),
  dueRemindersEnabled: z.boolean().optional(),
  dailyCapPerCustomer: z.number().int().min(0).max(50).optional(),
});

router.put("/api/comms/settings", ...manage, async (req: Request, res: Response) => {
  try {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid communication settings.",
        errors: parsed.error.flatten(),
      });
    }
    const data = await upsertCommSettings(getBusinessId(req), parsed.data);
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to save communication settings.");
  }
});

// ---- message log ----
router.get("/api/comms/messages", ...manage, async (req: Request, res: Response) => {
  try {
    const data = await listMessages(getBusinessId(req), {
      ...(typeof req.query.status === "string" ? { status: req.query.status } : {}),
      ...(typeof req.query.channel === "string" ? { channel: req.query.channel } : {}),
      ...(req.query.customerId
        ? { customerId: Number(req.query.customerId) }
        : {}),
      ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
      ...(req.query.offset ? { offset: Number(req.query.offset) } : {}),
    });
    res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    sendSafeError(res, err, "Unable to load the message log.");
  }
});

// ---- manual send ----
const sendSchema = z.object({
  channel: channelSchema,
  customerId: z.number().int().positive().nullable().optional(),
  recipient: z.string().trim().min(3).max(255),
  templateKey: templateKeySchema,
  messageClass: z.enum(["transactional", "marketing"]),
  entityType: z.string().max(40).nullable().optional(),
  entityId: z.number().int().positive().nullable().optional(),
  variables: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  reason: z.string().trim().max(300).optional(),
});

router.post("/api/comms/send", ...manage, async (req: Request, res: Response) => {
  try {
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid send request.",
        errors: parsed.error.flatten(),
      });
    }
    const input: SendInput & { reason?: string } = {
      businessId: getBusinessId(req),
      channel: parsed.data.channel,
      customerId: parsed.data.customerId ?? null,
      recipient: parsed.data.recipient,
      templateKey: parsed.data.templateKey,
      messageClass: parsed.data.messageClass,
      entityType: parsed.data.entityType ?? null,
      entityId: parsed.data.entityId ?? null,
      variables: parsed.data.variables ?? {},
      ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
    };
    const outcome = await sendManualMessage(
      getBusinessId(req),
      req.user!.id,
      input,
    );
    return res.status(200).json({ success: true, data: outcome });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to send the message.");
  }
});

// Webhook signing secret — shown to managers so they can configure the
// provider's outbound webhook. Regenerating invalidates the old one.
router.post("/api/comms/webhook-secret", ...manage, async (req: Request, res: Response) => {
  try {
    const secret = await ensureWebhookSecret(getBusinessId(req));
    return res.status(200).json({ success: true, data: { secret } });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to prepare the webhook secret.");
  }
});

// ---- delivery webhook (provider -> ezPos) ----
// The webhook verifies an HMAC over the EXACT request bytes — captured by
// the global express.json verify hook (see app.ts) before parsing.
router.post(
  "/api/comms/webhook/:businessId",
  async (req: Request, res: Response) => {
    try {
      const businessId = Number(req.params.businessId);
      if (!Number.isInteger(businessId) || businessId <= 0) {
        throw new BadRequestError("Invalid business ID.");
      }
      const rawBody =
        (req as Request & { __rawBody?: string }).__rawBody ??
        (typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));
      const secretRow = await ensureWebhookSecret(businessId);
      const signature = req.headers["x-ezpos-signature"];
      if (
        !verifyWebhookSignature(
          secretRow,
          rawBody,
          Array.isArray(signature) ? signature[0] : signature,
        )
      ) {
        return res
          .status(401)
          .json({ success: false, message: "Invalid webhook signature." });
      }
      const body = z
        .object({
          providerKey: z.string().min(1).max(30),
          providerMessageId: z.string().min(1).max(120),
          status: z.enum(["sent", "failed"]),
          error: z.string().max(500).nullable().optional(),
        })
        .safeParse(JSON.parse(rawBody));
      if (!body.success) {
        return res.status(400).json({ success: false, message: "Invalid webhook payload." });
      }
      const result = await applyDeliveryWebhook(
        businessId,
        body.data.providerKey,
        body.data.providerMessageId,
        body.data.status,
        body.data.error ?? null,
      );
      return res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      return sendSafeError(res, err, "Webhook failed.");
    }
  },
);

export default router;
