import type { Request, Response } from "express";
import {
  initiatePayment,
  markPaymentAbandoned,
  verifyAndActivate,
} from "./payments.service.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";

export async function startPayment(req: Request, res: Response) {
  const invoiceId = Number(req.body?.invoiceId);
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
    return res
      .status(400)
      .json({ success: false, message: "A valid invoice ID is required." });
  }
  try {
    const payment = await initiatePayment(
      getBusinessId(req),
      invoiceId,
      { type: "customer", userId: req.user!.id },
    );
    res.status(200).json({
      success: true,
      message: "Payment session created. Redirecting to the gateway.",
      data: payment,
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to start the payment right now.");
  }
}

/**
 * Post-redirect server-side verification. The gateway appends val_id to the
 * success URL; the website passes it here and the backend validates it
 * against the gateway before activating — the redirect itself proves
 * nothing.
 */
export async function verifyPayment(req: Request, res: Response) {
  const paymentId = Number(req.params.paymentId);
  if (!Number.isInteger(paymentId) || paymentId <= 0) {
    return res
      .status(400)
      .json({ success: false, message: "A valid payment ID is required." });
  }
  const valId = typeof req.body?.valId === "string" ? req.body.valId : "";
  if (valId.length < 3) {
    return res.status(400).json({
      success: false,
      message: "A gateway validation id (valId) is required.",
    });
  }
  try {
    const outcome = await verifyAndActivate(valId, {
      businessId: getBusinessId(req),
      paymentId,
    });
    res.status(200).json({
      success: true,
      message: outcome.verified
        ? outcome.alreadyVerified
          ? "This payment was already verified."
          : "Payment verified — your subscription is active."
        : (outcome.reason ?? "Payment could not be verified."),
      data: outcome,
    });
  } catch (err) {
    sendSafeError(res, err, "Unable to verify the payment right now.");
  }
}

export async function reportPaymentOutcome(req: Request, res: Response) {
  const paymentId = Number(req.params.paymentId);
  const outcome =
    req.body?.outcome === "failed"
      ? "failed"
      : req.body?.outcome === "canceled"
        ? "canceled"
        : null;
  if (!Number.isInteger(paymentId) || paymentId <= 0 || outcome === null) {
    return res.status(400).json({
      success: false,
      message: "A valid payment ID and outcome are required.",
    });
  }
  try {
    await markPaymentAbandoned(getBusinessId(req), paymentId, outcome);
    res.status(200).json({ success: true });
  } catch (err) {
    sendSafeError(res, err, "Unable to record the payment outcome.");
  }
}

/**
 * Gateway IPN callback (server-to-server, no auth — security comes from
 * server-side validation of val_id with the store credentials). Idempotent:
 * duplicate IPNs short-circuit on the succeeded payment.
 */
export async function paymentIpn(req: Request, res: Response) {
  try {
    // SSLCommerz posts form-urlencoded by default; accept JSON too.
    const body =
      typeof req.body === "object" && req.body !== null ? req.body : {};
    const valId = String((body as Record<string, unknown>).val_id ?? "");
    const tranId = String((body as Record<string, unknown>).tran_id ?? "");
    const status = String((body as Record<string, unknown>).status ?? "");
    if (valId === "" || tranId === "") {
      return res
        .status(400)
        .json({ success: false, message: "IPN payload missing val_id/tran_id." });
    }
    if (["FAILED", "CANCELLED"].includes(status.toUpperCase())) {
      // Negative IPNs never activate anything; payment stays retryable.
      return res.status(200).json({ success: true, message: "Recorded." });
    }
    // Order payments (storefront checkout, stage 5) share the IPN endpoint —
    // routed by tran_id prefix, verified through the same server-side core.
    if (tranId.startsWith("ord-")) {
      const { handleOrderPaymentIpn } = await import(
        "../commerce/orderPayments.service.js"
      );
      const orderOutcome = await handleOrderPaymentIpn({ tranId, valId });
      return res.status(200).json({
        success: true,
        verified: orderOutcome.paid,
        handled: orderOutcome.handled,
      });
    }
    const outcome = await verifyAndActivate(valId, { tranId });
    res.status(200).json({
      success: true,
      verified: outcome.verified,
      alreadyVerified: outcome.alreadyVerified,
    });
  } catch (err) {
    // Never leak internals to the gateway; log for reconciliation.
    console.error("IPN processing failed:", err);
    res.status(200).json({ success: false, verified: false });
  }
}
