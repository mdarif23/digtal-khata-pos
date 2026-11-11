import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { products } from "../../db/schema/products.js";
import { variantOptions } from "../../db/schema/variantOptions.js";
import { variantValues } from "../../db/schema/variantValues.js";
import { productWarrantyConfigs } from "../../db/schema/warranties.js";
import { NotFoundError } from "../../utils/handleError.js";
import { buildVariantName } from "../../utils/variantDisplay.js";
import {
  resolveWarrantyConfig,
  type ResolvedWarrantyConfig,
} from "./warrantyEngine.service.js";
import type { WarrantyConfigWrite } from "./warranty.schemas.js";

/**
 * Product/variant warranty configuration service (decision D1): a
 * product_warranty_configs row with variant_id NULL is the product default;
 * a row with variant_id set overrides it. A variant row with enabled=false
 * explicitly opts that variant out.
 */

export interface VariantWarrantyView {
  variantId: number;
  variantName: string;
  /** The effective config, or null when the variant has no warranty. */
  effective: ResolvedWarrantyConfig | null;
  /** null = inherits the product default; a row = variant override. */
  override: (WarrantyConfigWrite & { id: number; status: string }) | null;
}

export interface ProductWarrantyView {
  productId: number;
  productName: string;
  hasVariants: boolean | null;
  trackingType: string | null;
  productDefault: (WarrantyConfigWrite & { id: number; status: string }) | null;
  variants: VariantWarrantyView[];
}

async function assertProductInBusiness(businessId: number, productId: number) {
  const [product] = await db
    .select({
      id: products.id,
      name: products.name,
      hasVariants: products.hasVariants,
      trackingType: products.trackingType,
    })
    .from(products)
    .where(and(eq(products.businessId, businessId), eq(products.id, productId)))
    .limit(1);
  if (!product) throw new NotFoundError("Product not found.");
  return product;
}

export async function getProductWarrantyConfig(
  businessId: number,
  productId: number,
): Promise<ProductWarrantyView> {
  const product = await assertProductInBusiness(businessId, productId);

  const [productDefault] = await db
    .select()
    .from(productWarrantyConfigs)
    .where(
      and(
        eq(productWarrantyConfigs.businessId, businessId),
        eq(productWarrantyConfigs.productId, productId),
        sql`${productWarrantyConfigs.variantId} IS NULL`,
      ),
    )
    .limit(1);

  const variants = await db
    .select({
      id: productVariants.id,
      productName: products.name,
      optionValue: variantOptions.value,
      optionOrder: variantValues.optionId,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(variantValues, eq(variantValues.variantId, productVariants.id))
    .leftJoin(variantOptions, eq(variantOptions.id, variantValues.optionId))
    .where(
      and(
        eq(productVariants.businessId, businessId),
        eq(productVariants.productId, productId),
      ),
    )
    .orderBy(asc(productVariants.id));

  const variantOverrides = await db
    .select()
    .from(productWarrantyConfigs)
    .where(
      and(
        eq(productWarrantyConfigs.businessId, businessId),
        eq(productWarrantyConfigs.productId, productId),
        sql`${productWarrantyConfigs.variantId} IS NOT NULL`,
      ),
    );

  // Group option rows per variant preserving the option order.
  const optionsByVariant = new Map<number, string[]>();
  for (const row of variants) {
    const list = optionsByVariant.get(row.id) ?? [];
    if (row.optionValue) list.push(row.optionValue);
    optionsByVariant.set(row.id, list);
  }

  const seenVariants = new Set<number>();
  const variantViews: VariantWarrantyView[] = [];
  for (const row of variants) {
    if (seenVariants.has(row.id)) continue;
    seenVariants.add(row.id);
    const override = variantOverrides.find((o) => o.variantId === row.id);
    const effective = await resolveWarrantyConfig(db, businessId, productId, row.id);
    variantViews.push({
      variantId: row.id,
      variantName: buildVariantName(row.productName, optionsByVariant.get(row.id) ?? []),
      effective: override?.enabled === false ? null : effective,
      override: override
        ? {
            id: override.id,
            status: override.status,
            enabled: override.enabled,
            provider: override.provider as WarrantyConfigWrite["provider"],
            warrantyType: override.warrantyType as WarrantyConfigWrite["warrantyType"],
            duration: override.duration,
            durationUnit: override.durationUnit as WarrantyConfigWrite["durationUnit"],
            terms: override.terms,
          }
        : null,
    });
  }

  return {
    productId: product.id,
    productName: product.name,
    hasVariants: product.hasVariants,
    trackingType: product.trackingType,
    productDefault: productDefault
      ? {
          id: productDefault.id,
          status: productDefault.status,
          enabled: productDefault.enabled,
          provider: productDefault.provider as WarrantyConfigWrite["provider"],
          warrantyType: productDefault.warrantyType as WarrantyConfigWrite["warrantyType"],
          duration: productDefault.duration,
          durationUnit: productDefault.durationUnit as WarrantyConfigWrite["durationUnit"],
          terms: productDefault.terms,
        }
      : null,
    variants: variantViews,
  };
}

async function upsertConfigRow(
  businessId: number,
  productId: number,
  variantId: number | null,
  data: WarrantyConfigWrite,
): Promise<void> {
  // One row per (product, variant-scope) including inactive rows — re-saving
  // an existing config updates it in place (UOM admin pattern). Issued
  // warranties carry snapshots, so updating config never rewrites history.
  const [existing] = await db
    .select({ id: productWarrantyConfigs.id })
    .from(productWarrantyConfigs)
    .where(
      and(
        eq(productWarrantyConfigs.businessId, businessId),
        eq(productWarrantyConfigs.productId, productId),
        variantId != null
          ? eq(productWarrantyConfigs.variantId, variantId)
          : sql`${productWarrantyConfigs.variantId} IS NULL`,
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(productWarrantyConfigs)
      .set({
        enabled: data.enabled,
        provider: data.provider,
        warrantyType: data.warrantyType,
        duration: data.duration,
        durationUnit: data.durationUnit,
        terms: data.terms ?? null,
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(productWarrantyConfigs.id, existing.id));
    return;
  }

  await db.insert(productWarrantyConfigs).values({
    businessId,
    productId,
    variantId,
    enabled: data.enabled,
    provider: data.provider,
    warrantyType: data.warrantyType,
    duration: data.duration,
    durationUnit: data.durationUnit,
    terms: data.terms ?? null,
    status: "active",
  });
}

export async function setProductWarrantyConfig(
  businessId: number,
  productId: number,
  data: WarrantyConfigWrite,
): Promise<ProductWarrantyView> {
  await assertProductInBusiness(businessId, productId);
  await upsertConfigRow(businessId, productId, null, data);
  return getProductWarrantyConfig(businessId, productId);
}

export async function setVariantWarrantyConfig(
  businessId: number,
  productId: number,
  variantId: number,
  data: WarrantyConfigWrite,
): Promise<ProductWarrantyView> {
  await assertProductInBusiness(businessId, productId);
  const [variant] = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.businessId, businessId),
        eq(productVariants.productId, productId),
        eq(productVariants.id, variantId),
      ),
    )
    .limit(1);
  if (!variant) throw new NotFoundError("Variant not found for this product.");
  await upsertConfigRow(businessId, productId, variantId, data);
  return getProductWarrantyConfig(businessId, productId);
}

/** Removing a variant override reverts the variant to the product default. */
export async function removeVariantWarrantyConfig(
  businessId: number,
  productId: number,
  variantId: number,
): Promise<ProductWarrantyView> {
  await assertProductInBusiness(businessId, productId);
  await db
    .delete(productWarrantyConfigs)
    .where(
      and(
        eq(productWarrantyConfigs.businessId, businessId),
        eq(productWarrantyConfigs.productId, productId),
        eq(productWarrantyConfigs.variantId, variantId),
      ),
    );
  return getProductWarrantyConfig(businessId, productId);
}
