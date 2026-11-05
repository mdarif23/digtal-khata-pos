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
  createRegister,
  getCurrentSession,
  getSessionDetail,
  listRegisters,
  openSession,
  updateRegister,
} from "./cashRegisters.service.js";
import { z } from "zod";
import { dateRangeSchema } from "../reports/reports.validation.js";

function actor(req: Request): { userId: number; callerIsOwner: boolean } {
  if (!req.user || !req.membership) {
    throw new Error("actor() used on an unauthenticated route");
  }
  return {
    userId: req.user.id,
    callerIsOwner: req.membership.permissions.includes(WILDCARD_PERMISSION),
  };
}

const openSchema = z.object({
  openingCash: z.number().finite().min(0),
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
});

const closeSchema = z.object({
  countedCash: z.number().finite().min(0),
  notes: z.string().trim().max(500).optional(),
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
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to close the register session.");
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
