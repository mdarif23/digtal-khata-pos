import { sql, type SQL } from "drizzle-orm";

/**
 * Product/variant display conventions shared by every module.
 *
 * A variant has no name column of its own — identity is the parent product's
 * name plus its option values (variant_values → variant_options). These
 * helpers are the single source of truth for turning that into a label:
 *
 *   Water Bottle              (product without options)
 *   Football (Small)          (one option value)
 *   T-Shirt (Red, Large)      (multiple option values)
 */

export interface VariantOptionLike {
  /** Attribute axis name, e.g. "Size". Absent in some API shapes. */
  name?: string | null;
  /** Option value, e.g. "Small". */
  value?: string | null | undefined;
}

/** Either a full option object or just the raw value string. */
export type VariantOptionInput = string | VariantOptionLike;

const OPTION_SEPARATOR = ", ";

function cleanOptionValues(
  options: VariantOptionInput[] | null | undefined,
): string[] {
  if (!Array.isArray(options)) return [];
  const values: string[] = [];
  for (const option of options) {
    const raw = typeof option === "string" ? option : option?.value;
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value && !values.includes(value)) values.push(value);
  }
  return values;
}

/** "Red, Large" — "" when the variant has no usable option values. */
export function buildVariantOptionsLabel(
  options: VariantOptionInput[] | null | undefined,
): string {
  return cleanOptionValues(options).join(OPTION_SEPARATOR);
}

/**
 * "T-Shirt (Red, Large)" or plain "Football" — never "Football ()",
 * "Football (undefined)" or "Football ( , )".
 */
export function buildVariantName(
  productName: string | null | undefined,
  options: VariantOptionInput[] | null | undefined,
): string {
  const name = typeof productName === "string" ? productName.trim() : "";
  const label = buildVariantOptionsLabel(options);
  if (!label) return name;
  return name ? `${name} (${label})` : `(${label})`;
}

/**
 * Same convention as {@link buildVariantName} for an already-joined options
 * label (e.g. a SQL string_agg result): "Red, Large" → "T-Shirt (Red,
 * Large)"; NULL/"" → the bare product name.
 */
export function buildVariantNameFromLabel(
  productName: string | null | undefined,
  optionLabel: string | null | undefined,
): string {
  return buildVariantName(
    productName,
    optionLabel === null || optionLabel === undefined ? null : [optionLabel],
  );
}

// ----------------------------------------------------
// Batched option maps (drizzle select call sites)
// ----------------------------------------------------

/**
 * Folds `variantId, value` rows (from a variant_values ⋈ variant_options
 * select, ordered by option_id) into a per-variant value map. Fetching the
 * rows separately — instead of joining them into the main query — keeps one
 * row per item/variant and avoids fan-out.
 */
export function foldVariantOptionRows(
  rows: { variantId: number; value: string | null }[],
): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const row of rows) {
    const list = map.get(row.variantId) ?? [];
    list.push(row.value ?? "");
    map.set(row.variantId, list);
  }
  return map;
}

/** Options label for one variant out of a folded map. */
export function variantOptionsFromMap(
  map: Map<number, string[]>,
  variantId: number,
): string {
  return buildVariantOptionsLabel(map.get(variantId));
}

/** Full "Product (Options)" label for one variant out of a folded map. */
export function variantNameFromMap(
  map: Map<number, string[]>,
  variantId: number,
  productName: string | null | undefined,
): string {
  return buildVariantName(productName, map.get(variantId));
}

// ----------------------------------------------------
// SQL fragments for raw-SQL report queries
// ----------------------------------------------------

/**
 * LEFT JOIN LATERAL aggregating a variant's option values into a
 * ", "-separated label (column `option_label`), one row per variant.
 * Correlated subquery — safe to combine with grouped/aggregated outer
 * queries because it cannot fan out the join. `variantAlias` is a trusted
 * internal SQL alias (never user input), `resultAlias` names the lateral.
 */
export function variantOptionsJoinSql(
  variantAlias: string,
  resultAlias: string,
): SQL {
  const v = sql.raw(variantAlias);
  const a = sql.raw(resultAlias);
  return sql`LEFT JOIN LATERAL (
    SELECT string_agg(vo.value, ', ' ORDER BY vv.option_id) AS option_label
    FROM variant_values vv
    INNER JOIN variant_options vo ON vo.id = vv.option_id
    WHERE vv.variant_id = ${v}.id
  ) ${a} ON TRUE`;
}

/**
 * "Product (Options)" display expression from a product-name expression and
 * the `option_label` produced by {@link variantOptionsJoinSql}. Renders the
 * bare product name when the label is NULL/empty.
 */
export function variantNameSql(
  productNameExpr: SQL,
  optionLabelExpr: SQL,
): SQL {
  return sql`CONCAT(${productNameExpr}, CASE WHEN ${optionLabelExpr} IS NOT NULL AND BTRIM(${optionLabelExpr}) <> '' THEN CONCAT(' (', ${optionLabelExpr}, ')') ELSE '' END)`;
}
