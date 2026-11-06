import type { NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/schema/index.js";
import { posTerminals } from "../db/schema/posTerminals.js";
import { sendSafeError } from "../utils/safeError.js";
import { ForbiddenError, UnauthorizedError } from "../utils/handleError.js";
import {
  TERMINAL_ID_HEADER,
  hashTerminalSecret,
  type TerminalContext,
} from "./terminalAuth.js";

/**
 * LAN sync-agent authentication (Phase 2). The local server presents the
 * same credential shape as the hardware bridge — `Bearer ezpos_tb_<secret>`
 * plus `X-Terminal-Id` — but its terminal row must ALSO carry
 * is_sync_agent = true. Every request re-reads the row, so un-pairing or
 * deactivating the agent terminal revokes the local server's sync access
 * immediately; the partial unique index (one agent per business+location)
 * means a second local server for the same shop can never authenticate.
 */
export interface SyncAgentContext extends TerminalContext {}

declare module "express-serve-static-core" {
  interface Request {
    syncAgent?: SyncAgentContext;
  }
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || typeof token !== "string") {
    return null;
  }
  return token;
}

export function requireSyncAgentAuth() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = extractBearerToken(req);
      const rawId = req.headers[TERMINAL_ID_HEADER];
      const terminalId = Number(Array.isArray(rawId) ? rawId[0] : rawId);
      if (!token || !Number.isInteger(terminalId) || terminalId <= 0) {
        throw new UnauthorizedError("Sync agent credentials are required.");
      }
      const [terminal] = await db
        .select({
          id: posTerminals.id,
          businessId: posTerminals.businessId,
          locationId: posTerminals.locationId,
          name: posTerminals.name,
          status: posTerminals.status,
          isSyncAgent: posTerminals.isSyncAgent,
          secretHash: posTerminals.secretHash,
        })
        .from(posTerminals)
        .where(eq(posTerminals.id, terminalId));
      const secretMatches =
        terminal?.secretHash != null &&
        Buffer.from(hashTerminalSecret(token), "hex").equals(
          Buffer.from(terminal.secretHash, "hex"),
        );
      if (!terminal || !secretMatches) {
        // Not-found vs bad secret are indistinguishable on purpose.
        throw new UnauthorizedError("Sync agent credentials are required.");
      }
      if (terminal.status !== "active") {
        throw new ForbiddenError("This terminal is deactivated.");
      }
      if (!terminal.isSyncAgent) {
        throw new ForbiddenError(
          "This terminal is not the shop's sync agent.",
          "SYNC_AGENT_REQUIRED",
        );
      }
      await db
        .update(posTerminals)
        .set({ lastSeenAt: new Date() })
        .where(and(eq(posTerminals.id, terminal.id)));

      req.syncAgent = {
        terminalId: terminal.id,
        businessId: terminal.businessId,
        locationId: terminal.locationId,
        name: terminal.name,
      };
      return next();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        return res.status(401).json({ success: false, message: err.message });
      }
      if (err instanceof ForbiddenError) {
        return res
          .status(403)
          .json({ success: false, code: err.code, message: err.message });
      }
      return sendSafeError(res, err, "Sync agent authentication failed.");
    }
  };
}

export function getSyncAgent(req: Request): SyncAgentContext {
  if (!req.syncAgent) {
    throw new Error("requireSyncAgentAuth() missing — programming error.");
  }
  return req.syncAgent;
}
