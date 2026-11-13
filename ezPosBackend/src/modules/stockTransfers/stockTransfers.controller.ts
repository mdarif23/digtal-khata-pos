import type { Request, Response } from "express";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";
import { WILDCARD_PERMISSION } from "../../rbac/permissions.js";
import {
  cancelTransfer,
  createTransfer,
  getTransferDetail,
  listTransfers,
  authorizeTransfer,
  receiveTransfer,
  shipTransfer,
} from "./stockTransfers.service.js";
import {
  createTransferSchema,
  receiveTransferSchema,
} from "./stockTransfers.validation.js";

function actor(req: Request): {
  userId: number;
  callerIsOwner: boolean;
} {
  if (!req.user || !req.membership) {
    throw new Error("actor() used on an unauthenticated route");
  }
  return {
    userId: req.user.id,
    callerIsOwner: req.membership.permissions.includes(WILDCARD_PERMISSION),
  };
}

export async function getTransfers(req: Request, res: Response) {
  try {
    const { userId, callerIsOwner } = actor(req);
    const status =
      typeof req.query.status === "string" && req.query.status !== ""
        ? req.query.status
        : undefined;
    const data = await listTransfers(
      getBusinessId(req),
      userId,
      callerIsOwner,
      status,
    );
    res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    sendSafeError(res, err, "Unable to load transfers.");
  }
}

export async function getTransfer(req: Request, res: Response) {
  try {
    const transferId = Number(req.params.transferId);
    if (!Number.isInteger(transferId) || transferId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid transfer ID." });
    }
    const { userId, callerIsOwner } = actor(req);
    const data = await getTransferDetail(
      getBusinessId(req),
      userId,
      callerIsOwner,
      transferId,
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load the transfer.");
  }
}

export async function postTransfer(req: Request, res: Response) {
  try {
    const result = createTransferSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid transfer data.",
        errors: result.error.flatten(),
      });
    }
    const { userId, callerIsOwner } = actor(req);
    const data = await createTransfer(
      getBusinessId(req),
      userId,
      callerIsOwner,
      result.data,
    );
    return res.status(201).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to create the transfer.");
  }
}

/** Phase 4 (Feature 17): explicit authorization step on a draft transfer. */
export async function postTransferAuthorize(req: Request, res: Response) {
  try {
    const transferId = Number(req.params.transferId);
    if (!Number.isInteger(transferId) || transferId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid transfer ID." });
    }
    const { userId, callerIsOwner } = actor(req);
    const data = await authorizeTransfer(
      getBusinessId(req),
      userId,
      callerIsOwner,
      transferId,
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to authorize the transfer.");
  }
}

export async function postTransferShip(req: Request, res: Response) {
  try {
    const transferId = Number(req.params.transferId);
    if (!Number.isInteger(transferId) || transferId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid transfer ID." });
    }
    const { userId, callerIsOwner } = actor(req);
    const data = await shipTransfer(
      getBusinessId(req),
      userId,
      callerIsOwner,
      transferId,
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to ship the transfer.");
  }
}

export async function postTransferReceive(req: Request, res: Response) {
  try {
    const transferId = Number(req.params.transferId);
    if (!Number.isInteger(transferId) || transferId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid transfer ID." });
    }
    const result = receiveTransferSchema.safeParse(req.body ?? {});
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid receive data.",
        errors: result.error.flatten(),
      });
    }
    const { userId, callerIsOwner } = actor(req);
    const data = await receiveTransfer(
      getBusinessId(req),
      userId,
      callerIsOwner,
      transferId,
      result.data,
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to receive the transfer.");
  }
}

export async function postTransferCancel(req: Request, res: Response) {
  try {
    const transferId = Number(req.params.transferId);
    if (!Number.isInteger(transferId) || transferId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid transfer ID." });
    }
    const { userId, callerIsOwner } = actor(req);
    const data = await cancelTransfer(
      getBusinessId(req),
      userId,
      callerIsOwner,
      transferId,
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to cancel the transfer.");
  }
}
