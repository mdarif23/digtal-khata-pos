import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { getBusinessId } from "../../middleware/business.js";
import { getLocationId } from "../../middleware/location.js";
import { getTerminalId } from "../../middleware/terminalContext.js";
import { getAllowMultipleDrawerSessions } from "../posSettings/posSettings.service.js";
import { callerHasPermission } from "../../middleware/permissions.js";
import { sendSafeError } from "../../utils/safeError.js";
import { WILDCARD_PERMISSION } from "../../rbac/permissions.js";
import { getRegisterSessionReport } from "./cashRegisters.service.js";
import {
  addCashMovement,
  closeSession,
  confirmCashDrop,
  createRegister,
  getDenominationConfig,
  getCurrentSession,
  getSessionDetail,
  listRegisters,
  openSession,
  reconcileSession,
  reopenSession,
  setDenominationConfig,
  updateRegister,
} from "./cashRegisters.service.js";
import { z } from "zod";
import { dateRangeSchema } from "../reports/reports.validation.js";

function actor(req: Request): {
  userId: number;
  callerIsOwner: boolean;
  roleName: string | null;
} {
  if (!req.user || !req.membership) {
    throw new Error("actor() used on an unauthenticated route");
  }
  return {
    userId: req.user.id,
    callerIsOwner: req.membership.permissions.includes(WILDCARD_PERMISSION),
    roleName: req.membership.roleName ?? null,
  };
}

function auditCtx(req: Request): { actorRole: string | null; requestId: string } {
  return { actorRole: actor(req).roleName, requestId: randomUUID() };
}

const denominationRowSchema = z.object({
  value: z.number().finite().positive(),
  count: z.number().int().min(0),
});
const denominationSheetSchema = z.array(denominationRowSchema).max(30).optional();

const openSchema = z.object({
  openingCash: z.number().finite().min(0),
  openingDenominations: denominationSheetSchema,
});

const movementSchema = z.object({
  type: z.enum([
    "cash_in",
    "cash_out",
    "safe_deposit",
    "safe_withdrawal",
    "adjustment_in",
    "adjustment_out",
  ]),
  amount: z.number().finite().positive(),
  note: z.string().trim().max(500).optional(),
  recipientUserId: z.number().int().positive().optional(),
  referenceNo: z.string().trim().max(60).optional(),
  approvalToken: z.string().max(120).optional(),
});

const closeSchema = z.object({
  countedCash: z.number().finite().min(0),
  notes: z.string().trim().max(500).optional(),
  countedDenominations: denominationSheetSchema,
});

const reconcileSchema = z.object({
  countedCash: z.number().finite().min(0),
  notes: z.string().trim().max(500).optional(),
  countedDenominations: denominationSheetSchema,
});

const reopenSchema = z.object({
  approvalToken: z.string().min(1).max(120),
  reason: z.string().trim().max(500).optional(),
});

const denominationConfigSchema = z.object({
  denominations: z
    .array(z.number().finite().positive())
    .min(1)
    .max(15),
});

export async function getRegisters(req: Request, res: Response) {
  try {
    const data = await listRegisters(getBusinessId(req), getLocationId(req));
    res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    sendSafeError(res, err, "Unable to load registers.");
  }
}

export async function postRegister(req: Request, res: Response) {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (name === "" || name.length > 100) {
      return res
        .status(400)
        .json({ success: false, message: "A register name is required." });
    }
    const data = await createRegister(
      getBusinessId(req),
      getLocationId(req),
      name,
    );
    return res.status(201).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to create the register.");
  }
}

export async function patchRegister(req: Request, res: Response) {
  try {
    const registerId = Number(req.params.registerId);
    if (!Number.isInteger(registerId) || registerId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid register ID." });
    }
    const input: { name?: string; status?: "active" | "inactive" } = {};
    if (typeof req.body?.name === "string" && req.body.name.trim() !== "") {
      input.name = req.body.name.trim();
    }
    if (req.body?.status === "active" || req.body?.status === "inactive") {
      input.status = req.body.status;
    }
    const data = await updateRegister(getBusinessId(req), registerId, input);
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to update the register.");
  }
}

export async function postRegisterOpen(req: Request, res: Response) {
  try {
    const registerId = Number(req.params.registerId);
    if (!Number.isInteger(registerId) || registerId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid register ID." });
    }
    const parsed = openSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid opening cash.",
        errors: parsed.error.flatten(),
      });
    }
    const { userId } = actor(req);
    const businessId = getBusinessId(req);
    const allowMultiple = await getAllowMultipleDrawerSessions(businessId);
    const data = await openSession(
      businessId,
      userId,
      getLocationId(req),
      registerId,
      parsed.data.openingCash,
      getTerminalId(req),
      allowMultiple,
      {
        openingDenominations: parsed.data.openingDenominations ?? null,
        ...auditCtx(req),
      },
    );
    return res.status(201).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to open the register.");
  }
}

export async function getCurrentSessionHandler(req: Request, res: Response) {
  try {
    const { userId } = actor(req);
    const data = await getCurrentSession(getBusinessId(req), userId);
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load your register session.");
  }
}

export async function getSessionHandler(req: Request, res: Response) {
  try {
    const sessionId = Number(req.params.sessionId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid session ID." });
    }
    const { userId, callerIsOwner } = actor(req);
    const data = await getSessionDetail(
      getBusinessId(req),
      userId,
      callerIsOwner,
      callerHasPermission(req, "settings.view"),
      sessionId,
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load the session.");
  }
}

export async function postCashMovement(req: Request, res: Response) {
  try {
    const sessionId = Number(req.params.sessionId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid session ID." });
    }
    const parsed = movementSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid cash movement.",
        errors: parsed.error.flatten(),
      });
    }
    const { userId, callerIsOwner } = actor(req);
    const data = await addCashMovement(
      getBusinessId(req),
      userId,
      callerIsOwner,
      sessionId,
      parsed.data.type,
      parsed.data.amount,
      parsed.data.note,
      {
        recipientUserId: parsed.data.recipientUserId ?? null,
        referenceNo: parsed.data.referenceNo ?? null,
        approvalToken: parsed.data.approvalToken ?? null,
        ...auditCtx(req),
      },
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to record the cash movement.");
  }
}

export async function postCloseSession(req: Request, res: Response) {
  try {
    const sessionId = Number(req.params.sessionId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid session ID." });
    }
    const parsed = closeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid closing data.",
        errors: parsed.error.flatten(),
      });
    }
    const { userId, callerIsOwner } = actor(req);
    const data = await closeSession(
      getBusinessId(req),
      userId,
      callerIsOwner,
      sessionId,
      parsed.data.countedCash,
      parsed.data.notes,
      {
        countedDenominations: parsed.data.countedDenominations ?? null,
        ...auditCtx(req),
      },
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to close the register session.");
  }
}

/** Mid-shift blind count — records the interim variance, never a movement. */
export async function postReconcile(req: Request, res: Response) {
  try {
    const sessionId = Number(req.params.sessionId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid session ID." });
    }
    const parsed = reconcileSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid reconciliation data.",
        errors: parsed.error.flatten(),
      });
    }
    const { userId, callerIsOwner } = actor(req);
    const data = await reconcileSession(
      getBusinessId(req),
      userId,
      callerIsOwner,
      sessionId,
      parsed.data.countedCash,
      parsed.data.countedDenominations ?? null,
      parsed.data.notes,
      auditCtx(req),
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to reconcile the drawer.");
  }
}

/** Controlled reopen — ALWAYS requires a manager approval token. */
export async function postReopen(req: Request, res: Response) {
  try {
    const sessionId = Number(req.params.sessionId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid session ID." });
    }
    const parsed = reopenSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "A manager approval is required to reopen a register session.",
        errors: parsed.error.flatten(),
      });
    }
    const { userId } = actor(req);
    const data = await reopenSession(
      getBusinessId(req),
      userId,
      sessionId,
      parsed.data.approvalToken,
      parsed.data.reason,
      auditCtx(req),
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to reopen the register session.");
  }
}

/** Manager confirmation that a cash drop reached the safe. */
export async function postConfirmDrop(req: Request, res: Response) {
  try {
    const sessionId = Number(req.params.sessionId);
    const transactionId = Number(req.params.transactionId);
    if (
      !Number.isInteger(sessionId) ||
      sessionId <= 0 ||
      !Number.isInteger(transactionId) ||
      transactionId <= 0
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid session or transaction ID." });
    }
    const { userId } = actor(req);
    const data = await confirmCashDrop(
      getBusinessId(req),
      userId,
      sessionId,
      transactionId,
      auditCtx(req),
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to confirm the cash drop.");
  }
}

/** The business's denomination sheet (default set when unconfigured). */
export async function getDenominations(req: Request, res: Response) {
  try {
    const data = await getDenominationConfig(getBusinessId(req));
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load the denomination sheet.");
  }
}

/** Replaces the business's denomination sheet. */
export async function putDenominations(req: Request, res: Response) {
  try {
    const parsed = denominationConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid denomination configuration.",
        errors: parsed.error.flatten(),
      });
    }
    const { userId } = actor(req);
    const data = await setDenominationConfig(
      getBusinessId(req),
      userId,
      parsed.data.denominations,
      auditCtx(req),
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to save the denomination sheet.");
  }
}

/** Register shift summaries for the reports hub (financial scope). */
export async function getRegisterSessionReportHandler(
  req: Request,
  res: Response,
) {
  try {
    const parsed = dateRangeSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid date range.",
        errors: parsed.error.flatten(),
      });
    }
    const data = await getRegisterSessionReport(
      getBusinessId(req),
      parsed.data.startDate ?? new Date().toISOString().slice(0, 10),
      parsed.data.endDate ?? new Date().toISOString().slice(0, 10),
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load register summaries.");
  }
}
