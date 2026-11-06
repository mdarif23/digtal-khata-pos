import type { Request, Response } from "express";
import { getBusinessId } from "../../middleware/business.js";
import { getLocationId } from "../../middleware/location.js";
import { callerHasPermission } from "../../middleware/permissions.js";
import { sendSafeError } from "../../utils/safeError.js";
import { BadRequestError } from "../../utils/handleError.js";
import {
  deleteTerminal,
  getTerminal,
  listTerminalCommands,
  listTerminals,
  mintPairingCode,
  rotateTerminalSecret,
  updateTerminal,
} from "./terminals.service.js";
import { createCommand, getCommandStatus } from "./commands.service.js";

function terminalIdParam(req: Request): number {
  const id = Number(req.params.terminalId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BadRequestError("Invalid terminal ID.");
  }
  return id;
}

function commandIdParam(req: Request): number {
  const id = Number(req.params.commandId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BadRequestError("Invalid command ID.");
  }
  return id;
}

export async function getTerminals(req: Request, res: Response) {
  try {
    const data = await listTerminals(getBusinessId(req), getLocationId(req));
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load terminals.");
  }
}

export async function getTerminalDetail(req: Request, res: Response) {
  try {
    const data = await getTerminal(getBusinessId(req), terminalIdParam(req));
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load the terminal.");
  }
}

export async function patchTerminal(req: Request, res: Response) {
  try {
    const input: {
      name?: string;
      status?: "active" | "inactive";
      locationId?: number;
    } = {};
    if (typeof req.body?.name === "string" && req.body.name.trim() !== "") {
      input.name = req.body.name.trim().slice(0, 100);
    }
    if (req.body?.status === "active" || req.body?.status === "inactive") {
      input.status = req.body.status;
    }
    if (req.body?.locationId !== undefined) {
      const locationId = Number(req.body.locationId);
      if (!Number.isInteger(locationId) || locationId <= 0) {
        throw new BadRequestError("Invalid location ID.");
      }
      input.locationId = locationId;
    }
    if (Object.keys(input).length === 0) {
      throw new BadRequestError("Nothing to update.");
    }
    const data = await updateTerminal(
      getBusinessId(req),
      terminalIdParam(req),
      input,
      req.user?.id ?? null,
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to update the terminal.");
  }
}

export async function deleteTerminalHandler(req: Request, res: Response) {
  try {
    const data = await deleteTerminal(
      getBusinessId(req),
      terminalIdParam(req),
      req.user?.id ?? null,
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to delete the terminal.");
  }
}

/** Mints a one-time pairing code for the caller's location. */
export async function postPairingCode(req: Request, res: Response) {
  try {
    const issued = await mintPairingCode(
      getBusinessId(req),
      getLocationId(req),
      req.user?.id ?? 0,
    );
    return res.status(201).json({ success: true, data: issued });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to mint a pairing code.");
  }
}

export async function postRotateSecret(req: Request, res: Response) {
  try {
    const data = await rotateTerminalSecret(
      getBusinessId(req),
      terminalIdParam(req),
      req.user?.id ?? null,
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to rotate the terminal secret.");
  }
}

export async function getTerminalCommands(req: Request, res: Response) {
  try {
    const data = await listTerminalCommands(
      getBusinessId(req),
      terminalIdParam(req),
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load command history.");
  }
}

/**
 * Authors a drawer-open command against a paired terminal at the caller's
 * location. Permission depends on the request: a sale-linked kick needs
 * cash_drawer.open; a no-sale kick needs the stronger
 * cash_drawer.open_without_sale.
 */
export async function postHardwareCommand(req: Request, res: Response) {
  try {
    const terminalId = Number(req.body?.terminalId);
    if (!Number.isInteger(terminalId) || terminalId <= 0) {
      throw new BadRequestError("A valid terminalId is required.");
    }
    const type = req.body?.type;
    if (type !== "drawer_open") {
      throw new BadRequestError("Unsupported command type.");
    }
    const saleId =
      req.body?.saleId === undefined || req.body?.saleId === null
        ? null
        : Number(req.body.saleId);
    if (saleId !== null && (!Number.isInteger(saleId) || saleId <= 0)) {
      throw new BadRequestError("Invalid saleId.");
    }
    const requiredPermission =
      saleId !== null ? "cash_drawer.open" : "cash_drawer.open_without_sale";
    if (!callerHasPermission(req, requiredPermission)) {
      return res.status(403).json({
        success: false,
        message: `This action requires the ${requiredPermission} permission.`,
      });
    }
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason : null;
    const data = await createCommand({
      businessId: getBusinessId(req),
      requesterId: req.user?.id ?? null,
      terminalId,
      locationId: getLocationId(req),
      type: "drawer_open",
      saleId,
      reason,
    });
    return res.status(201).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to create the hardware command.");
  }
}

/** POS-side polling: what happened to the drawer command? */
export async function getHardwareCommandStatus(req: Request, res: Response) {
  try {
    const data = await getCommandStatus(
      getBusinessId(req),
      commandIdParam(req),
    );
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load the command status.");
  }
}
