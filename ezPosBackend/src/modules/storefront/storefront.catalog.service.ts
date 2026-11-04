import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { brands } from "../../db/schema/brands.js";
import { categories } from "../../db/schema/categories.js";
import { locations } from "../../db/schema/locations.js";
import { productImages } from "../../db/schema/productImages.js";
import { productVariants } from "../../db/schema/productVariants.js";
import { products } from "../../db/schema/products.js";
import { integrations } from "../../db/schema/integrations.js";
import { storefrontProductVisibility } from "../../db/schema/storefrontProductVisibility.js";
import { variantOptions } from "../../db/schema/variantOptions.js";
import { variantValues } from "../../db/schema/variantValues.js";
import {
  buildVariantName,
  buildVariantOptionsLabel,
  foldVariantOptionRows,
} from "../../utils/variantDisplay.js";
import { getOnlineAvailability } from "../commerce/reservations.service.js";
import type { StorefrontContext } from "../../middleware/storefront.js";

/**
 * Storefront catalog reads (Phase 9.2). SECURITY CONTRACT: only fields
 * intended for public storefronts are selected — never purchase cost,
 * supplier data, or internal flags. Prices come from the variant table;
 * availability comes from the reservation engine (allocation-aware).
 */

export interface StorefrontVariant {
  id: number;
  sku: string;
  price: number;
  isDefault: boolean;
  /** Comma-joined option values, e.g. "Red, Large" — "" for option-less variants. */
  options: string;
  /** Display label "Football (Small)" — the variant the shopper is picking. */
  name: string;
  availability: number;
}

export interface StorefrontProduct {
  id: number;
  name: string;
  description: string | null;
  categoryId: number | null;
  categoryName: string | null;
  brandId: number | null;
  brandName: string | null;
  hasVariants: boolean;
  images: string[];
  variants: StorefrontVariant[];
}

/** The fulfillment location for a key: its integration's, else the default. */
export async function resolveKeyLocation(
  businessId: number,
  integrationId: number | null,
): Promise<number | null> {
  if (integrationId) {
    const [integration] = await db
      .select({ locationId: integrations.locationId })
      .from(integrations)
      .where(eq(integrations.id, integrationId));
    if (integration?.locationId) return integration.locationId;
  }
  const [location] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(
      and(
        eq(locations.businessId, businessId),
        eq(locations.isDefault, true),
      ),
    );
  return location?.id ?? null;
}

async function loadProducts(
  ctx: StorefrontContext,
  where: ReturnType<typeof and>,
  orderBy: ReturnType<typeof asc> | ReturnType<typeof desc>,
  limit?: number,
  offset?: number,
): Promise<StorefrontProduct[]> {
  const rows = await db
    .select({
      productId: products.id,
      name: products.name,
      description: products.description,
      hasVariants: products.hasVariants,
      categoryId: products.categoryId,
      categoryName: categories.name,
      brandId: products.brandId,
      brandName: brands.name,
      variantId: productVariants.id,
      sku: productVariants.sku,
      price: productVariants.sellingPrice,
      isDefault: productVariants.isDefault,
      imageUrl: productImages.imageUrl,
      imageSort: productImages.sortOrder,
    })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .leftJoin(brands, eq(brands.id, products.brandId))
    .leftJoin(
      productVariants,
      and(
        eq(productVariants.productId, products.id),
        eq(productVariants.status, "active"),
      ),
    )
    .leftJoin(productImages, eq(productImages.productId, products.id))
    .where(where)
    .orderBy(orderBy, asc(products.id), asc(productVariants.id), asc(productImages.sortOrder))
    .limit(limit ?? 500)
    .offset(offset ?? 0);

  const productsMap = new Map<number, StorefrontProduct>();
  const variantIds: number[] = [];
  for (const row of rows) {
    let product: StorefrontProduct | undefined = productsMap.get(row.productId);
    if (!product) {
      product = {
        id: row.productId,
        name: row.name,
        description: row.description,
        categoryId: row.categoryId,
        categoryName: row.categoryName,
        brandId: row.brandId,
        brandName: row.brandName,
        hasVariants: row.hasVariants === true,
        images: [],
        variants: [],
      };
      productsMap.set(row.productId, product);
    }
    if (row.variantId && !product.variants.some((v) => v.id === row.variantId)) {
      product.variants.push({
        id: row.variantId,
        sku: row.sku ?? "",
        price: Number(row.price ?? 0),
        isDefault: row.isDefault === true,
        // Filled in with the option labels below, after the batched fetch.
        options: "",
        name: "",
        availability: 0,
      });
      variantIds.push(row.variantId);
    }
    if (row.imageUrl && !product.images.includes(row.imageUrl)) {
      product.images.push(row.imageUrl);
    }
  }

  // Availability per variant, allocation-aware via the reservation engine.
  const locationId = await resolveKeyLocation(ctx.businessId, ctx.integrationId);
  const availability = locationId
    ? await getOnlineAvailability(
        ctx.businessId,
        locationId,
        ctx.integrationId,
        variantIds,
      )
    : new Map<number, number>();

  // Option labels batched per distinct variant — the shopper must be able to
  // tell "Football (Small)" from "Football (Big)".
  let optionsByVariant = new Map<number, string[]>();
  if (variantIds.length > 0) {
    const optRows = await db
      .select({
        variantId: variantValues.variantId,
        value: variantOptions.value,
      })
      .from(variantValues)
      .innerJoin(variantOptions, eq(variantValues.optionId, variantOptions.id))
      .where(inArray(variantValues.variantId, variantIds))
      .orderBy(asc(variantValues.optionId));
    optionsByVariant = foldVariantOptionRows(optRows);
  }
  for (const product of productsMap.values()) {
    for (const variant of product.variants) {
      const rawOptions = optionsByVariant.get(variant.id);
      variant.options = buildVariantOptionsLabel(rawOptions);
      variant.name = buildVariantName(product.name, rawOptions);
    }
  }
  for (const product of productsMap.values()) {
    for (const variant of product.variants) {
      variant.availability = availability.get(variant.id) ?? 0;
    }
  }
  return [...productsMap.values()];
}

export async function listStorefrontProducts(
  ctx: StorefrontContext,
  options: {
    search?: string | undefined;
    categoryId?: number | undefined;
    brandId?: number | undefined;
    sort?: "newest" | "price_asc" | "price_desc" | "name" | undefined;
    page?: number | undefined;
    pageSize?: number | undefined;
    /**
     * Hosted-storefront mode: when set, only products explicitly published
     * to this storefront are returned (opt-in visibility), and website-only
     * SEO overrides do not leak anything beyond public fields.
     */
    storefrontId?: number | undefined;
  } = {},
): Promise<{
  products: StorefrontProduct[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(50, Math.max(1, options.pageSize ?? 20));

  const filters = [
    eq(products.businessId, ctx.businessId),
    eq(products.status, "active"),
  ];
  if (options.storefrontId !== undefined) {
    const visible = await db
      .select({ productId: storefrontProductVisibility.productId })
      .from(storefrontProductVisibility)
      .where(
        and(
          eq(storefrontProductVisibility.storefrontId, options.storefrontId),
          eq(storefrontProductVisibility.published, true),
        ),
      )
      .limit(5000);
    const ids = visible.map((row) => row.productId);
    // Opt-in catalog: an empty allowlist means nothing is published yet.
    filters.push(ids.length > 0 ? inArray(products.id, ids) : sql`false`);
  }
  if (options.search) {
    filters.push(
      or(
        ilike(products.name, `%${options.search}%`),
        ilike(products.description, `%${options.search}%`),
      )!,
    );
  }
  if (options.categoryId) {
    filters.push(eq(products.categoryId, options.categoryId));
  }
  if (options.brandId) {
    filters.push(eq(products.brandId, options.brandId));
  }

  const [productsPage, totalRow] = await Promise.all([
    loadProducts(
      ctx,
      and(...filters),
      options.sort === "name"
        ? asc(products.name)
        : options.sort === "price_asc" || options.sort === "price_desc"
          ? asc(productVariants.sellingPrice)
          : desc(products.id),
      pageSize,
      (page - 1) * pageSize,
    ),
    db
      .select({ n: sql<number>`count(DISTINCT ${products.id})::int` })
      .from(products)
      .where(and(...filters)),
  ]);

  return {
    products: productsPage,
    total: totalRow[0]?.n ?? 0,
    page,
    pageSize,
  };
}

export async function getStorefrontProduct(
  ctx: StorefrontContext,
  productId: number,
  options: { storefrontId?: number | undefined } = {},
): Promise<StorefrontProduct | null> {
  if (options.storefrontId !== undefined) {
    const [visible] = await db
      .select({ id: storefrontProductVisibility.id })
      .from(storefrontProductVisibility)
      .where(
        and(
          eq(storefrontProductVisibility.storefrontId, options.storefrontId),
          eq(storefrontProductVisibility.productId, productId),
          eq(storefrontProductVisibility.published, true),
        ),
      )
      .limit(1);
    // Opt-in catalog: unpublished products are not addressable at all.
    if (!visible) return null;
  }
  const found = await loadProducts(
    ctx,
    and(eq(products.businessId, ctx.businessId), eq(products.id, productId)),
    asc(products.id),
  );
  return found[0] ?? null;
}

export async function listStorefrontCategories(businessId: number) {
  return db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(
      and(eq(categories.businessId, businessId), eq(categories.status, "active")),
    )
    .orderBy(asc(categories.name));
}

export async function listStorefrontBrands(businessId: number) {
  return db
    .select({ id: brands.id, name: brands.name })
    .from(brands)
    .where(and(eq(brands.businessId, businessId), eq(brands.status, "active")))
    .orderBy(asc(brands.name));
}
