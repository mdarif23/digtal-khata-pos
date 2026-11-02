
import type { Request, Response } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { businesses } from "../../db/schema/businesses.js";
import { customers } from "../../db/schema/customers.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { products } from "../../db/schema/products.js";
import { saleItems } from "../../db/schema/saleItems.js";
import { sales } from "../../db/schema/sales.js";
import { getBusinessId } from "../../middleware/business.js";
import { NotFoundError } from "../../utils/handleError.js";

/**
 * Self-serve business data export (JSON download). Read-only on purpose —
 * a read-only (expired) business must keep access to its own historical
 * data. Scoped to the verified business; contains no cross-tenant rows.
 */
export async function exportBusinessData(req: Request, res: Response) {
  try {
    const businessId = getBusinessId(req);
    const [business] = await db
      .select({
        id: businesses.id,
        name: businesses.name,
        slug: businesses.slug,
        mode: businesses.mode,
        createdAt: businesses.createdAt,
      })
      .from(businesses)
      .where(eq(businesses.id, businessId));
    if (!business) throw new NotFoundError("Business not found.");

    const productRows = await db
      .select({
        id: products.id,
        name: products.name,
        productType: products.productType,
        status: products.status,
        variants: sql<string>`coalesce(json_agg(json_build_object('sku', ${productVariants.sku}, 'sellingPrice', ${productVariants.sellingPrice})) FILTER (WHERE ${productVariants.id} IS NOT NULL), '[]'::json)`,
      })
      .from(products)
      .leftJoin(productVariants, eq(productVariants.productId, products.id))
      .where(eq(products.businessId, businessId))
      .groupBy(products.id)
      .orderBy(products.id);

    const customerRows = await db
      .select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
        email: customers.email,
        createdAt: customers.createdAt,
      })
      .from(customers)
      .where(eq(customers.businessId, businessId))
      .orderBy(customers.id);

    const salesRows = await db
      .select({
        id: sales.id,
        invoiceNumber: sales.invoiceNumber,
        channel: sales.channel,
        status: sales.status,
        paymentStatus: sales.paymentStatus,
        total: sales.finalTotal,
        createdAt: sales.createdAt,
        items: sql<string>`coalesce(json_agg(json_build_object('sku', ${productVariants.sku}, 'quantity', ${saleItems.quantity}, 'sellingPrice', ${saleItems.sellingPrice}, 'lineTotal', ${saleItems.lineTotal})) FILTER (WHERE ${saleItems.id} IS NOT NULL), '[]'::json)`,
      })
      .from(sales)
      .leftJoin(saleItems, eq(saleItems.saleId, sales.id))
      .leftJoin(
        productVariants,
        eq(productVariants.id, saleItems.variantId),
      )
      .where(eq(sales.businessId, businessId))
      .groupBy(sales.id)
      .orderBy(desc(sales.id))
      .limit(5000);

    const stockRows = await db
      .select({
        variantId: inventoryStock.variantId,
        quantity: inventoryStock.quantity,
        reservedQuantity: inventoryStock.reservedQuantity,
      })
      .from(inventoryStock)
      .where(eq(inventoryStock.businessId, businessId));

    const payload = {
      exportedAt: new Date().toISOString(),
      format: "ezpos-export-v1",
      business,
      products: productRows,
      customers: customerRows,
      sales: salesRows,
      stock: stockRows,
    };

    res
      .status(200)
      .setHeader(
        "Content-Disposition",
        `attachment; filename="ezpos-export-${businessId}.json"`,
      )
      .setHeader("Content-Type", "application/json")
      .json(payload);
  } catch (err) {
    console.error("Data export failed:", err);
    res
      .status(500)
      .json({ success: false, message: "Unable to export right now." });
  }
}
