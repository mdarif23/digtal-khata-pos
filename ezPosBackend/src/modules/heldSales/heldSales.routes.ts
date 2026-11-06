import express from "express";
import * as heldSalesController from "./heldSales.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requireLocationAccess } from "../../middleware/location.js";
import { requireTerminalContext } from "../../middleware/terminalContext.js";
import { requirePermission } from "../../middleware/permissions.js";

/**
 * Shared held sales (Module 1): held carts live on the server per
 * business+location so any authorized register can retrieve them.
 */
const router = express.Router();

// Location-aware: holds are scoped to the X-Location-Id (validated against
// membership + assignment), matching the sales routes.
const read = [
  requireAuth,
  requireBusinessContext(),
  requireLocationAccess(),
] as const;
// Writes resolve the optional X-Terminal-Id header (revoked terminals must
// not be able to park carts either).
const write = [...read, requireTerminalContext(), requireFullAccess] as const;

router.get(
  "/api/held-sales",
  ...read,
  requirePermission("pos.view"),
  heldSalesController.listHeld,
);
router.post(
  "/api/held-sales",
  ...write,
  requirePermission("pos.create_sale"),
  heldSalesController.createHeld,
);
router.delete(
  "/api/held-sales/:id",
  ...write,
  requirePermission("pos.create_sale"),
  heldSalesController.deleteHeld,
);

export default router;
