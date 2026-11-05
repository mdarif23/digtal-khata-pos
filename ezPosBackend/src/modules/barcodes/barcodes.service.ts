import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import {
  productVariants,
} from "../../db/schema/productVariants.js";
import { variantBarcodeAliases } from "../../db/schema/variantBarcodeAliases.js";
import { products } from "../../db/schema/products.js";
import { auditLog } from "../../db/schema/auditLog.js";
import { recordAudit, recordAuditInTx } from "../../services/audit.js";
import { nextDocumentNumber } from "../../utils/documentSequence.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/handleError.js";
import {
  formatInternalBarcode,
  validateBarcode,
  type BarcodeFormat,
} from "./barcodes.validation.js";

type Tx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Barcode assignment / generation / lookup service.
 *
 * Invariants:
 * - The PRIMARY barcode lives on product_variants.barcode (never migrated
 *   into the alias table) — every existing scan/query keeps reading it.
 * - A code resolves to exactly ONE variant per business: aliases and
 *   primaries are cross-checked against BOTH tables on every write, so
 *   lookup never has to guess.
 * - Internal generation uses document_sequences (same rollback-safe,
 *   race-free allocation as SKUs) and always yields CODE128 `EZ…` codes —
 *   never EAN/UPC-shaped, so no fake GS1 identifiers can be minted.
 * - Existing barcodes are never replaced silently: primary replacement
 *   requires the caller's explicit `replace` confirmation and archives the
 *   old value in the audit log.
 */

export interface BarcodeVariantView {
  variantId: number;
  productId: number;
  productName: string;
  variantLabel: string | null;
  sku: string;
  barcode: string | null;
  barcodeFormat: string | null;
  sellingPrice: number;
  hasVariants: boolean;
  options: { type: string; value: string }[] | null;
  aliases: { id: number; barcode: string; barcodeFormat: string | null; source: string }[];
}

/**
 * Variant display label: the option combination (Small / Medium / Big…)
 * for EVERY variant of a variant-ed product — including the default one,
 * which carries a real option value, not an unlabeled row. Products
 * without variants have a single implicit variant and get no label.
 */
const variantLabel = sql<string | null>`CASE
  WHEN ${products.hasVariants} THEN COALESCE((
    SELECT string_agg(vo.value, ' / ' ORDER BY vv.option_id)
    FROM variant_values vv
    JOIN variant_options vo ON vo.id = vv.option_id
    WHERE vv.variant_id = ${productVariants.id}
  ), ${productVariants.sku})
  ELSE NULL
END`;

async function loadAliasesForVariants(
  businessId: number,
  variantIds: number[],
): Promise<Map<number, BarcodeVariantView["aliases"]>> {
  if (variantIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: variantBarcodeAliases.id,
      variantId: variantBarcodeAliases.variantId,
      barcode: variantBarcodeAliases.barcode,
      barcodeFormat: variantBarcodeAliases.barcodeFormat,
      source: variantBarcodeAliases.source,
    })
    .from(variantBarcodeAliases)
    .where(
      and(
        eq(variantBarcodeAliases.businessId, businessId),
        inArray(variantBarcodeAliases.variantId, variantIds),
      ),
    )
    .orderBy(desc(variantBarcodeAliases.id));
  const map = new Map<number, BarcodeVariantView["aliases"]>();
  for (const row of rows) {
    const list = map.get(row.variantId) ?? [];
    list.push({
      id: row.id,
      barcode: row.barcode,
      barcodeFormat: row.barcodeFormat,
      source: row.source,
    });
    map.set(row.variantId, list);
  }
  return map;
}

async function toVariantViews(
  businessId: number,
  rows: {
    variantId: number;
    productId: number;
    productName: string;
    variantLabel: string | null;
    sku: string;
    barcode: string | null;
    barcodeFormat: string | null;
    sellingPrice: string | number;
    hasVariants: boolean | null;
  }[],
): Promise<BarcodeVariantView[]> {
  const aliasMap = await loadAliasesForVariants(
    businessId,
    rows.map((row) => row.variantId),
  );
  return rows.map((row) => ({
    variantId: row.variantId,
    productId: row.productId,
    productName: row.productName,
    variantLabel: row.variantLabel,
    sku: row.sku,
    barcode: row.barcode,
    barcodeFormat: row.barcodeFormat,
    sellingPrice: Number(row.sellingPrice),
    hasVariants: row.hasVariants === true,
    options: null,
    aliases: aliasMap.get(row.variantId) ?? [],
  }));
}

export interface SearchFilters {
  search?: string | undefined;
  categoryId?: number | undefined;
  brandId?: number | undefined;
  page: number;
  pageSize: number;
}

/** Paged variant catalog for the generator page (products.view scope). */
export async function searchVariantsForBarcodes(
  businessId: number,
  filters: SearchFilters,
): Promise<{
  rows: BarcodeVariantView[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const pageSize = Math.min(Math.max(filters.pageSize, 1), 100);
  const page = Math.max(filters.page, 1);
  const search = filters.search?.trim();

  const conditions = [
    eq(products.businessId, businessId),
    sql`(${products.status} <> 'deleted' OR ${products.status} IS NULL)`,
  ];
  if (search) {
    conditions.push(
      or(
        ilike(products.name, `%${search}%`),
        ilike(productVariants.sku, `%${search}%`),
        ilike(productVariants.barcode, `%${search}%`),
      )!,
    );
  }
  if (filters.categoryId !== undefined) {
    conditions.push(eq(products.categoryId, filters.categoryId));
  }
  if (filters.brandId !== undefined) {
    conditions.push(eq(products.brandId, filters.brandId));
  }
  const where = and(...conditions);

  const rows = await db
    .select({
      variantId: productVariants.id,
      productId: products.id,
      productName: products.name,
      variantLabel,
      sku: productVariants.sku,
      barcode: productVariants.barcode,
      barcodeFormat: productVariants.barcodeFormat,
      sellingPrice: productVariants.sellingPrice,
      hasVariants: products.hasVariants,
    })
    .from(productVariants)
    .innerJoin(products, and(eq(products.id, productVariants.productId), eq(products.businessId, productVariants.businessId)))
    .where(where)
    .orderBy(asc(products.name), asc(productVariants.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const [countRow] = await db
    .select({ total: sql<string>`COUNT(*)` })
    .from(productVariants)
    .innerJoin(products, and(eq(products.id, productVariants.productId), eq(products.businessId, productVariants.businessId)))
    .where(where);

  return {
    rows: await toVariantViews(businessId, rows),
    total: Number(countRow?.total ?? 0),
    page,
    pageSize,
  };
}

/**
 * Assigns a barcode: either the variant's PRIMARY (variants.barcode) or an
 * additional alias. `replace: true` is required to overwrite an existing
 * primary — the old code is archived into the audit log first.
 */
export async function assignBarcode(
  businessId: number,
  userId: number | null,
  input: {
    variantId: number;
    barcode: string;
    format?: BarcodeFormat | undefined;
    target: "primary" | "alias";
    replace?: boolean | undefined;
    source?: "external" | "internal" | undefined;
  },
): Promise<BarcodeVariantView> {
  const normalizedInput = input.barcode.trim();
  const validation = validateBarcode(normalizedInput, input.format);
  if (!validation.valid || !validation.normalized || !validation.format) {
    throw new BadRequestError(validation.error ?? "Invalid barcode.");
  }
  const code = validation.normalized;

  const result = await db.transaction(async (tx) => {
    const [variant] = await tx
      .select({
        id: productVariants.id,
        barcode: productVariants.barcode,
        barcodeFormat: productVariants.barcodeFormat,
        productId: productVariants.productId,
        sku: productVariants.sku,
      })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.id, input.variantId),
          eq(productVariants.businessId, businessId),
        ),
      )
      .for("update");
    if (!variant) {
      throw new NotFoundError("Variant not found.");
    }

    // Cross-table uniqueness: the code must not exist on ANY primary or
    // alias in this business (unless it already belongs to THIS variant).
    const [primaryOwner] = await tx
      .select({ id: productVariants.id, sku: productVariants.sku })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.businessId, businessId),
          eq(productVariants.barcode, code),
        ),
      );
    if (primaryOwner && primaryOwner.id !== variant.id) {
      throw new ConflictError(
        `Barcode ${code} is already the primary barcode of variant ${primaryOwner.sku}.`,
      );
    }
    const [aliasOwner] = await tx
      .select({
        id: variantBarcodeAliases.id,
        variantId: variantBarcodeAliases.variantId,
      })
      .from(variantBarcodeAliases)
      .where(
        and(
          eq(variantBarcodeAliases.businessId, businessId),
          eq(variantBarcodeAliases.barcode, code),
        ),
      );
    if (aliasOwner) {
      if (input.target === "alias" && aliasOwner.variantId === variant.id) {
        throw new ConflictError("This variant already has that alias barcode.");
      }
      throw new ConflictError(
        `Barcode ${code} is already registered as an alias of another variant in this business.`,
      );
    }

    if (input.target === "primary") {
      if (variant.barcode !== null && variant.barcode !== code && input.replace !== true) {
        throw new ConflictError(
          `This variant already has the primary barcode ${variant.barcode}. Replacing it requires explicit confirmation.`,
        );
      }
      if (variant.barcode !== null && variant.barcode !== code) {
        await recordAuditInTx(tx, {
          businessId,
          actorUserId: userId,
          action: "barcode.changed",
          entityType: "variant",
          entityId: variant.id,
          metadata: {
            oldBarcode: variant.barcode,
            oldFormat: variant.barcodeFormat,
            newBarcode: code,
            newFormat: validation.format,
          },
        });
      } else {
        await recordAuditInTx(tx, {
          businessId,
          actorUserId: userId,
          action: "barcode.assigned",
          entityType: "variant",
          entityId: variant.id,
          metadata: { barcode: code, format: validation.format, target: "primary" },
        });
      }
      await tx
        .update(productVariants)
        .set({ barcode: code, barcodeFormat: validation.format })
        .where(eq(productVariants.id, variant.id));
    } else {
      await tx.insert(variantBarcodeAliases).values({
        businessId,
        variantId: variant.id,
        barcode: code,
        barcodeFormat: validation.format,
        source: input.source ?? "external",
        createdBy: userId,
      });
      await recordAuditInTx(tx, {
        businessId,
        actorUserId: userId,
        action: "barcode.alias_added",
        entityType: "variant",
        entityId: variant.id,
        metadata: { barcode: code, format: validation.format },
      });
    }
    return variant.id;
  });

  return getVariantBarcodes(businessId, result);
}

/**
 * Bulk generation of internal codes for the selected variants.
 * - Variant without a primary → gets a new internal CODE128 as primary.
 * - Variant WITH a primary and `regenerate !== true` → the new code is
 *   added as an ALIAS (nothing is replaced silently).
 * - `regenerate: true` → the existing primary is archived to the audit log
 *   and replaced (explicit confirmation flow).
 */
export async function generateBarcodes(
  businessId: number,
  userId: number | null,
  input: { variantIds: number[]; regenerate?: boolean | undefined },
): Promise<{ generated: { variantId: number; barcode: string; target: "primary" | "alias" }[] }> {
  if (input.variantIds.length === 0) {
    throw new BadRequestError("Select at least one variant.");
  }
  if (input.variantIds.length > 500) {
    throw new BadRequestError("Generate in batches of at most 500 variants.");
  }

  const generated: { variantId: number; barcode: string; target: "primary" | "alias" }[] = [];
  await db.transaction(async (tx) => {
    // Row-lock the selected variants in a stable order to avoid deadlocks.
    const variants = await tx
      .select({
        id: productVariants.id,
        barcode: productVariants.barcode,
        barcodeFormat: productVariants.barcodeFormat,
      })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.businessId, businessId),
          inArray(productVariants.id, input.variantIds),
        ),
      )
      .orderBy(productVariants.id)
      .for("update");
    if (variants.length !== input.variantIds.length) {
      throw new NotFoundError("One or more selected variants do not exist.");
    }

    for (const variant of variants) {
      const sequence = await nextDocumentNumber(tx, businessId, "internal_barcode");
      const code = formatInternalBarcode(sequence);
      const validation = validateBarcode(code, "code128");
      if (!validation.valid || !validation.normalized) {
        throw new Error("Generated internal barcode failed validation.");
      }

      if (variant.barcode === null || (input.regenerate === true && variant.barcode !== code)) {
        if (variant.barcode !== null) {
          await recordAuditInTx(tx, {
            businessId,
            actorUserId: userId,
            action: "barcode.regenerated",
            entityType: "variant",
            entityId: variant.id,
            metadata: {
              oldBarcode: variant.barcode,
              oldFormat: variant.barcodeFormat,
              newBarcode: code,
            },
          });
        } else {
          await recordAuditInTx(tx, {
            businessId,
            actorUserId: userId,
            action: "barcode.assigned",
            entityType: "variant",
            entityId: variant.id,
            metadata: { barcode: code, format: "code128", target: "primary", generated: true },
          });
        }
        await tx
          .update(productVariants)
          .set({ barcode: code, barcodeFormat: "code128" })
          .where(eq(productVariants.id, variant.id));
        generated.push({ variantId: variant.id, barcode: code, target: "primary" });
      } else {
        // Keep the existing primary untouched — the new code becomes an alias.
        await tx.insert(variantBarcodeAliases).values({
          businessId,
          variantId: variant.id,
          barcode: code,
          barcodeFormat: "code128",
          source: "internal",
          createdBy: userId,
        });
        await recordAuditInTx(tx, {
          businessId,
          actorUserId: userId,
          action: "barcode.alias_added",
          entityType: "variant",
          entityId: variant.id,
          metadata: { barcode: code, format: "code128", source: "internal" },
        });
        generated.push({ variantId: variant.id, barcode: code, target: "alias" });
      }
    }
  });

  return { generated };
}

/** One variant with its primary + aliases (generator page detail). */
export async function getVariantBarcodes(
  businessId: number,
  variantId: number,
): Promise<BarcodeVariantView> {
  const [row] = await db
    .select({
      variantId: productVariants.id,
      productId: products.id,
      productName: products.name,
      variantLabel,
      sku: productVariants.sku,
      barcode: productVariants.barcode,
      barcodeFormat: productVariants.barcodeFormat,
      sellingPrice: productVariants.sellingPrice,
      hasVariants: products.hasVariants,
    })
    .from(productVariants)
    .innerJoin(products, and(eq(products.id, productVariants.productId), eq(products.businessId, productVariants.businessId)))
    .where(
      and(
        eq(productVariants.id, variantId),
        eq(productVariants.businessId, businessId),
      ),
    );
  if (!row) {
    throw new NotFoundError("Variant not found.");
  }
  const [view] = await toVariantViews(businessId, [row]);
  return view!;
}

export async function deleteAlias(
  businessId: number,
  userId: number | null,
  aliasId: number,
): Promise<{ id: number }> {
  return db.transaction(async (tx) => {
    const [alias] = await tx
      .select({
        id: variantBarcodeAliases.id,
        barcode: variantBarcodeAliases.barcode,
        variantId: variantBarcodeAliases.variantId,
      })
      .from(variantBarcodeAliases)
      .where(
        and(
          eq(variantBarcodeAliases.id, aliasId),
          eq(variantBarcodeAliases.businessId, businessId),
        ),
      );
    if (!alias) {
      throw new NotFoundError("Alias not found.");
    }
    await tx
      .delete(variantBarcodeAliases)
      .where(eq(variantBarcodeAliases.id, aliasId));
    await recordAuditInTx(tx, {
      businessId,
      actorUserId: userId,
      action: "barcode.alias_removed",
      entityType: "variant",
      entityId: alias.variantId,
      metadata: { aliasId, barcode: alias.barcode },
    });
    return { id: alias.id };
  });
}

/** Updates an alias's code/format with full validation + conflict checks. */
export async function updateAlias(
  businessId: number,
  userId: number | null,
  aliasId: number,
  input: { barcode: string; format?: BarcodeFormat | undefined },
): Promise<BarcodeVariantView> {
  const validation = validateBarcode(input.barcode, input.format);
  if (!validation.valid || !validation.normalized || !validation.format) {
    throw new BadRequestError(validation.error ?? "Invalid barcode.");
  }
  const code = validation.normalized;
  const variantId = await db.transaction(async (tx) => {
    const [alias] = await tx
      .select({
        id: variantBarcodeAliases.id,
        variantId: variantBarcodeAliases.variantId,
        barcode: variantBarcodeAliases.barcode,
      })
      .from(variantBarcodeAliases)
      .where(
        and(
          eq(variantBarcodeAliases.id, aliasId),
          eq(variantBarcodeAliases.businessId, businessId),
        ),
      )
      .for("update");
    if (!alias) {
      throw new NotFoundError("Alias not found.");
    }
    if (alias.barcode === code) {
      return alias.variantId;
    }
    // Cross-table uniqueness for the new code.
    const [primaryOwner] = await tx
      .select({ id: productVariants.id, sku: productVariants.sku })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.businessId, businessId),
          eq(productVariants.barcode, code),
        ),
      );
    if (primaryOwner) {
      throw new ConflictError(
        `Barcode ${code} is already the primary barcode of variant ${primaryOwner.sku}.`,
      );
    }
    const [aliasOwner] = await tx
      .select({ id: variantBarcodeAliases.id })
      .from(variantBarcodeAliases)
      .where(
        and(
          eq(variantBarcodeAliases.businessId, businessId),
          eq(variantBarcodeAliases.barcode, code),
        ),
      );
    if (aliasOwner) {
      throw new ConflictError(
        `Barcode ${code} is already registered as an alias in this business.`,
      );
    }
    await tx
      .update(variantBarcodeAliases)
      .set({ barcode: code, barcodeFormat: validation.format })
      .where(eq(variantBarcodeAliases.id, aliasId));
    await recordAuditInTx(tx, {
      businessId,
      actorUserId: userId,
      action: "barcode.alias_changed",
      entityType: "variant",
      entityId: alias.variantId,
      metadata: { aliasId, oldBarcode: alias.barcode, newBarcode: code, format: validation.format },
    });
    return alias.variantId;
  });
  return getVariantBarcodes(businessId, variantId);
}

export type LookupResult =
  | {
      matchType: "primary" | "alias";
      variantId: number;
      productId: number;
      productName: string;
      variantLabel: string | null;
      sku: string;
      barcode: string;
      barcodeFormat: string | null;
      sellingPrice: number;
      hasVariants: boolean;
    }
  | { matchType: "not_found" }
  | { matchType: "ambiguous"; detail: string };

/**
 * Exact scanner resolution: primary barcode → alias → SKU. Every path is
 * an exact match scoped to the business; ambiguous never picks one.
 */
export async function lookupBarcode(
  businessId: number,
  code: string,
): Promise<LookupResult> {
  const trimmed = code.trim();
  if (trimmed === "") {
    return { matchType: "not_found" };
  }

  const [primary] = await db
    .select({
      variantId: productVariants.id,
      productId: products.id,
      productName: products.name,
      variantLabel,
      sku: productVariants.sku,
      barcode: productVariants.barcode,
      barcodeFormat: productVariants.barcodeFormat,
      sellingPrice: productVariants.sellingPrice,
      hasVariants: products.hasVariants,
    })
    .from(productVariants)
    .innerJoin(products, and(eq(products.id, productVariants.productId), eq(products.businessId, productVariants.businessId)))
    .where(
      and(
        eq(productVariants.businessId, businessId),
        eq(productVariants.barcode, trimmed),
      ),
    )
    .limit(2);
  if (primary) {
    return {
      matchType: "primary",
      variantId: primary.variantId,
      productId: primary.productId,
      productName: primary.productName,
      variantLabel: primary.variantLabel,
      sku: primary.sku,
      barcode: primary.barcode!,
      barcodeFormat: primary.barcodeFormat,
      sellingPrice: Number(primary.sellingPrice),
      hasVariants: primary.hasVariants === true,
    };
  }

  const aliasRows = await db
    .select({
      aliasId: variantBarcodeAliases.id,
      variantId: productVariants.id,
      productId: products.id,
      productName: products.name,
      variantLabel,
      sku: productVariants.sku,
      barcode: variantBarcodeAliases.barcode,
      barcodeFormat: variantBarcodeAliases.barcodeFormat,
      sellingPrice: productVariants.sellingPrice,
      hasVariants: products.hasVariants,
    })
    .from(variantBarcodeAliases)
    .innerJoin(
      productVariants,
      and(
        eq(productVariants.id, variantBarcodeAliases.variantId),
        eq(productVariants.businessId, variantBarcodeAliases.businessId),
      ),
    )
    .innerJoin(products, and(eq(products.id, productVariants.productId), eq(products.businessId, productVariants.businessId)))
    .where(
      and(
        eq(variantBarcodeAliases.businessId, businessId),
        eq(variantBarcodeAliases.barcode, trimmed),
      ),
    )
    .limit(2);
  if (aliasRows.length === 1) {
    const alias = aliasRows[0]!;
    return {
      matchType: "alias",
      variantId: alias.variantId,
      productId: alias.productId,
      productName: alias.productName,
      variantLabel: alias.variantLabel,
      sku: alias.sku,
      barcode: alias.barcode,
      barcodeFormat: alias.barcodeFormat,
      sellingPrice: Number(alias.sellingPrice),
      hasVariants: alias.hasVariants === true,
    };
  }
  if (aliasRows.length > 1) {
    return {
      matchType: "ambiguous",
      detail: `Barcode ${trimmed} is registered as an alias more than once — data invariant violated; investigate variant_barcode_aliases.`,
    };
  }

  // SKU exact fallback (scanners are often pointed at shelf labels carrying
  // the SKU too). Unique per business, so at most one match.
  const [skuMatch] = await db
    .select({
      variantId: productVariants.id,
      productId: products.id,
      productName: products.name,
      variantLabel,
      sku: productVariants.sku,
      barcode: productVariants.barcode,
      barcodeFormat: productVariants.barcodeFormat,
      sellingPrice: productVariants.sellingPrice,
      hasVariants: products.hasVariants,
    })
    .from(productVariants)
    .innerJoin(products, and(eq(products.id, productVariants.productId), eq(products.businessId, productVariants.businessId)))
    .where(
      and(
        eq(productVariants.businessId, businessId),
        eq(productVariants.sku, trimmed),
      ),
    )
    .limit(2);
  if (skuMatch) {
    return {
      matchType: "primary",
      variantId: skuMatch.variantId,
      productId: skuMatch.productId,
      productName: skuMatch.productName,
      variantLabel: skuMatch.variantLabel,
      sku: skuMatch.sku,
      barcode: skuMatch.barcode ?? skuMatch.sku,
      barcodeFormat: skuMatch.barcodeFormat,
      sellingPrice: Number(skuMatch.sellingPrice),
      hasVariants: skuMatch.hasVariants === true,
    };
  }

  return { matchType: "not_found" };
}

/** Format + check-digit + in-business conflict check (live UI feedback). */
export async function validateOnly(
  businessId: number,
  input: { barcode: string; format?: BarcodeFormat | undefined },
  existing: { variantId?: number | undefined; aliasId?: number | undefined } = {},
): Promise<{
  valid: boolean;
  format?: BarcodeFormat | undefined;
  error?: string | undefined;
  conflictWith?: string | undefined;
}> {
  const validation = validateBarcode(input.barcode, input.format);
  if (!validation.valid || !validation.normalized || !validation.format) {
    return { valid: false, error: validation.error };
  }
  const code = validation.normalized;
  const [primaryOwner] = await db
    .select({ id: productVariants.id, sku: productVariants.sku })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.businessId, businessId),
        eq(productVariants.barcode, code),
      ),
    );
  if (primaryOwner && primaryOwner.id !== existing.variantId) {
    return {
      valid: false,
      format: validation.format,
      conflictWith: `primary barcode of ${primaryOwner.sku}`,
    };
  }
  const [aliasOwner] = await db
    .select({ id: variantBarcodeAliases.id })
    .from(variantBarcodeAliases)
    .where(
      and(
        eq(variantBarcodeAliases.businessId, businessId),
        eq(variantBarcodeAliases.barcode, code),
      ),
    );
  if (aliasOwner && aliasOwner.id !== existing.aliasId) {
    return {
      valid: false,
      format: validation.format,
      conflictWith: "another variant's alias barcode",
    };
  }
  return { valid: true, format: validation.format };
}

/** Recently printed label jobs (audit-backed). */
export async function getPrintHistory(
  businessId: number,
  limit = 50,
): Promise<
  { id: number; userId: number | null; variantCount: number; copies: number; template: string | null; createdAt: Date | null }[]
> {
  const rows = await db
    .select({
      id: auditLog.id,
      actorUserId: auditLog.actorUserId,
      metadata: auditLog.metadata,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.businessId, businessId),
        eq(auditLog.action, "barcode.labels_printed"),
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map((row) => {
    const metadata = (row.metadata ?? {}) as {
      variantCount?: number;
      copies?: number;
      template?: string;
    };
    return {
      id: row.id,
      userId: row.actorUserId,
      variantCount: Number(metadata.variantCount ?? 0),
      copies: Number(metadata.copies ?? 1),
      template: metadata.template ?? null,
      createdAt: row.createdAt,
    };
  });
}

export async function logPrintJob(
  businessId: number,
  userId: number | null,
  input: { variantCount: number; copies: number; template?: string | undefined },
): Promise<void> {
  recordAudit({
    businessId,
    actorUserId: userId,
    action: "barcode.labels_printed",
    entityType: "variant_barcode",
    entityId: null,
    metadata: {
      variantCount: input.variantCount,
      copies: input.copies,
      template: input.template ?? null,
    },
  });
}
