/**
 * Embedded price/weight barcode parsing (Phase 4 — master prompt Feature
 * 10-B). Common retail format: PREFIX + PLU (item code) + VALUE (weight or
 * price) + optional check digit. Configuration travels per business
 * (pos_settings.embedded_barcode); the scanner resolves PLU codes through
 * the normal catalog lookup.
 */

export interface EmbeddedBarcodeConfig {
  /** Barcode prefixes that mark an embedded value (e.g. ["20", "21"]). */
  prefixes: string[];
  /** Length of the item/PLU segment, digits. */
  pluLength: number;
  /** Length of the value segment, digits. */
  valueLength: number;
  /** Decimal places implied in the value segment (3 → 0500 = 0.500 kg). */
  decimals: number;
  /** What the value segment carries. */
  mode: "weight" | "price";
  /** Whether a trailing check digit occupies one more position. */
  hasCheckDigit: boolean;
}

export const DEFAULT_EMBEDDED_CONFIG: EmbeddedBarcodeConfig = {
  prefixes: ["20", "21"],
  pluLength: 5,
  valueLength: 5,
  decimals: 3,
  mode: "weight",
  hasCheckDigit: true,
};

export interface EmbeddedBarcodeParse {
  pluCode: string;
  /** Full barcode the catalog may store (prefix + PLU). */
  lookupBarcode: string;
  value: number;
}

/**
 * Parses an embedded-value barcode. Returns null when the barcode doesn't
 * match the configured shape (caller falls back to normal lookup) — never
 * throws: a scanner feeds everything it reads through here.
 */
export function parseEmbeddedBarcode(
  barcode: string,
  config: EmbeddedBarcodeConfig = DEFAULT_EMBEDDED_CONFIG,
): EmbeddedBarcodeParse | null {
  const cleaned = barcode.trim();
  const prefix = config.prefixes.find((p) => cleaned.startsWith(p));
  if (!prefix) return null;

  const body = cleaned.slice(prefix.length);
  const valueEnd = config.valueLength + (config.hasCheckDigit ? 1 : 0);
  if (body.length < config.pluLength + config.valueLength) return null;
  // With a check digit the PLU comes first, then the value, then the digit.
  const plu = body.slice(0, config.pluLength);
  const valueSegment = body.slice(config.pluLength, config.pluLength + config.valueLength);
  if (!/^\d+$/.test(plu) || !/^\d+$/.test(valueSegment)) return null;
  void valueEnd;

  const rawValue = Number(valueSegment) / Math.pow(10, config.decimals);
  if (!Number.isFinite(rawValue) || rawValue <= 0) return null;

  return {
    pluCode: plu,
    // The catalog stores the prefix + PLU as the variant barcode (the
    // value suffix varies per weigh-in, so it can't be the stored key).
    lookupBarcode: `${prefix}${plu}`,
    value: rawValue,
  };
}

/** Canonical mod-10 check digit validation (GS1 style) when enabled. */
export function validateCheckDigit(barcode: string): boolean {
  const digits = barcode.trim().replace(/\D/g, "");
  if (digits.length < 2) return false;
  const body = digits.slice(0, -1);
  const check = Number(digits.slice(-1));
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10 === check;
}
