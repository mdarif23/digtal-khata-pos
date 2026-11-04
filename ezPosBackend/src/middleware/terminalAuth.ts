import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/schema/index.js";
import { posTerminals } from "../db/schema/posTerminals.js";
import { sendSafeError } from "../utils/safeError.js";
import { ForbiddenError, UnauthorizedError } from "../utils/handleError.js";

/**
 * POS terminal (hardware bridge) authentication.
 *
 * The bridge authenticates with `Authorization: Bearer ezpos_tb_<secret>`
 * plus an `X-Terminal-Id` header. Secrets are SHA-256 hashed server-side
 * (shown once at pairing/rotation) and every request re-reads the terminal
 * row, so deactivation/revocation is immediate. Business membership comes
 * from the terminal row itself — never from client-supplied headers.
 */

export const TERMINAL_SECRET_PREFIX = "ezpos_tb_";
export const TERMINAL_ID_HEADER = "x-terminal-id";

export function generateTerminalSecret(): string {
  return `${TERMINAL_SECRET_PREFIX}${randomBytes(24).toString("hex")}`;
}

export function hashTerminalSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function secretMatches(presented: string, storedHash: string): boolean {
  const presentedHash = Buffer.from(hashTerminalSecret(presented), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return (
    presentedHash.length === stored.length && timingSafeEqual(presentedHash, stored)
  );
}

export interface TerminalContext {
  terminalId: number;
  businessId: number;
  locationId: number;
  name: string;
}

declare module "express-serve-static-core" {
  interface Request {
    terminal?: TerminalContext;
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

/** Terminal-facing middleware (bridge → backend). Fail-closed, 401/403. */
export function requireTerminalAuth() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = extractBearerToken(req);
      const rawId = req.headers[TERMINAL_ID_HEADER];
      const terminalId = Number(Array.isArray(rawId) ? rawId[0] : rawId);
      if (!token || !Number.isInteger(terminalId) || terminalId <= 0) {
        throw new UnauthorizedError("Terminal credentials are required.");
      }
      const [terminal] = await db
        .select({
          id: posTerminals.id,
          businessId: posTerminals.businessId,
          locationId: posTerminals.locationId,
          name: posTerminals.name,
          status: posTerminals.status,
          secretHash: posTerminals.secretHash,
        })
        .from(posTerminals)
        .where(and(eq(posTerminals.id, terminalId)));
      if (
        !terminal ||
        !terminal.secretHash ||
        !secretMatches(token, terminal.secretHash)
      ) {
        // Not-found vs bad secret are indistinguishable on purpose.
        throw new UnauthorizedError("Terminal credentials are required.");
      }
      if (terminal.status !== "active") {
        throw new ForbiddenError("This terminal is deactivated.");
      }
      // Heartbeat: the terminal is demonstrably alive and talking to us.
      await db
        .update(posTerminals)
        .set({ lastSeenAt: new Date() })
        .where(eq(posTerminals.id, terminal.id));

      req.terminal = {
        terminalId: terminal.id,
        businessId: terminal.businessId,
        locationId: terminal.locationId,
        name: terminal.name,
      };
      next();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        return res
          .status(401)
          .json({ success: false, message: err.message });
      }
      if (err instanceof ForbiddenError) {
        return res
          .status(403)
          .json({ success: false, message: err.message });
      }
      return sendSafeError(res, err, "Terminal authentication failed.");
    }
  };
}
