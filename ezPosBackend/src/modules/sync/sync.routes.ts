import express from "express";
import { z } from "zod";
import type { Request, Response } from "express";
import { requireSyncAgentAuth, getSyncAgent } from "../../middleware/syncAuth.js";
import { bridgePollRateLimit } from "../../middleware/rateLimit.js";
import { sendSafeError } from "../../utils/safeError.js";
import {
  applyOps,
  getBootstrap,
  getCatalogDelta,
  getCustomersDelta,
  getStockSnapshot,
  type SyncOp,
} from "./sync.service.js";

/**
 * LAN sync endpoints (Phase 2) — authenticate the shop's sync-agent
 * terminal (secret credential, is_sync_agent required), never a user
 * session. Rate limited by terminal like the bridge poll endpoints.
 */
const router = express.Router();

const syncAgent = [bridgePollRateLimit, requireSyncAgentAuth()] as const;

router.get("/api/sync/bootstrap", ...syncAgent, async (req: Request, res: Response) => {
  try {
    const data = await getBootstrap(getSyncAgent(req));
    res.status(200).json({ data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to build the sync bootstrap.");
  }
});

router.get(
  "/api/sync/catalog",
  ...syncAgent,
  async (req: Request, res: Response) => {
    try {
      const agent = getSyncAgent(req);
      const since =
        typeof req.query.since === "string" ? req.query.since : null;
      const data = await getCatalogDelta(agent.businessId, since);
      res.status(200).json({ data });
    } catch (err: unknown) {
      return sendSafeError(res, err, "Unable to build the catalog delta.");
    }
  },
);

router.get("/api/sync/stock", ...syncAgent, async (req: Request, res: Response) => {
  try {
    const data = await getStockSnapshot(getSyncAgent(req));
    res.status(200).json({ data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to build the stock snapshot.");
  }
});

router.get(
  "/api/sync/customers",
  ...syncAgent,
  async (req: Request, res: Response) => {
    try {
      const agent = getSyncAgent(req);
      const since =
        typeof req.query.since === "string" ? req.query.since : null;
      const data = await getCustomersDelta(agent.businessId, since);
      res.status(200).json({ data });
    } catch (err: unknown) {
      return sendSafeError(res, err, "Unable to build the customers delta.");
    }
  },
);

const opsSchema = z.object({
  ops: z
    .array(
      z.object({
        opId: z.string().trim().min(8).max(120),
        type: z.enum(["customer.create", "sale.create"]),
        recordedAt: z.string().optional(),
        payload: z.unknown(),
      }),
    )
    .max(200),
});

router.post("/api/sync/ops", ...syncAgent, async (req: Request, res: Response) => {
  try {
    const parsed = opsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid sync ops.",
        errors: parsed.error.flatten(),
      });
    }
    const results = await applyOps(getSyncAgent(req), parsed.data.ops as SyncOp[]);
    res.status(200).json({ data: { results } });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to apply sync ops.");
  }
});

export default router;
