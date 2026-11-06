import type { NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/schema/index.js";
import { posTerminals } from "../db/schema/posTerminals.js";
import { posSettings } from "../db/schema/posSettings.js";
import { getBusinessId } from "./business.js";
import { getLocationId } from "./location.js";
import { TERMINAL_ID_HEADER, type TerminalContext } from "./terminalAuth.js";
import { BadRequestError, ForbiddenError } from "../utils/handleError.js";

/**
 * POS terminal context for BROWSER (user-session) requests — the
 * multi-terminal companion to requireTerminalAuth(), which serves the
 * hardware bridge.
 *
 * The X-Terminal-Id header binds the request to a registered terminal. The
 * header is a claim, never proof: the terminal must exist, belong to the
 * caller's verified business AND the request's verified location, and be
 * active — else 403 TERMINAL_REVOKED (deleted, foreign, moved, or
 * deactivated terminals are deliberately indistinguishable). Every
 * authorized request also refreshes last_seen_at, so terminal activity in
 * Settings → Hardware is real usage, not a poller.
 *
 * When the header is absent the request proceeds — unless the business
 * enabled pos_settings.require_terminal, in which case checkout must come
 * from a bound terminal. That keeps every existing workflow and deployment
 * working unchanged while giving businesses a strict mode.
 *
 * Must run AFTER requireBusinessContext() and requireLocationAccess().
 */
export function requireTerminalContext() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const businessId = getBusinessId(req);
      const locationId = getLocationId(req);
      const raw = req.headers[TERMINAL_ID_HEADER];
      const header = Array.isArray(raw) ? raw[0] : raw;
      const trimmed = typeof header === "string" ? header.trim() : "";

      if (trimmed === "") {
        const [settings] = await db
          .select({ requireTerminal: posSettings.requireTerminal })
          .from(posSettings)
          .where(eq(posSettings.businessId, businessId))
          .limit(1);
        if (settings?.requireTerminal) {
          throw new ForbiddenError(
            "This business requires sales from a registered terminal. Bind this computer to a terminal in Settings → Hardware.",
            "TERMINAL_REQUIRED",
          );
        }
        return next();
      }

      const terminalId = Number(trimmed);
      if (!Number.isInteger(terminalId) || terminalId <= 0) {
        throw new BadRequestError("Invalid X-Terminal-Id header.");
      }

      const [terminal] = await db
        .select({
          id: posTerminals.id,
          businessId: posTerminals.businessId,
          locationId: posTerminals.locationId,
          name: posTerminals.name,
          status: posTerminals.status,
        })
        .from(posTerminals)
        .where(
          and(
            eq(posTerminals.id, terminalId),
            eq(posTerminals.businessId, businessId),
            eq(posTerminals.locationId, locationId),
          ),
        )
        .limit(1);
      if (!terminal || terminal.status !== "active") {
        throw new ForbiddenError(
          "This terminal is revoked or not authorized for this location. Ask a manager to check Settings → Hardware.",
          "TERMINAL_REVOKED",
        );
      }

      // Heartbeat — same convention as requireTerminalAuth for the bridge.
      await db
        .update(posTerminals)
        .set({ lastSeenAt: new Date() })
        .where(eq(posTerminals.id, terminal.id));

      req.terminal = {
        terminalId: terminal.id,
        businessId: terminal.businessId,
        locationId: terminal.locationId,
        name: terminal.name,
      } satisfies TerminalContext;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/** The verified terminal bound to this request, or null when unbound. */
export function getTerminalId(req: Request): number | null {
  return req.terminal?.terminalId ?? null;
}
