import express from "express";
import type { Request, Response } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { requireAuth } from "../middleware/auth.js";
import { requireBusinessContext, getBusinessId } from "../middleware/business.js";
import { sendSafeError } from "../utils/safeError.js";
import { db } from "../db/schema/index.js";
import { sales } from "../db/schema/sales.js";
import { syncState } from "../db/schema/sync.js";
import { env } from "../config/env.js";

/**
 * Local sync status (Phase 2) — what the shop's owner sees on the LAN
 * server: pending uploads, per-stream cursors, last push/pull, last error.
 * On a cloud deployment the sync agent never runs, so every counter reads
 * zero and the frontend hides the card.
 */
const router = express.Router();

router.get(
  "/api/sync/status",
  requireAuth,
  requireBusinessContext(),
  async (req: Request, res: Response) => {
    try {
      const businessId = getBusinessId(req);
      const [pending] = await db
        .select({
          count: sql<number>`COUNT(*)::int`,
          oldestId: sql<number | null>`MIN(${sales.id})`,
        })
        .from(sales)
        .where(
          and(
            eq(sales.businessId, businessId),
            isNull(sales.syncedAt),
            eq(sales.channel, "pos"),
            eq(sales.status, "completed"),
          ),
        );
      const streams = await db.select().from(syncState);
      res.status(200).json({
        data: {
          agentEnabled: isSyncAgentConfigured(),
          pendingCount: pending?.count ?? 0,
          oldestPendingSaleId: pending?.oldestId ?? null,
          streams: streams.map((stream) => ({
            stream: stream.stream,
            cursor: stream.cursor,
            lastPushAt: stream.lastPushAt,
            lastPullAt: stream.lastPullAt,
            lastError: stream.lastError,
            updatedAt: stream.updatedAt,
          })),
        },
      });
    } catch (err: unknown) {
      return sendSafeError(res, err, "Unable to load sync status.");
    }
  },
);

function isSyncAgentConfigured(): boolean {
  return (
    env.syncEnabled &&
    env.syncCloudUrl !== "" &&
    env.syncTerminalId !== 0 &&
    env.syncTerminalSecret !== ""
  );
}

export default router;
