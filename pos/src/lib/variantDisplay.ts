/**
 * Product/variant display convention shared across the app (mirrors the
 * backend's `ezPosBackend/src/utils/variantDisplay.ts`):
 *
 *   Water Bottle              (product without options)
 *   Football (Small)          (one option value)
 *   T-Shirt (Red, Large)      (multiple option values)
 *
 * Never renders "Football ()", "Football (undefined)" or "Football ( , )".
 */

export interface VariantOptionLike {
  /** Attribute axis name, e.g. "Size". Absent in some API shapes. */
  typeName?: string | null;
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
 * "T-Shirt (Red, Large)" or plain "Football". Accepts either option objects
 * or an already-joined label (e.g. a backend `variantOptions` string, which
 * travels as one value and passes through untouched).
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
