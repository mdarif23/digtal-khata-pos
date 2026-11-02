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

router.get(
  "/api/loyalty/program",
  ...read,
  requirePermission("loyalty.manage"),
  loyaltyController.getProgram,
);
router.put(
  "/api/loyalty/program",
  ...write,
  requirePermission("loyalty.manage"),
  loyaltyController.putProgram,
);
router.get(
  "/api/customers/:customerId/loyalty",
  ...read,
  requirePermission("customers.view"),
  loyaltyController.getCustomerLoyalty,
);

export default router;
