import express from "express";
import * as groupsController from "./customerGroups.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  requireBusinessContext,
  requireFullAccess,
} from "../../middleware/business.js";
import { requirePermission } from "../../middleware/permissions.js";

const router = express.Router();
const read = [requireAuth, requireBusinessContext()] as const;
const write = [...read, requireFullAccess] as const;

// Groups
router.get(
  "/api/customer-groups",
  ...read,
  requirePermission("pricing.view"),
  groupsController.listGroups,
);
router.post(
  "/api/customer-groups",
  ...write,
  requirePermission("pricing.customer_groups.manage"),
  groupsController.createGroup,
);
router.patch(
  "/api/customer-groups/:id",
  ...write,
  requirePermission("pricing.customer_groups.manage"),
  groupsController.updateGroup,
);
router.delete(
  "/api/customer-groups/:id",
  ...write,
  requirePermission("pricing.customer_groups.manage"),
  groupsController.deleteGroup,
);

// Membership (customers carry a live group reference; group discounts are
// snapshotted onto sale lines at transaction time).
router.get(
  "/api/customer-groups/:id/members",
  ...read,
  requirePermission("pricing.view"),
  groupsController.listGroupMembers,
);
router.put(
  "/api/customer-groups/:id/members",
  ...write,
  requirePermission("pricing.customer_groups.manage"),
  groupsController.assignMembers,
);
router.delete(
  "/api/customer-groups/:id/members/:customerId",
  ...write,
  requirePermission("pricing.customer_groups.manage"),
  groupsController.removeMember,
);

// Group pricing (whole-cart or scoped discounts; consumed at checkout).
router.get(
  "/api/customer-groups/:id/pricing",
  ...read,
  requirePermission("pricing.view"),
  groupsController.listGroupPricing,
);
router.post(
  "/api/customer-groups/:id/pricing",
  ...write,
  requirePermission("pricing.customer_groups.manage"),
  groupsController.createGroupPricing,
);
router.patch(
  "/api/customer-groups/:id/pricing/:pricingId",
  ...write,
  requirePermission("pricing.customer_groups.manage"),
  groupsController.updateGroupPricing,
);
router.delete(
  "/api/customer-groups/:id/pricing/:pricingId",
  ...write,
  requirePermission("pricing.customer_groups.manage"),
  groupsController.deleteGroupPricing,
);

export default router;
