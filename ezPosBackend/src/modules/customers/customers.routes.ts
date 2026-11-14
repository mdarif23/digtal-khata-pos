import express from "express";
import * as customersController from "./customers.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requireLocationAccess } from "../../middleware/location.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();
// Location-aware: the X-Location-Id header (or the business default) is
// validated against membership + assignment before any handler runs.
const read = [
  requireAuth,
  requireBusinessContext(),
  requireLocationAccess(),
] as const;
const write = [...read, requireFullAccess] as const;

router.get(
  "/api/customers",
  ...read,
  requirePermission("customers.view"),
  customersController.getCustomers,
);
router.post(
  "/api/customers",
  ...write,
  requirePermission("customers.create"),
  customersController.createCustomer,
);
// E1-004: correct a customer's contact details (customers.edit; audited).
router.patch(
  "/api/customers/:id",
  ...write,
  requirePermission("customers.edit"),
  customersController.updateCustomer,
);
// Phase 2C: communication consent toggles (scoped; customers.edit).
router.patch(
  "/api/customers/:id/consent",
  ...write,
  requirePermission("customers.edit"),
  customersController.patchCustomerConsent,
);
// Store credit balance for the checkout's store_credit payment method.
router.get(
  "/api/customers/:id/store-credit",
  ...read,
  requirePermission("customers.view"),
  customersController.getStoreCredit,
);
router.get(
  "/api/due_by_customers",
  ...read,
  requirePermission("customers.view_ledger"),
  customersController.getCustomerDueSummary,
);
export default router;
