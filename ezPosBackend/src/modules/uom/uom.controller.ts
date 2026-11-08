import type { Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { getBusinessId } from "../../middleware/business.js";
import { getLocationId } from "../../middleware/location.js";
import { sendSafeError } from "../../utils/safeError.js";
import { NotFoundError } from "../../utils/handleError.js";
import { inventoryStock } from "../../db/schema/inventoryStock.js";
import { productVariants } from "../../db/schema/productVariants.js";
import * as uomAdmin from "./uom.admin.service.js";
import {
  listSaleUnitsForVariant,
  listPurchaseUnitsForVariant,
  resolveUomContext,
  convertEnteredLine,
  resolveSaleUnitPrice,
} from "./uom.service.js";
import {
  createConversionSchema,
  updateConversionSchema,
  resolveUomSchema,
} from "./uom.validation.js";

function idParam(req: Request, res: Response, name: string): number | null {
  const id = Number(req.params[name]);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ message: `Invalid ${name}` });
    return null;
  }
  return id;
}

function parseBody<T>(
  req: Request,
  res: Response,
  schema: { safeParse: (b: unknown) => { success: true; data: T } | { success: false; error: { flatten: () => unknown } } },
): T | null {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      message: "Invalid packaging data",
      errors: result.error.flatten(),
    });
    return null;
  }
  return result.data;
}

/** GET /api/product/:productId/uom — the Units & Packaging configuration. */
export async function getProductUom(req: Request, res: Response) {
  const productId = idParam(req, res, "productId");
  if (productId === null) return;
  try {
    const data = await uomAdmin.listProductUom(getBusinessId(req), productId);
    return res.json({ data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load the packaging configuration.");
  }
}

/** POST /api/product/:productId/uom — add a packaging unit. */
export async function createProductUom(req: Request, res: Response) {
  const productId = idParam(req, res, "productId");
  if (productId === null) return;
  const input = parseBody(req, res, createConversionSchema);
  if (input === null) return;
  try {
    const data = await uomAdmin.createConversion(getBusinessId(req), productId, input);
    return res.status(201).json({ message: "Packaging unit added", data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to add the packaging unit.");
  }
}

/** PATCH /api/product/uom/:conversionId — flags/prices; factor only while unreferenced. */
export async function updateProductUom(req: Request, res: Response) {
  const conversionId = idParam(req, res, "conversionId");
  if (conversionId === null) return;
  const input = parseBody(req, res, updateConversionSchema);
  if (input === null) return;
  try {
    const data = await uomAdmin.updateConversion(getBusinessId(req), conversionId, input);
    return res.json({ message: "Packaging unit updated", data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to update the packaging unit.");
  }
}

/** POST /api/product/uom/:conversionId/deactivate — the safe retirement path. */
export async function deactivateProductUom(req: Request, res: Response) {
  const conversionId = idParam(req, res, "conversionId");
  if (conversionId === null) return;
  try {
    const data = await uomAdmin.deactivateConversion(getBusinessId(req), conversionId);
    return res.json({ message: "Packaging unit deactivated", data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to deactivate the packaging unit.");
  }
}

/** GET /api/variant/:variantId/sell-units — POS unit picker data. */
export async function getVariantSellUnits(req: Request, res: Response) {
  const variantId = idParam(req, res, "variantId");
  if (variantId === null) return;
  try {
    const businessId = getBusinessId(req);
    const locationId = getLocationId(req);
    const [stock] = await db
      .select({
        quantity: inventoryStock.quantity,
        reserved: inventoryStock.reservedQuantity,
      })
      .from(inventoryStock)
      .where(
        and(
          eq(inventoryStock.businessId, businessId),
          eq(inventoryStock.variantId, variantId),
          eq(inventoryStock.locationId, locationId),
        ),
      )
      .limit(1);
    const availableBaseQuantity =
      stock && stock.quantity != null && stock.reserved != null
        ? stock.quantity - stock.reserved
        : 0;
    const data = await listSaleUnitsForVariant(
      db,
      businessId,
      variantId,
      availableBaseQuantity,
    );
    return res.json({ data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load the selling units.");
  }
}

/** GET /api/variant/:variantId/purchase-units — purchasing unit picker data. */
export async function getVariantPurchaseUnits(req: Request, res: Response) {
  const variantId = idParam(req, res, "variantId");
  if (variantId === null) return;
  try {
    const data = await listPurchaseUnitsForVariant(db, getBusinessId(req), variantId);
    return res.json({ data });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to load the purchase units.");
  }
}

/** POST /api/uom/resolve — server-authoritative conversion preview. */
export async function resolveUom(req: Request, res: Response) {
  const input = parseBody(req, res, resolveUomSchema);
  if (input === null) return;
  try {
    const businessId = getBusinessId(req);
    const out = [];
    for (const item of input.items) {
      const [variant] = await db
        .select({
          id: productVariants.id,
          productId: productVariants.productId,
          sellingPrice: productVariants.sellingPrice,
        })
        .from(productVariants)
        .where(
          and(
            eq(productVariants.id, item.variantId),
            eq(productVariants.businessId, businessId),
          ),
        )
        .limit(1);
      if (!variant) throw new NotFoundError("Variant not found.");

      const ctx = await resolveUomContext(
        db,
        businessId,
        variant.productId,
        variant.id,
        item.uomConversionId ?? null,
      );
      const line = convertEnteredLine(
        ctx,
        item.enteredQuantity,
        item.enteredUnitPrice,
        { wholeBase: input.wholeBase ?? false },
      );
      out.push({
        variantId: item.variantId,
        uomConversionId: item.uomConversionId ?? null,
        enteredQuantity: item.enteredQuantity,
        enteredUnit: ctx.unit,
        baseUnit: ctx.baseUnit,
        conversionFactor: ctx.factor,
        baseQuantity: line.baseQuantity,
        baseUnitPrice: line.baseUnitPrice,
        lineTotal:
          item.enteredUnitPrice != null
            ? Math.round(item.enteredQuantity * item.enteredUnitPrice * 100) / 100
            : null,
        defaultSalePrice: resolveSaleUnitPrice(ctx, variant.sellingPrice),
      });
    }
    return res.json({ data: out });
  } catch (err: unknown) {
    return sendSafeError(res, err, "Unable to resolve the packaging conversion.");
  }
}
