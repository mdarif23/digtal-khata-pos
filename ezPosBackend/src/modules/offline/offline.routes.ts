import express from "express";
import { z } from "zod";
import type { Request, Response } from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
  getBusinessId,
} from "../../middleware/business.js";
import { requireLocationAccess, getLocationId } from "../../middleware/location.js";
import { requireTerminalContext, getTerminalId } from "../../middleware/terminalContext.js";
import { requirePermission } from "../../middleware/permissions.js";
import { bridgePollRateLimit } from "../../middleware/rateLimit.js";
import { sendSafeError } from "../../utils/safeError.js";
import {
  applyOfflineOps,
  getOfflineSession,
  grantAllocations,
  listConflicts,
  resolveConflict,
  type OfflineOp,
} from "./offline.service.js";

/**
 * Offline terminal API (Phase 3). Every route requires a live USER session
 * AND a bound, active terminal (requireTerminalContext) — offline privileges
 * never outlive either. Revoked terminal/user ⇒ immediate 403.
 */
const router = express.Router();

const read = [
  requireAuth,
  requireBusinessContext(),
  requireLocationAccess(),
  requireTerminalContext(),
] as const;
const write = [...read, requireFullAccess] as const;
const manage = [...read, requirePermission("pos_terminal.manage")] as const;

const offlineOpSchema = z.object({
  opId: z.string().trim().min(8).max(120),
  type: z.enum([
    "sale.create",
    "customer.create",
    "drawer.open",
    "drawer.movement",
    "drawer.close",
    "return.create",
  ]),
  recordedAt: z.string().optional(),
  payload: z.unknown(),
});

router.get("/api/offline/session", ...read, async (req: Request, res: Response) => {
  try {
    const terminalId = getTerminalId(req);
    if (terminalId === null) {
      return res.status(400).json({
        success: false,
        message: "Offline mode requires a bound terminal.",
      });
    }
    const data = await getOfflineSession(getBusinessId(req), terminalId);
    return res.status(200).json({ data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load the offline session.");
  }
});

const allocationsSchema = z.object({
  variantIds: z.array(z.number().int().positive()).max(2000),
});

router.post(
  "/api/offline/allocations",
  bridgePollRateLimit,
  ...write,
  async (req: Request, res: Response) => {
    try {
      const parsed = allocationsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          message: "Invalid allocation request.",
          errors: parsed.error.flatten(),
        });
      }
      const terminalId = getTerminalId(req);
      if (terminalId === null) {
        return res.status(400).json({
          success: false,
          message: "Offline mode requires a bound terminal.",
        });
      }
      const data = await grantAllocations(
        getBusinessId(req),
        getLocationId(req),
        terminalId,
        parsed.data.variantIds,
      );
      return res.status(200).json({ data });
    } catch (err: unknown) {
      return sendSafeError(res, err, "Unable to grant offline allocations.");
    }
  },
);

const syncSchema = z.object({ ops: z.array(offlineOpSchema).max(200) });

router.post(
  "/api/offline/sync",
  bridgePollRateLimit,
  ...write,
  async (req: Request, res: Response) => {
    try {
      const parsed = syncSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          message: "Invalid offline ops.",
          errors: parsed.error.flatten(),
        });
      }
      const terminalId = getTerminalId(req);
      if (terminalId === null || !req.terminal) {
        return res.status(400).json({
          success: false,
          message: "Offline sync requires a bound terminal.",
        });
      }
      const results = await applyOfflineOps(
        {
          businessId: getBusinessId(req),
          locationId: getLocationId(req),
          terminalId,
          terminalName: req.terminal.name,
          userId: req.user!.id,
          // Phase 1 (audit finding): the offline path previously hardcoded
          // callerIsOwner=true, letting any syncing user close another
          // cashier's drawer by replaying their client_session_id. The same
          // ownership rule as the online path now applies.
          callerIsOwner: req.membership?.permissions.includes("*") ?? false,
        },
        parsed.data.ops as OfflineOp[],
      );
      return res.status(200).json({ data: { results } });
    } catch (err: unknown) {
      return sendSafeError(res, err, "Unable to apply offline ops.");
    }
  },
);

router.get("/api/offline/conflicts", ...read, async (req: Request, res: Response) => {
  try {
    const data = await listConflicts(getBusinessId(req));
    return res.status(200).json({ data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load sync conflicts.");
  }
});

router.post(
  "/api/offline/conflicts/:conflictId/resolve",
  ...manage,
  async (req: Request, res: Response) => {
    try {
      const conflictId = Number(req.params.conflictId);
      if (!Number.isInteger(conflictId) || conflictId <= 0) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid conflict ID." });
      }
      const action = req.body?.action === "apply" ? "apply" : "discard";
      const data = await resolveConflict(
        getBusinessId(req),
        conflictId,
        action,
        req.user!.id,
      );
      return res.status(200).json({ data });
    } catch (err: unknown) {
      return sendSafeError(res, err, "Unable to resolve the conflict.");
    }
  },
);

export default router;
