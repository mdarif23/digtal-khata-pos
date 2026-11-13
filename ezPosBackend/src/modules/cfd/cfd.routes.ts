import express from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import {
  getBusinessId,
  requireBusinessContext,
} from "../../middleware/business.js";
import { requirePermission } from "../../middleware/permissions.js";
import { sendSafeError } from "../../utils/safeError.js";
import { BadRequestError } from "../../utils/handleError.js";
import { db } from "../../db/schema/index.js";
import { posSettings } from "../../db/schema/posSettings.js";
import { eq } from "drizzle-orm";
import {
  attachStream,
  businessBranding,
  claimPairing,
  createPairingCode,
  detachStream,
  listDisplays,
  pushPayload,
  resolveDisplayByToken,
  revokeDisplay,
  type CfdPayload,
} from "./cfd.service.js";

const router = express.Router();

const read = [requireAuth, requireBusinessContext()] as const;

// ---- POS-side management (authenticated) --------------------------------

router.post(
  "/api/cfd/pair",
  ...read,
  requirePermission("cash_register.view"),
  async (req: Request, res: Response) => {
    try {
      const data = await createPairingCode(getBusinessId(req), req.user!.id);
      return res.status(201).json({ success: true, data });
    } catch (err: unknown) {
      return sendSafeError(res, err, "Unable to start pairing.");
    }
  },
);

router.get("/api/cfd/displays", ...read, async (req: Request, res: Response) => {
  try {
    const data = await listDisplays(getBusinessId(req));
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to list displays.");
  }
});

router.post(
  "/api/cfd/displays/:displayId/revoke",
  ...read,
  requirePermission("settings.edit"),
  async (req: Request, res: Response) => {
    try {
      const displayId = Number(req.params.displayId);
      if (!Number.isInteger(displayId) || displayId <= 0) {
        throw new BadRequestError("Invalid display ID.");
      }
      await revokeDisplay(getBusinessId(req), displayId);
      return res.status(200).json({ success: true });
    } catch (err: unknown) {
      return sendSafeError(res, err, "Unable to revoke the display.");
    }
  },
);

// ---- Display-side (token-authenticated, READ-ONLY) ----------------------

const claimSchema = z.object({
  code: z.string().trim().min(8).max(8),
  name: z.string().trim().max(80).optional(),
});

/** Display claims the pairing code → one-time token. No user auth. */
router.post("/api/cfd/claim", async (req: Request, res: Response) => {
  try {
    const parsed = claimSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Enter the 8-character pairing code.",
        errors: parsed.error.flatten(),
      });
    }
    const data = await claimPairing(parsed.data.code, parsed.data.name ?? "Customer display");
    return res.status(200).json({ success: true, data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Pairing failed.");
  }
});

const streamSchema = z.object({ token: z.string().regex(/^[0-9a-f]{48}$/) });

/**
 * Display SSE stream: token auth (NOT user JWT), 25s heartbeats, initial
 * snapshot replay, connection status events. Strictly read-only.
 */
router.get("/api/cfd/stream", async (req: Request, res: Response) => {
  const parsed = streamSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(401).json({ success: false, message: "Invalid display token." });
  }
  const display = await resolveDisplayByToken(parsed.data.token);
  if (!display) {
    return res.status(401).json({ success: false, message: "Unknown or revoked display." });
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ type: "connected", displayId: display.displayId })}\n\n`);
  if (display.payload) {
    res.write(`data: ${JSON.stringify({ type: "payload", payload: display.payload })}\n\n`);
  }
  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat\n\n`);
    } catch {
      // cleaned up on close
    }
  }, 25_000);
  attachStream(display.displayId, res);
  req.on("close", () => {
    clearInterval(heartbeat);
    detachStream(display.displayId);
  });
});

// ---- POS push (authenticated) -------------------------------------------

const pushSchema = z.object({
  displayId: z.number().int().positive(),
  status: z.enum(["idle", "cart", "paid"]),
  items: z
    .array(
      z.object({
        name: z.string().max(255),
        variantName: z.string().max(255).nullable().optional(),
        quantity: z.number().nonnegative(),
        unitPrice: z.number().nonnegative(),
        lineTotal: z.number().nonnegative(),
      }),
    )
    .max(200),
  discountTotal: z.number().nonnegative(),
  vatTotal: z.number().nonnegative(),
  grandTotal: z.number().nonnegative(),
  paidTotal: z.number().nonnegative(),
  dueTotal: z.number().nonnegative(),
});

/** The POS pushes the live cart — the display never computes anything. */
router.post("/api/cfd/push", ...read, async (req: Request, res: Response) => {
  try {
    const parsed = pushSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid display payload.",
        errors: parsed.error.flatten(),
      });
    }
    const businessId = getBusinessId(req);
    const branding = await businessBranding(businessId);
    // Idle/promo copy from the business's POS settings (absent = defaults).
    const [settings] = await db
      .select({
        idle: posSettings.cfdIdleMessage,
        promo: posSettings.cfdPromoMessage,
      })
      .from(posSettings)
      .where(eq(posSettings.businessId, businessId))
      .limit(1);
    const payload: CfdPayload = {
      status: parsed.data.status,
      businessName: branding.businessName,
      logoUrl: branding.logoUrl,
      idleMessage: settings?.idle ?? null,
      promoMessage: settings?.promo ?? null,
      items: parsed.data.items.map((item) => ({
        name: item.name,
        variantName: item.variantName ?? null,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        lineTotal: item.lineTotal,
      })),
      discountTotal: parsed.data.discountTotal,
      vatTotal: parsed.data.vatTotal,
      grandTotal: parsed.data.grandTotal,
      paidTotal: parsed.data.paidTotal,
      dueTotal: parsed.data.dueTotal,
    };
    const result = await pushPayload(businessId, parsed.data.displayId, payload);
    return res.status(200).json({ success: true, data: result });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to push the display payload.");
  }
});

export default router;
