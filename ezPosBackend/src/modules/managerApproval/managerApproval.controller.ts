import type { Request, Response } from "express";
import { z } from "zod";
import { getBusinessId } from "../../middleware/business.js";
import { callerHasPermission } from "../../middleware/permissions.js";
import { sendSafeError } from "../../utils/safeError.js";
import { recordAudit } from "../../services/audit.js";
import {
  APPROVAL_OPS,
  APPROVAL_TTL_MINUTES,
  MAX_PIN_FAILURES,
  PIN_LOCKOUT_MINUTES,
  deleteManagerPin,
  hasManagerPin,
  isApprovalRequired,
  isManagerOpType,
  setManagerPin,
  verifyPinAndMintApproval,
} from "../../services/managerApproval.js";
import type { ManagerOpType } from "../../services/managerApproval.js";

const pinSchema = z.object({
  pin: z.string().regex(/^\d{4,8}$/, "PIN must be 4-8 digits."),
});

const verifySchema = z.object({
  pin: z.string().regex(/^\d{4,8}$/, "PIN must be 4-8 digits."),
  opType: z.string().min(1),
  entityType: z.string().max(40).optional(),
  entityId: z.number().int().positive().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().trim().max(500).optional(),
});

/** Ops catalog + business policy + whether the caller holds each authority. */
export async function getApprovalOps(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const ops = await Promise.all(
      (Object.keys(APPROVAL_OPS) as ManagerOpType[]).map(async (opType) => ({
        opType,
        permission: APPROVAL_OPS[opType].permission,
        required: await isApprovalRequired(businessId, opType),
        callerCanApprove: callerHasPermission(
          req,
          APPROVAL_OPS[opType].permission,
        ),
        hasPin: await hasManagerPin(businessId, req.user!.id),
      })),
    );
    res.status(200).json({
      success: true,
      data: {
        ops,
        policy: {
          approvalTtlMinutes: APPROVAL_TTL_MINUTES,
          maxPinFailures: MAX_PIN_FAILURES,
          lockoutMinutes: PIN_LOCKOUT_MINUTES,
        },
      },
    });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load approval configuration.");
  }
}

export async function postPin(req: Request, res: Response) {
  try {
    const parsed = pinSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid PIN.",
        errors: parsed.error.flatten(),
      });
    }
    const businessId = getBusinessId(req);
    await setManagerPin(businessId, req.user!.id, parsed.data.pin);
    recordAudit({
      businessId,
      actorUserId: req.user!.id,
      action: "manager_pin.set",
      entityType: "user",
      entityId: req.user!.id,
    });
    return res
      .status(200)
      .json({ success: true, message: "Manager PIN saved." });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to save the manager PIN.");
  }
}

export async function deletePin(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    await deleteManagerPin(businessId, req.user!.id);
    recordAudit({
      businessId,
      actorUserId: req.user!.id,
      action: "manager_pin.removed",
      entityType: "user",
      entityId: req.user!.id,
    });
    return res
      .status(200)
      .json({ success: true, message: "Manager PIN removed." });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to remove the manager PIN.");
  }
}

/** Verify the caller's own pin and mint a one-time, op-bound token. */
export async function postVerify(req: Request, res: Response) {
  try {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid approval request.",
        errors: parsed.error.flatten(),
      });
    }
    if (!isManagerOpType(parsed.data.opType)) {
      return res
        .status(400)
        .json({ success: false, message: "Unknown approval operation." });
    }
    const businessId = getBusinessId(req);
    const opType = parsed.data.opType;
    const minted = await verifyPinAndMintApproval(businessId, req.user!.id, {
      pin: parsed.data.pin,
      opType,
      entityType: parsed.data.entityType,
      entityId: parsed.data.entityId,
      payload: parsed.data.payload,
      reason: parsed.data.reason,
      hasRequiredPermission: callerHasPermission(
        req,
        APPROVAL_OPS[opType].permission,
      ),
    });
    return res.status(200).json({
      success: true,
      data: { approvalToken: minted.token, expiresAt: minted.expiresAt },
    });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to verify the PIN.");
  }
}
