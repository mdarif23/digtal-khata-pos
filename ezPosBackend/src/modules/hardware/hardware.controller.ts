import type { Request, Response } from "express";
import { recordAuditInTx } from "../../services/audit.js";
import { db } from "../../db/schema/index.js";
import { getBusinessId } from "../../middleware/business.js";
import { sendSafeError } from "../../utils/safeError.js";

/**
 * Hardware audit (Module 9): the register reports physical actions that
 * leave no server-side record of their own — a drawer kick is the classic
 * one (cash handling must be traceable). Permission-gated; the sale that
 * triggered an automatic kick is already audited separately.
 */
export async function drawerKick(req: Request, res: Response) {
  try {
    const saleInvoice =
      typeof req.body?.saleInvoice === "string"
        ? req.body.saleInvoice.slice(0, 60)
        : null;
    await db.transaction(async (tx) => {
      await recordAuditInTx(tx, {
        businessId: getBusinessId(req),
        actorUserId: req.user?.id ?? null,
        action: "hardware.drawer_opened",
        entityType: "register_session",
        entityId: null,
        metadata: { saleInvoice, source: "register" },
      });
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    return sendSafeError(res, err, "Unable to record the drawer event.");
  }
}
