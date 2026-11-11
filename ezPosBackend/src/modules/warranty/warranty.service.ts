import { and, asc, count, eq, gte, ilike, lt, lte, or, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { customers } from "../../db/schema/customers.js";
import { locations } from "../../db/schema/locations.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { products } from "../../db/schema/products.js";
import { saleItems } from "../../db/schema/saleItems.js";
import { sales } from "../../db/schema/sales.js";
import { serialNumbers } from "../../db/schema/serialNumbers.js";
import { variantOptions } from "../../db/schema/variantOptions.js";
import { variantValues } from "../../db/schema/variantValues.js";
import {
  customerWarranties,
  warrantyClaims,
} from "../../db/schema/warranties.js";
import { NotFoundError } from "../../utils/handleError.js";
import { getDocumentBranding } from "../documentSettings/documentSettings.service.js";
import type { WarrantyListQuery } from "./warranty.schemas.js";

/**
 * Warranty registry service — list, lookup, detail and certificate payload.
 * "expired" and "expiring" are DERIVED views over expiry_date (D3); the
 * stored status only carries lifecycle states. Every query is business-
 * scoped; foreign ids read as missing (404).
 */

const EXPIRING_SOON_DAYS = 30;

/** SQL CASE producing the derived display status of a warranty row. */
const derivedStatusSql = sql<string>`CASE
  WHEN ${customerWarranties.status} <> 'active' THEN ${customerWarranties.status}
  WHEN ${customerWarranties.expiryDate} < now() THEN 'expired'
  WHEN ${customerWarranties.expiryDate} < now() + INTERVAL '${sql.raw(
    String(EXPIRING_SOON_DAYS),
  )} days' THEN 'expiring'
  ELSE 'active'
END`;

function buildWarrantyFilters(businessId: number, filters: WarrantyListQuery) {
  const conditions = [eq(customerWarranties.businessId, businessId)];
  switch (filters.status) {
    case "active":
      conditions.push(
        eq(customerWarranties.status, "active"),
        gte(customerWarranties.expiryDate, new Date()),
      );
      break;
    case "expiring":
      conditions.push(
        eq(customerWarranties.status, "active"),
        gte(customerWarranties.expiryDate, new Date()),
        lt(
          customerWarranties.expiryDate,
          new Date(Date.now() + EXPIRING_SOON_DAYS * 86_400_000),
        ),
      );
      break;
    case "expired":
      conditions.push(
        eq(customerWarranties.status, "active"),
        lt(customerWarranties.expiryDate, new Date()),
      );
      break;
    case "voided":
    case "replaced":
    case "suspended":
      conditions.push(eq(customerWarranties.status, filters.status));
      break;
    default:
      break;
  }
  if (filters.customerId)
    conditions.push(eq(customerWarranties.customerId, filters.customerId));
  if (filters.productId)
    conditions.push(eq(customerWarranties.productId, filters.productId));
  if (filters.variantId)
    conditions.push(eq(customerWarranties.variantId, filters.variantId));
  if (filters.provider)
    conditions.push(eq(customerWarranties.provider, filters.provider));
  if (filters.dateFrom)
    conditions.push(
      gte(customerWarranties.startDate, new Date(`${filters.dateFrom}T00:00:00.000Z`)),
    );
  if (filters.dateTo)
    conditions.push(
      lte(customerWarranties.startDate, new Date(`${filters.dateTo}T23:59:59.999Z`)),
    );
  return and(...conditions);
}

export async function listWarranties(
  businessId: number,
  filters: WarrantyListQuery,
  locationId?: number,
) {
  const conditions = [buildWarrantyFilters(businessId, filters)];
  if (locationId != null) {
    conditions.push(sql`${customerWarranties.locationId} = ${locationId}`);
  }
  if (filters.search) {
    const term = `%${filters.search}%`;
    conditions.push(
      or(
        ilike(customerWarranties.warrantyNumber, term),
        ilike(customerWarranties.serialNumber, term),
        ilike(sales.invoiceNumber, term),
        ilike(customers.name, term),
      )!,
    );
  }
  const where = and(...conditions);

  const rows = await db
    .select({
      id: customerWarranties.id,
      warrantyNumber: customerWarranties.warrantyNumber,
      status: derivedStatusSql,
      storedStatus: customerWarranties.status,
      provider: customerWarranties.provider,
      warrantyType: customerWarranties.warrantyType,
      duration: customerWarranties.duration,
      durationUnit: customerWarranties.durationUnit,
      startDate: customerWarranties.startDate,
      expiryDate: customerWarranties.expiryDate,
      quantity: customerWarranties.quantity,
      returnedQuantity: customerWarranties.returnedQuantity,
      serialNumber: customerWarranties.serialNumber,
      voidReason: customerWarranties.voidReason,
      saleId: customerWarranties.saleId,
      invoiceNumber: sales.invoiceNumber,
      customerId: customerWarranties.customerId,
      customerName: customers.name,
      customerPhone: customers.phone,
      productId: customerWarranties.productId,
      productName: products.name,
      variantId: customerWarranties.variantId,
      variantOptionLabel: sql<
        string | null
      >`(SELECT string_agg(vo.value, ', ' ORDER BY vv.option_id)
         FROM variant_values vv
         INNER JOIN variant_options vo ON vo.id = vv.option_id
         WHERE vv.variant_id = ${customerWarranties.variantId})`,
      locationName: locations.name,
      createdAt: customerWarranties.createdAt,
    })
    .from(customerWarranties)
    .leftJoin(sales, and(eq(sales.id, customerWarranties.saleId), eq(sales.businessId, customerWarranties.businessId)))
    .leftJoin(customers, eq(customers.id, customerWarranties.customerId))
    .innerJoin(products, eq(products.id, customerWarranties.productId))
    .leftJoin(locations, and(eq(locations.id, customerWarranties.locationId), eq(locations.businessId, customerWarranties.businessId)))
    .where(where)
    .orderBy(asc(customerWarranties.expiryDate))
    .limit(filters.pageSize)
    .offset((filters.page - 1) * filters.pageSize);

  const [totalRow] = await db
    .select({ total: count() })
    .from(customerWarranties)
    .leftJoin(sales, and(eq(sales.id, customerWarranties.saleId), eq(sales.businessId, customerWarranties.businessId)))
    .leftJoin(customers, eq(customers.id, customerWarranties.customerId))
    .where(where);

  return { rows, total: Number(totalRow?.total ?? 0) };
}

export async function getWarrantyDetail(businessId: number, warrantyId: number) {
  const [warranty] = await db
    .select({
      warranty: customerWarranties,
      invoiceNumber: sales.invoiceNumber,
      saleDate: sales.saleDate,
      customerName: customers.name,
      customerPhone: customers.phone,
      customerEmail: customers.email,
      customerAddress: customers.address,
      productName: products.name,
      variantOptionLabel: sql<
        string | null
      >`(SELECT string_agg(vo.value, ', ' ORDER BY vv.option_id)
         FROM variant_values vv
         INNER JOIN variant_options vo ON vo.id = vv.option_id
         WHERE vv.variant_id = ${customerWarranties.variantId})`,
      locationName: locations.name,
    })
    .from(customerWarranties)
    .leftJoin(sales, and(eq(sales.id, customerWarranties.saleId), eq(sales.businessId, customerWarranties.businessId)))
    .leftJoin(customers, eq(customers.id, customerWarranties.customerId))
    .innerJoin(products, eq(products.id, customerWarranties.productId))
    .leftJoin(locations, and(eq(locations.id, customerWarranties.locationId), eq(locations.businessId, customerWarranties.businessId)))
    .where(
      and(
        eq(customerWarranties.businessId, businessId),
        eq(customerWarranties.id, warrantyId),
      ),
    )
    .limit(1);
  if (!warranty) throw new NotFoundError("Warranty not found.");

  const claims = await db
    .select({
      id: warrantyClaims.id,
      claimNumber: warrantyClaims.claimNumber,
      claimType: warrantyClaims.claimType,
      status: warrantyClaims.status,
      resolutionType: warrantyClaims.resolutionType,
      reportedProblem: warrantyClaims.reportedProblem,
      repairCost: warrantyClaims.repairCost,
      createdAt: warrantyClaims.createdAt,
      closedDate: warrantyClaims.closedDate,
    })
    .from(warrantyClaims)
    .where(
      and(
        eq(warrantyClaims.businessId, businessId),
        eq(warrantyClaims.warrantyId, warrantyId),
      ),
    )
    .orderBy(asc(warrantyClaims.createdAt));

  return { ...warranty, claims };
}

/**
 * Cashier-facing lookup for the claim-creation wizard: find warranties by
 * serial number, invoice number, customer phone or warranty number.
 */
export async function lookupWarranties(
  businessId: number,
  type: "serial" | "invoice" | "phone" | "number",
  q: string,
) {
  const term = `%${q}%`;
  const conditions = [eq(customerWarranties.businessId, businessId)];
  switch (type) {
    case "serial":
      conditions.push(ilike(customerWarranties.serialNumber, term));
      break;
    case "number":
      conditions.push(ilike(customerWarranties.warrantyNumber, term));
      break;
    case "invoice":
      conditions.push(ilike(sales.invoiceNumber, term));
      break;
    case "phone":
      conditions.push(ilike(customers.phone, term));
      break;
  }

  return db
    .select({
      id: customerWarranties.id,
      warrantyNumber: customerWarranties.warrantyNumber,
      status: derivedStatusSql,
      storedStatus: customerWarranties.status,
      expiryDate: customerWarranties.expiryDate,
      startDate: customerWarranties.startDate,
      quantity: customerWarranties.quantity,
      returnedQuantity: customerWarranties.returnedQuantity,
      serialNumber: customerWarranties.serialNumber,
      provider: customerWarranties.provider,
      warrantyType: customerWarranties.warrantyType,
      duration: customerWarranties.duration,
      durationUnit: customerWarranties.durationUnit,
      invoiceNumber: sales.invoiceNumber,
      customerName: customers.name,
      customerPhone: customers.phone,
      productName: products.name,
      variantOptionLabel: sql<
        string | null
      >`(SELECT string_agg(vo.value, ', ' ORDER BY vv.option_id)
         FROM variant_values vv
         INNER JOIN variant_options vo ON vo.id = vv.option_id
         WHERE vv.variant_id = ${customerWarranties.variantId})`,
    })
    .from(customerWarranties)
    .leftJoin(sales, and(eq(sales.id, customerWarranties.saleId), eq(sales.businessId, customerWarranties.businessId)))
    .leftJoin(customers, eq(customers.id, customerWarranties.customerId))
    .innerJoin(products, eq(products.id, customerWarranties.productId))
    .where(and(...conditions))
    .orderBy(asc(customerWarranties.expiryDate))
    .limit(20);
}

/**
 * Certificate payload: business branding + document settings + the warranty
 * snapshot. The frontend renders it from the same documentSettings configs
 * the receipt/invoice renderers consume.
 */
export async function getWarrantyCertificate(
  businessId: number,
  warrantyId: number,
) {
  const detail = await getWarrantyDetail(businessId, warrantyId);
  const branding = await getDocumentBranding(businessId);

  return {
    warranty: detail,
    branding,
  };
}

/**
 * Receipt enrichment: per-line serials + warranty summary for the sold
 * variant. Additive — existing receipt consumers keep working.
 */
export async function getWarrantiesForSale(
  businessId: number,
  saleId: number,
) {
  return db
    .select({
      saleItemId: customerWarranties.saleItemId,
      warrantyNumber: customerWarranties.warrantyNumber,
      provider: customerWarranties.provider,
      warrantyType: customerWarranties.warrantyType,
      duration: customerWarranties.duration,
      durationUnit: customerWarranties.durationUnit,
      startDate: customerWarranties.startDate,
      expiryDate: customerWarranties.expiryDate,
      serialNumber: customerWarranties.serialNumber,
      quantity: customerWarranties.quantity,
    })
    .from(customerWarranties)
    .where(
      and(
        eq(customerWarranties.businessId, businessId),
        eq(customerWarranties.saleId, saleId),
      ),
    )
    .orderBy(asc(customerWarranties.saleItemId), asc(customerWarranties.id));
}

/** Per-sale-item serial texts for the receipt line display. */
export async function getSerialsForSale(
  businessId: number,
  saleId: number,
) {
  return db
    .select({
      saleItemId: serialNumbers.saleItemId,
      serialNumber: serialNumbers.serialNumber,
    })
    .from(serialNumbers)
    .innerJoin(saleItems, and(eq(saleItems.id, serialNumbers.saleItemId), eq(saleItems.businessId, businessId)))
    .where(
      and(
        eq(serialNumbers.businessId, businessId),
        eq(saleItems.saleId, saleId),
      ),
    )
    .orderBy(asc(serialNumbers.saleItemId), asc(serialNumbers.id));
}
