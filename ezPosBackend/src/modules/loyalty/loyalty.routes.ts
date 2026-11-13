import express from "express";
import * as loyaltyController from "./loyalty.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();

const read = [requireAuth, requireBusinessContext()] as const;
const write = [...read, requireFullAccess] as const;
const manage = [...write, requirePermission("loyalty.manage")] as const;

router.get(
  "/api/loyalty/program",
  ...manage,
  loyaltyController.getProgram,
);
router.put(
  "/api/loyalty/program",
  ...manage,
  loyaltyController.putProgram,
);
// POS-readable redemption config (cashiers need the caps at checkout).
router.get(
  "/api/loyalty/config",
  ...read,
  requirePermission("pos.view"),
  loyaltyController.getPosConfig,
);

// Earning rules (Phase 2A).
router.get(
  "/api/loyalty/earn-rule",
  ...manage,
  loyaltyController.getRule,
);
router.put(
  "/api/loyalty/earn-rule",
  ...manage,
  loyaltyController.putRule,
);

// Tiers (Phase 2A).
router.get(
  "/api/loyalty/tiers",
  ...manage,
  loyaltyController.getTiers,
);
router.post(
  "/api/loyalty/tiers",
  ...manage,
  loyaltyController.postTier,
);
router.put(
  "/api/loyalty/tiers/:tierId",
  ...manage,
  loyaltyController.putTier,
);
router.delete(
  "/api/loyalty/tiers/:tierId",
  ...manage,
  loyaltyController.deleteTier,
);

router.get(
  "/api/customers/:customerId/loyalty",
  ...read,
  requirePermission("customers.view"),
  loyaltyController.getCustomerLoyalty,
);
// Manual balance correction — sensitive, dedicated permission.
router.post(
  "/api/customers/:customerId/loyalty/adjust",
  ...read,
  requirePermission("loyalty.adjust"),
  loyaltyController.postAdjust,
);

export default router;
