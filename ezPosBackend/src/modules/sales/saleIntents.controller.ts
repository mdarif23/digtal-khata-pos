import type { Request, Response } from "express";
import { z } from "zod";
import * as saleIntentsService from "./saleIntents.service.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";

const createIntentSchema = z.object({
  provider: z.enum(["mock", "sslcommerz"]),
  method: z.enum(["bangla_qr", "card"]),
  amount: z.number().positive(),
  idempotencyKey: z.string().trim().min(8).max(120),
  redirectUrls: z.object({
    success: z.string().url(),
    fail: z.string().url(),
    cancel: z.string().url(),
  }),
});

const verifyIntentSchema = z.object({
  valId: z.string().trim().min(1).max(200),
});

export async function createIntent(req: Request, res: Response) {
  try {
    const saleId = Number(req.params.saleId);
    if (!Number.isInteger(saleId) || saleId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid sale ID." });
    }
    const parsed = createIntentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment intent data.",
        errors: parsed.error.flatten(),
      });
    }
    const result = await saleIntentsService.createSalePaymentIntent(
      getBusinessId(req),
      saleId,
      req.user?.id ?? null,
      parsed.data,
    );
    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      data: result,
    });
  } catch (err) {
    return sendSafeError(res, err, "Unable to start the payment.");
  }
}

export async function verifyIntent(req: Request, res: Response) {
  try {
    const intentId = Number(req.params.id);
    if (!Number.isInteger(intentId) || intentId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid intent ID." });
    }
    const parsed = verifyIntentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "A gateway validation id (valId) is required.",
      });
    }
    const outcome = await saleIntentsService.verifySalePaymentIntent(
      { businessId: getBusinessId(req), intentId },
      parsed.data.valId,
    );
    return res.status(outcome.verified ? 200 : 409).json({
      success: outcome.verified,
      data: outcome,
      message: outcome.reason ?? (outcome.verified ? "Payment verified." : "Payment not verified."),
    });
  } catch (err) {
    return sendSafeError(res, err, "Unable to verify the payment.");
  }
}

export async function cancelIntent(req: Request, res: Response) {
  try {
    const intentId = Number(req.params.id);
    if (!Number.isInteger(intentId) || intentId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid intent ID." });
    }
    const result = await saleIntentsService.cancelSalePaymentIntent(
      getBusinessId(req),
      intentId,
      req.user?.id ?? null,
    );
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return sendSafeError(res, err, "Unable to cancel the payment.");
  }
}

/**
 * Gateway IPN (server-to-server, unauthenticated by design — every payload
 * is verified with the provider before anything is recorded). The gateway
 * posts form-encoded fields; the tran_id is the intent's idempotency key.
 * Always answers 200 so the gateway does not retry indefinitely; the
 * verification outcome is persisted on the intent.
 */
export async function paymentIpn(req: Request, res: Response) {
  try {
    const body = req.body as { tran_id?: string; val_id?: string };
    const tranId = typeof body.tran_id === "string" ? body.tran_id : "";
    const valId = typeof body.val_id === "string" ? body.val_id : "";
    if (!tranId || !valId) {
      return res.status(200).json({ success: false, message: "Missing fields." });
    }
    await saleIntentsService.verifySalePaymentIntent(
      { businessId: null, tranId },
      valId,
    );
    return res.status(200).json({ success: true });
  } catch {
    // Never leak internals to the gateway; state is on the intent row.
    return res.status(200).json({ success: false });
  }
}
