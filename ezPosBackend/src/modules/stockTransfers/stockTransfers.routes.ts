import express from "express";
import * as stockTransfersController from "./stockTransfers.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireBusinessContext, requireFullAccess } from "../../middleware/business.js";
import { requirePermission } from "../../middleware/permissions.js";
import { requireFeature } from "../../middleware/entitlements.js";

const router = express.Router();
const read = [
  requireAuth,
  requireBusinessContext(),
  requirePermission("inventory.transfer"),
] as const;
const write = [...read, requireFullAccess] as const;
// Transfers exist only for multi-location businesses; plans without the
// multiLocation entitlement cannot create them (viewing stays possible for
// history preserved from before a downgrade).
const transferWrite = [...write, requireFeature("multiLocation")] as const;

// Location access is enforced per-transfer inside the service: the source
// location for shipping, the destination for receiving, both for drafts —
// transfers are inherently cross-location, so the single X-Location-Id
// chain does not apply here.
router.get("/api/stock-transfers", ...read, stockTransfersController.getTransfers);
router.get("/api/stock-transfers/:transferId", ...read, stockTransfersController.getTransfer);
router.post("/api/stock-transfers", ...transferWrite, stockTransfersController.postTransfer);
router.post("/api/stock-transfers/:transferId/authorize", ...transferWrite, stockTransfersController.postTransferAuthorize);
router.post("/api/stock-transfers/:transferId/ship", ...transferWrite, stockTransfersController.postTransferShip);
router.post("/api/stock-transfers/:transferId/receive", ...transferWrite, stockTransfersController.postTransferReceive);
router.post("/api/stock-transfers/:transferId/cancel", ...transferWrite, stockTransfersController.postTransferCancel);

export default router;
