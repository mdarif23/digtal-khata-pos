import type { Request, Response } from "express";
import { sendSafeError } from "../../utils/safeError.js";
import { BadRequestError } from "../../utils/handleError.js";
import { pairTerminal } from "./terminals.service.js";
import {
  ackCommand,
  claimPendingCommands,
} from "./commands.service.js";

/**
 * Local Windows hardware bridge API. Authentication is terminal-secret
 * based (see middleware/terminalAuth.ts) except the pairing exchange,
 * whose credential is the one-time pairing code. The bridge is never the
 * financial system of record — these endpoints move no money.
 */

/** Bridge-facing pairing exchange (credential = the one-time code). */
export async function bridgePair(req: Request, res: Response) {
  try {
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    if (code.trim() === "") {
      throw new BadRequestError("A pairing code is required.");
    }
    const deviceName =
      typeof req.body?.deviceName === "string" ? req.body.deviceName : null;
    const deviceInfo =
      typeof req.body?.deviceInfo === "object" && req.body.deviceInfo !== null
        ? req.body.deviceInfo
        : null;
    const result = await pairTerminal(code, deviceName, deviceInfo);
    return res.status(201).json({ success: true, data: result });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Pairing failed.");
  }
}

/** The terminal's own identity, for diagnostics and config display. */
export async function bridgeTerminalSelf(req: Request, res: Response) {
  try {
    const terminal = req.terminal;
    if (!terminal) {
      throw new Error("bridge route used without terminal auth");
    }
    return res.status(200).json({
      success: true,
      data: {
        terminalId: terminal.terminalId,
        name: terminal.name,
        locationId: terminal.locationId,
      },
    });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load the terminal.");
  }
}

/** Claims pending commands (atomic: a command is delivered once). */
export async function bridgeClaimCommands(req: Request, res: Response) {
  try {
    const terminal = req.terminal;
    if (!terminal) {
      throw new Error("bridge route used without terminal auth");
    }
    const commands = await claimPendingCommands(terminal.terminalId);
    return res.status(200).json({ success: true, data: commands });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to claim commands.");
  }
}

const ACK_STATUSES = [
  "validated",
  "executing",
  "completed",
  "failed",
  "unknown_outcome",
] as const;
type AckStatus = (typeof ACK_STATUSES)[number];

function isAckStatus(value: unknown): value is AckStatus {
  return (
    typeof value === "string" &&
    (ACK_STATUSES as readonly string[]).includes(value)
  );
}

/** Acknowledges command progress: validated/executing/completed/failed. */
export async function bridgeAckCommand(req: Request, res: Response) {
  try {
    const terminal = req.terminal;
    if (!terminal) {
      throw new Error("bridge route used without terminal auth");
    }
    const commandId = Number(req.params.commandId);
    if (!Number.isInteger(commandId) || commandId <= 0) {
      throw new BadRequestError("Invalid command ID.");
    }
    const status = req.body?.status;
    if (!isAckStatus(status)) {
      throw new BadRequestError(
        "status must be validated | executing | completed | failed | unknown_outcome.",
      );
    }
    const detail =
      typeof req.body?.detail === "object" && req.body.detail !== null
        ? (req.body.detail as Record<string, unknown>)
        : null;
    const command = await ackCommand({
      businessId: terminal.businessId,
      terminalId: terminal.terminalId,
      commandId,
      status,
      detail,
    });
    return res.status(200).json({ success: true, data: command });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to acknowledge the command.");
  }
}
