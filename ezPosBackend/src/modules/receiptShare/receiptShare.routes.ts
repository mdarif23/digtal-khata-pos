import express from "express";
import * as receiptShareController from "./receiptShare.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireBusinessContext } from "../../middleware/business.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();
const read = [requireAuth, requireBusinessContext()] as const;

// P3 Phase 4 (N1-10): receipt share link management — sales.view holders
// may create/revoke/list links for sales they can already read.
router.post(
  "/api/sales/:saleId/receipt-link",
  ...read,
  requirePermission("sales.view"),
  receiptShareController.createLink,
);
router.post(
  "/api/sales/:saleId/receipt-link/revoke",
  ...read,
  requirePermission("sales.view"),
  receiptShareController.revokeLink,
);
router.get(
  "/api/sales/:saleId/receipt-link",
  ...read,
  requirePermission("sales.view"),
  receiptShareController.listLinks,
);

export default router;
