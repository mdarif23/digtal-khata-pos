import express from "express";
import * as adminController from "./saasAdmin.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePlatformAdmin } from "../../middleware/platformAdmin.js";

/**
 * SaaS-owner administration. Every route requires an authenticated
 * platform admin (users.platform_role = 'platform_admin') — the Super Admin
 * role for now; granular saas.* roles remain future work. Every mutation is
 * audit-logged in saas_admin_audit.
 */
const router = express.Router();
const admin = [requireAuth, requirePlatformAdmin] as const;

router.get("/api/saas/overview", ...admin, adminController.getOverview);
router.get("/api/saas/audit-logs", ...admin, adminController.getAuditLogs);
router.post("/api/saas/jobs/run", ...admin, adminController.runJobs);

router.get("/api/saas/businesses", ...admin, adminController.getBusinesses);
router.get(
  "/api/saas/businesses/:businessId/detail",
  ...admin,
  adminController.getBusinessDetail,
);
router.post(
  "/api/saas/businesses/:businessId/status",
  ...admin,
  adminController.setBusinessStatus,
);

router.get("/api/saas/subscriptions", ...admin, adminController.getSubscriptions);
router.post(
  "/api/saas/subscriptions/:subscriptionId/change-plan",
  ...admin,
  adminController.changeSubscriptionPlan,
);
router.post(
  "/api/saas/subscriptions/:subscriptionId/extend",
  ...admin,
  adminController.extendSubscription,
);
router.post(
  "/api/saas/businesses/:businessId/grant-trial",
  ...admin,
  adminController.grantTrial,
);
router.post(
  "/api/saas/subscriptions/:subscriptionId/suspend",
  ...admin,
  adminController.subscriptionStatusAction,
);
router.post(
  "/api/saas/subscriptions/:subscriptionId/reactivate",
  ...admin,
  adminController.subscriptionStatusAction,
);
router.post(
  "/api/saas/subscriptions/:subscriptionId/cancel",
  ...admin,
  adminController.subscriptionStatusAction,
);

router.get("/api/saas/payments", ...admin, adminController.getPayments);
router.get("/api/saas/invoices", ...admin, adminController.getInvoices);

router.get("/api/saas/support/tickets", ...admin, adminController.getTickets);
router.get(
  "/api/saas/support/tickets/:ticketId",
  ...admin,
  adminController.getTicket,
);
router.post(
  "/api/saas/support/tickets/:ticketId/reply",
  ...admin,
  adminController.replyTicket,
);
router.post(
  "/api/saas/support/tickets/:ticketId/status",
  ...admin,
  adminController.updateTicketStatus,
);

export default router;
