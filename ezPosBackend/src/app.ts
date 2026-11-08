import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import productRouter from "./modules/products/products.routes.js";
import salesRouter from "./modules/sales/sales.routes.js";
import saleIntentsRouter from "./modules/sales/saleIntents.routes.js";
import taxRatesRouter from "./modules/taxRates/taxRates.routes.js";
import heldSalesRouter from "./modules/heldSales/heldSales.routes.js";
import realtimeRouter from "./modules/realtime/realtime.routes.js";
import stockCountRouter from "./modules/stockCount/stockCount.routes.js";
import reorderRouter from "./modules/reorder/reorder.routes.js";
import loyaltyRouter from "./modules/loyalty/loyalty.routes.js";
import giftCardsRouter from "./modules/giftCards/giftCards.routes.js";
import promotionsRouter from "./modules/promotions/promotions.routes.js";
import attendanceRouter from "./modules/attendance/attendance.routes.js";
import notificationsRouter from "./modules/notifications/notifications.routes.js";
import hardwareRouter from "./modules/hardware/hardware.routes.js";
import terminalsRouter from "./modules/hardware/terminals.routes.js";
import bridgeRouter from "./modules/hardware/bridge.routes.js";
import customersRouter from "./modules/customers/customers.routes.js";
import expenseRouter from "./modules/expenses/expenses.routes.js";
import landedCostRouter from "./modules/landed-cost/landed-cost.routes.js";
import productImportRouter from "./modules/productImport/productImport.routes.js";
import productImagesRouter from "./modules/productImages/productImages.routes.js";
import purchasesRouter from "./modules/purchases/purchases.routes.js";
import purchasesReturnRouter from "./modules/purchaseReturn/purchaseReturn.routes.js";
import procurementRouter from "./modules/procurement/procurement.routes.js";
import addProductRouter from "./modules/addProduct/product.routes.js";
import uomRouter from "./modules/uom/uom.routes.js";
import contactRouter from "./modules/contact/contact.routes.js";
import dueManagementRouter from "./modules/dueManagement/dueManagement.routes.js";
import documentSettingsRouter from "./modules/documentSettings/documentSettings.routes.js";
import reportsRouter from "./modules/reports/reports.routes.js";
import subscriptionPlansRouter from "./modules/subscriptionPlans/subscriptionPlans.routes.js";
import authRouter from "./modules/auth/auth.routes.js";
import businessesRouter from "./modules/businesses/businesses.routes.js";
import rolesRouter from "./modules/roles/roles.routes.js";
import usersRouter from "./modules/users/users.routes.js";
import locationsRouter from "./modules/locations/locations.routes.js";
import stockTransfersRouter from "./modules/stockTransfers/stockTransfers.routes.js";
import cashRegistersRouter from "./modules/cashRegisters/cashRegisters.routes.js";
import posSettingsRouter from "./modules/posSettings/posSettings.routes.js";
import syncRouter from "./modules/sync/sync.routes.js";
import syncStatusRouter from "./sync/syncStatus.routes.js";
import offlineRouter from "./modules/offline/offline.routes.js";
import barcodesRouter from "./modules/barcodes/barcodes.routes.js";
import backupsRouter from "./modules/backups/backups.routes.js";
import supportRouter from "./modules/support/support.routes.js";
import supportPortalRouter from "./modules/support/supportPortal.routes.js";
import subscriptionsPortalRouter from "./modules/subscriptions/subscriptions.routes.js";
import paymentsRouter from "./modules/payments/payments.routes.js";
import saasAdminRouter from "./modules/saasAdmin/saasAdmin.routes.js";
import storefrontRouter from "./modules/storefront/storefront.routes.js";
import integrationsRouter from "./modules/integrations/integrations.routes.js";
import webhooksRouter from "./modules/webhooks/webhookEndpoints.routes.js";
import ordersAdminRouter from "./modules/commerce/ordersAdmin.routes.js";
import storefrontsRouter from "./modules/storefronts/storefronts.routes.js";
import internalRouter from "./modules/internal/internal.routes.js";
import financeRouter from "./modules/finance/finance.routes.js";
import pricingRouter from "./modules/pricing/pricing.routes.js";
import customerGroupsRouter from "./modules/customerGroups/customerGroups.routes.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "./utils/handleError.js";
import { env } from "./config/env.js";
import { db } from "./db/schema/index.js";
import { sql } from "drizzle-orm";

/**
 * Builds the fully-wired Express app (routes + error handling) without
 * binding a port, so integration tests can run it on an ephemeral port.
 */
export function buildApp() {
  const app = express();
  // middleware
  // Browser clients (website, POS frontend) are allow-listed via CORS_ORIGINS
  // and may send credentials (the HttpOnly refresh cookie). No wildcard.
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
    }),
  );
  app.use(
    express.json({
      // WooCommerce webhooks sign the EXACT bytes they send — capture the
      // raw body (only for that path) before JSON parsing consumes it.
      verify: (req: Request & { originalUrl?: string }, _res, buf) => {
        if (
          req.originalUrl?.startsWith(
            "/api/integrations/woocommerce/webhook/",
          )
        ) {
          (req as Request & { __rawBody?: string }).__rawBody =
            buf.toString("utf8");
        }
      },
    }),
  );
  // Gateway IPNs (SSLCommerz) post form-urlencoded payloads.
  app.use(express.urlencoded({ extended: false }));

  // Baseline security headers (kept dependency-free; a CSP belongs to the
  // frontends, which serve the HTML).
  app.use((req: Request, res: Response, next: NextFunction) => {
    void req;
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  // Liveness/readiness probe for load balancers and container runtimes.
  app.get("/healthz", async (_req: Request, res: Response) => {
    try {
      await db.execute(sql`SELECT 1`);
      res.status(200).json({ status: "ok" });
    } catch (err) {
      console.error("Health check failed:", err);
      res.status(503).json({ status: "unhealthy" });
    }
  });

  app.use("/", productRouter);
  app.use("/", uomRouter);
  app.use("/", salesRouter);
  // Payment-intent IPN is public and must match before generic sale routes.
  app.use("/", saleIntentsRouter);
  app.use("/", taxRatesRouter);
  app.use("/", heldSalesRouter);
  app.use("/", realtimeRouter);
  app.use("/", stockCountRouter);
  app.use("/", reorderRouter);
  app.use("/", loyaltyRouter);
  app.use("/", giftCardsRouter);
  app.use("/", promotionsRouter);
  app.use("/", attendanceRouter);
  app.use("/", notificationsRouter);
  app.use("/", hardwareRouter);
  app.use("/", terminalsRouter);
  app.use("/", bridgeRouter);
  app.use("/", customersRouter);
  app.use("/", expenseRouter);
  app.use("/", landedCostRouter);
  app.use("/", productImportRouter);
  app.use("/", productImagesRouter);
  app.use("/", purchasesRouter);
  app.use("/", purchasesReturnRouter);
  app.use("/", procurementRouter);
  app.use("/", addProductRouter);
  app.use("/", contactRouter);
  app.use("/", dueManagementRouter);
  app.use("/", documentSettingsRouter);
  app.use("/", reportsRouter);
  app.use("/", subscriptionPlansRouter);
  app.use("/", authRouter);
  app.use("/", businessesRouter);
  app.use("/", rolesRouter);
  app.use("/", usersRouter);
  app.use("/", locationsRouter);
  app.use("/", stockTransfersRouter);
  app.use("/", cashRegistersRouter);
  app.use("/", posSettingsRouter);
  app.use("/", syncRouter);
  app.use("/", syncStatusRouter);
  app.use("/", offlineRouter);
  app.use("/", barcodesRouter);
  app.use("/", backupsRouter);
  app.use("/", supportRouter);
  app.use("/", supportPortalRouter);
  app.use("/", subscriptionsPortalRouter);
  app.use("/", paymentsRouter);
  app.use("/", saasAdminRouter);
  app.use("/", storefrontRouter);
  app.use("/", integrationsRouter);
  app.use("/", webhooksRouter);
  app.use("/", ordersAdminRouter);
  app.use("/", storefrontsRouter);
  app.use("/", internalRouter);
  app.use("/", financeRouter);
  app.use("/", pricingRouter);
  app.use("/", customerGroupsRouter);

  // error handling
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    console.error(err);

    if (err instanceof BadRequestError) {
      return res.status(400).json({ success: false, message: err.message });
    }

    if (err instanceof NotFoundError) {
      return res.status(404).json({ success: false, message: err.message });
    }

    if (err instanceof ConflictError) {
      return res.status(409).json({ success: false, message: err.message });
    }

    if (err instanceof ForbiddenError) {
      return res.status(403).json({
        success: false,
        message: err.message,
        ...(err.code ? { code: err.code } : {}),
      });
    }

    // Malformed JSON bodies surface as SyntaxError from express.json().
    if (err instanceof SyntaxError && "body" in err) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid JSON body." });
    }

    // Bodies over the express.json limit (e.g. an oversized logo data URL)
    // surface as body-parser's PayloadTooLargeError — a client error, not
    // a server fault.
    if ((err as { type?: string }).type === "entity.too.large") {
      return res.status(413).json({
        success: false,
        message: "Request body is too large.",
      });
    }

    // Fallback for standard Errors or unknown issues. Never return err.message
    // here — it can contain SQL fragments, driver messages, or internal paths.
    // Detailed errors stay in the server log above only.
    return res
      .status(500)
      .json({ success: false, message: "An unexpected server error occurred." });
  });

  return app;
}
