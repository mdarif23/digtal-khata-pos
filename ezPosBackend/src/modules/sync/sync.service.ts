import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { businesses } from "../../db/schema/businesses.js";
import { locations } from "../../db/schema/locations.js";
import { users } from "../../db/schema/users.js";
import { roles } from "../../db/schema/roles.js";
import { permissions } from "../../db/schema/permissions.js";
import { rolePermissions } from "../../db/schema/rolePermissions.js";
import { userRoles } from "../../db/schema/userRoles.js";
import { businessMemberships } from "../../db/schema/businessMemberships.js";
import { userLocationAssignments } from "../../db/schema/userLocationAssignments.js";
import { posSettings } from "../../db/schema/posSettings.js";
import { posTerminals } from "../../db/schema/posTerminals.js";
import { products } from "../../db/schema/products.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { variantBarcodeAliases } from "../../db/schema/variantBarcodeAliases.js";
import { productTaxes } from "../../db/schema/productTaxes.js";
import { taxRates } from "../../db/schema/taxRates.js";
import { categories } from "../../db/schema/categories.js";
import { brands } from "../../db/schema/brands.js";
import { units } from "../../db/schema/units.js";
import { customers } from "../../db/schema/customers.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { inventoryBatches } from "../../db/schema/inventoryBatches.js";
import { serialNumbers } from "../../db/schema/serialNumbers.js";
import { subscriptionPlans } from "../../db/schema/subscriptionPlans.js";
import { subscriptions } from "../../db/schema/subscriptions.js";
import { salePayments } from "../../db/schema/salePayments.js";
import { recordAudit } from "../../services/audit.js";
import { BadRequestError, NotFoundError } from "../../utils/handleError.js";
import * as salesService from "../sales/sales.service.js";
import type { SyncAgentContext } from "../../middleware/syncAuth.js";
import {
  createSalePayloadSchema,
  type CreateSalePayload,
} from "../sales/schemas/sales.schema.js";

/**
 * Cloud-side LAN sync API (Phase 2). The local server authenticates as the
 * shop's sync-agent terminal and:
 *  - pulls a full identity snapshot (business, locations, users+roles+
 *    memberships, plans+subscription) — small tables, refreshed whole;
 *  - pulls catalog deltas by updated_at watermark;
 *  - pulls a full stock snapshot for ITS location (push-then-pull ordering
 *    makes the overwrite safe — see the agent);
 *  - pushes ops (customer.create, sale.create) whose payload-level
 *    idempotency (client_uuid / sale idempotency key) makes replays safe.
 *
 * CATALOG watermark note: hard-deleted products are invisible to a delta —
 * the agent's force-refresh (since=0) covers that; products use soft status
 * in the normal flow.
 */

export interface SyncOp {
  opId: string;
  type: "customer.create" | "sale.create";
  recordedAt?: string;
  payload: unknown;
}

export interface SyncOpResult {
  opId: string;
  status: "applied" | "duplicate" | "failed";
  customerId?: number;
  saleId?: number;
  invoiceNumber?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// GET /api/sync/bootstrap — full identity snapshot (small tables)
// ---------------------------------------------------------------------------

export async function getBootstrap(agent: SyncAgentContext) {
  const businessId = agent.businessId;
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, businessId));
  if (!business) throw new NotFoundError("Business not found.");

  const [locations_, users_, roles_, memberships, assignments, userRoles_] =
    await Promise.all([
      db.select().from(locations).where(eq(locations.businessId, businessId)),
      db.select().from(users), // all users — any cashier may sign in locally
      db.select().from(roles).where(eq(roles.businessId, businessId)),
      db
        .select()
        .from(businessMemberships)
        .where(eq(businessMemberships.businessId, businessId)),
      db
        .select()
        .from(userLocationAssignments)
        .where(eq(userLocationAssignments.businessId, businessId)),
      db.select().from(userRoles).where(eq(userRoles.businessId, businessId)),
    ]);
  const roleIds = roles_.map((r) => r.id);
  const rolePerms = roleIds.length
    ? await db.select().from(rolePermissions).where(inArray(rolePermissions.roleId, roleIds))
    : [];
  // The permissions catalog rides along: role_permissions rows reference it.
  const permissionRows = await db.select().from(permissions);

  const [plans, subscription, settings] = await Promise.all([
    db.select().from(subscriptionPlans),
    db.select().from(subscriptions).where(eq(subscriptions.businessId, businessId)),
    db.select().from(posSettings).where(eq(posSettings.businessId, businessId)),
  ]);

  return {
    terminal: { id: agent.terminalId, name: agent.name, locationId: agent.locationId },
    business,
    locations: locations_,
    users: users_,
    roles: roles_,
    permissions: permissionRows,
    rolePermissions: rolePerms,
    userRoles: userRoles_,
    memberships,
    locationAssignments: assignments,
    plans,
    subscription: subscription[0] ?? null,
    posSettings: settings[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// GET /api/sync/catalog?since= — watermark delta (products tree + refs)
// ---------------------------------------------------------------------------

export async function getCatalogDelta(businessId: number, since: string | null) {
  const watermark = parseWatermark(since);

  const changedProductIds = new Set<number>();
  const productRows = await db
    .select({ id: products.id })
    .from(products)
    .where(
      watermark
        ? and(eq(products.businessId, businessId), sql`${products.updatedAt} > ${watermark}::timestamptz`)
        : eq(products.businessId, businessId),
    );
  for (const row of productRows) changedProductIds.add(row.id);

  const variantRows = await db
    .select({ id: productVariants.id, productId: productVariants.productId })
    .from(productVariants)
    .where(
      watermark
        ? and(
            eq(productVariants.businessId, businessId),
            sql`${productVariants.updatedAt} > ${watermark}::timestamptz`,
          )
        : eq(productVariants.businessId, businessId),
    );
  const variantChangedProductIds = [...new Set(variantRows.map((v) => v.productId))];

  const aliasRows = watermark
    ? await db
        .select({ productId: variantBarcodeAliases.variantId, aliasUpdatedAt: variantBarcodeAliases.updatedAt })
        .from(variantBarcodeAliases)
        .innerJoin(productVariants, eq(productVariants.id, variantBarcodeAliases.variantId))
        .where(
          and(
            eq(variantBarcodeAliases.businessId, businessId),
            sql`${variantBarcodeAliases.updatedAt} > ${watermark}::timestamptz`,
          ),
        )
    : await db
        .select({ productId: variantBarcodeAliases.variantId, aliasUpdatedAt: variantBarcodeAliases.updatedAt })
        .from(variantBarcodeAliases)
        .innerJoin(productVariants, eq(productVariants.id, variantBarcodeAliases.variantId))
        .where(eq(variantBarcodeAliases.businessId, businessId));

  for (const pid of variantChangedProductIds) changedProductIds.add(pid);
  for (const row of aliasRows) changedProductIds.add(row.productId);

  const ids = [...changedProductIds];
  const productsOut =
    ids.length === 0
      ? []
      : await db.select().from(products).where(inArray(products.id, ids));
  const variantsOut =
    ids.length === 0
      ? []
      : await db
          .select()
          .from(productVariants)
          .where(inArray(productVariants.productId, ids));
  const variantIds = variantsOut.map((v) => v.id);
  const aliasesOut = variantIds.length
    ? await db
        .select()
        .from(variantBarcodeAliases)
        .where(inArray(variantBarcodeAliases.variantId, variantIds))
    : [];
  const taxesOut = ids.length
    ? await db.select().from(productTaxes).where(inArray(productTaxes.productId, ids))
    : [];

  // Small reference tables ride along in full on every pull.
  const [taxRatesOut, categoriesOut, brandsOut, unitsOut] = await Promise.all([
    db.select().from(taxRates).where(eq(taxRates.businessId, businessId)),
    db.select().from(categories).where(eq(categories.businessId, businessId)),
    db.select().from(brands).where(eq(brands.businessId, businessId)),
    db.select().from(units).where(eq(units.businessId, businessId)),
  ]);

  const cursor = await currentCatalogWatermark(businessId);
  return {
    products: productsOut,
    variants: variantsOut,
    barcodeAliases: aliasesOut,
    productTaxes: taxesOut,
    taxRates: taxRatesOut,
    categories: categoriesOut,
    brands: brandsOut,
    units: unitsOut,
    cursor,
  };
}

// Watermarks travel as raw PG text (microsecond precision) and are compared
// in SQL — round-tripping through JS Date would truncate to milliseconds and
// re-serve the row the cursor already covered.
async function currentCatalogWatermark(businessId: number): Promise<string> {
  const [watermark] = await db
    .select({
      maxAt: sql<string>`GREATEST(
        COALESCE((SELECT MAX(updated_at) FROM products WHERE business_id = ${businessId}), to_timestamp(0)),
        COALESCE((SELECT MAX(updated_at) FROM product_variants WHERE business_id = ${businessId}), to_timestamp(0)),
        COALESCE((SELECT MAX(updated_at) FROM variant_barcode_aliases WHERE business_id = ${businessId}), to_timestamp(0)),
        COALESCE((SELECT MAX(updated_at) FROM tax_rates WHERE business_id = ${businessId}), to_timestamp(0))
      )::text`,
    })
    .from(sql`(SELECT 1) AS one`);
  return watermark!.maxAt;
}

// ---------------------------------------------------------------------------
// GET /api/sync/stock — full snapshot for the agent's location
// ---------------------------------------------------------------------------

export async function getStockSnapshot(agent: SyncAgentContext) {
  const businessId = agent.businessId;
  const locationId = agent.locationId;
  const [stock, batches, serials] = await Promise.all([
    db
      .select()
      .from(inventoryStock)
      .where(
        and(
          eq(inventoryStock.businessId, businessId),
          eq(inventoryStock.locationId, locationId),
        ),
      ),
    db
      .select()
      .from(inventoryBatches)
      .where(
        and(
          eq(inventoryBatches.businessId, businessId),
          eq(inventoryBatches.locationId, locationId),
        ),
      ),
    db
      .select()
      .from(serialNumbers)
      .where(
        and(
          eq(serialNumbers.businessId, businessId),
          eq(serialNumbers.locationId, locationId),
          eq(serialNumbers.status, "in_stock"),
        ),
      ),
  ]);
  return { locationId, stock, batches, serials };
}

// ---------------------------------------------------------------------------
// GET /api/sync/customers?since= — watermark delta
// ---------------------------------------------------------------------------

export async function getCustomersDelta(businessId: number, since: string | null) {
  const watermark = parseWatermark(since);
  const rows = await db
    .select()
    .from(customers)
    .where(
      watermark
        ? and(eq(customers.businessId, businessId), sql`${customers.updatedAt} > ${watermark}::timestamptz`)
        : eq(customers.businessId, businessId),
    );
  const [customersWatermark] = await db
    .select({
      maxAt: sql<string>`COALESCE((SELECT MAX(updated_at) FROM customers WHERE business_id = ${businessId}), to_timestamp(0))::text`,
    })
    .from(sql`(SELECT 1) AS one`);
  return { customers: rows, cursor: customersWatermark!.maxAt };
}

/** Validates the watermark; the raw text goes straight into SQL compares. */
function parseWatermark(since: string | null | undefined): string | null {
  if (!since || since === "0" || since === "epoch") return null;
  const date = new Date(since);
  return Number.isNaN(date.getTime()) ? null : since;
}

// ---------------------------------------------------------------------------
// POST /api/sync/ops — idempotent op application
// ---------------------------------------------------------------------------

interface CustomerCreatePayload {
  clientUuid: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
}

interface SaleCreatePayload {
  locationId: number;
  cashierUserId: number | null;
  terminalName: string | null;
  sale: CreateSalePayload;
}

export async function applyOps(
  agent: SyncAgentContext,
  ops: SyncOp[],
): Promise<SyncOpResult[]> {
  const results: SyncOpResult[] = [];
  for (const op of ops) {
    try {
      if (op.type === "customer.create") {
        results.push(await applyCustomerOp(agent, op));
      } else if (op.type === "sale.create") {
        results.push(await applySaleOp(agent, op));
      } else {
        results.push({
          opId: op.opId,
          status: "failed",
          error: `Unknown op type: ${String((op as { type?: string }).type)}`,
        });
      }
    } catch (err) {
      results.push({
        opId: op.opId,
        status: "failed",
        error: err instanceof Error ? err.message : "Op application failed.",
      });
    }
  }
  return results;
}

async function applyCustomerOp(
  agent: SyncAgentContext,
  op: SyncOp,
): Promise<SyncOpResult> {
  const payload = op.payload as CustomerCreatePayload;
  if (!payload?.clientUuid || !payload?.name) {
    throw new BadRequestError("customer.create requires clientUuid and name.");
  }
  const [existing] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eq(customers.businessId, agent.businessId),
        eq(customers.clientUuid, payload.clientUuid),
      ),
    );
  if (existing) {
    return { opId: op.opId, status: "duplicate", customerId: existing.id };
  }
  const [created] = await db
    .insert(customers)
    .values({
      businessId: agent.businessId,
      name: payload.name,
      phone: payload.phone ?? null,
      email: payload.email ?? null,
      address: payload.address ?? null,
      clientUuid: payload.clientUuid,
    })
    .returning({ id: customers.id });
  if (!created) throw new Error("Customer op insert returned no row.");
  recordAudit({
    businessId: agent.businessId,
    actorUserId: null,
    action: "customer.sync_applied",
    entityType: "customer",
    entityId: created.id,
    metadata: { opId: op.opId, clientUuid: payload.clientUuid },
  });
  return { opId: op.opId, status: "applied", customerId: created.id };
}

async function applySaleOp(
  agent: SyncAgentContext,
  op: SyncOp,
): Promise<SyncOpResult> {
  const payload = op.payload as SaleCreatePayload;
  if (!payload?.sale) {
    throw new BadRequestError("sale.create requires a sale payload.");
  }
  // Same validation the HTTP controller applies: dates coerce to Date,
  // amounts/quantities are re-checked — sync ops are never more trusted
  // than a checkout request.
  const parsed = createSalePayloadSchema.safeParse(payload.sale);
  if (!parsed.success) {
    throw new BadRequestError(
      `Invalid sale payload: ${JSON.stringify(parsed.error.flatten())}`,
    );
  }
  payload.sale = parsed.data;
  // The agent only uploads sales that were rung at ITS location.
  if (payload.locationId !== agent.locationId) {
    throw new BadRequestError(
      "sale.create location does not match the sync agent's location.",
    );
  }
  const result = await salesService.createSale(
    agent.businessId,
    agent.locationId,
    payload.cashierUserId, // user ids match across servers (identity sync)
    payload.sale,
    null, // cloud replica: terminal identity lives in the audit trail below
    { channel: "offline" },
  );
  recordAudit({
    businessId: agent.businessId,
    actorUserId: payload.cashierUserId,
    action: "sale.sync_applied",
    entityType: "sale",
    entityId: result.sale.id,
    metadata: {
      opId: op.opId,
      terminalName: payload.terminalName,
      cashierUserId: payload.cashierUserId,
    },
  });
  return {
    opId: op.opId,
    status: "applied",
    saleId: result.sale.id,
    invoiceNumber: result.sale.invoiceNumber,
  };
}
