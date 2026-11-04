/**
 * Barcode format detection, validation and normalization.
 *
 * Server-authoritative validation (the DB must never store a GTIN whose
 * printed symbol would fail to scan back to it). Pure functions — mirrored
 * client-side for instant UX; the client copy must never diverge on RULES,
 * only on UX timing.
 *
 * GTIN rules (GS1): EAN-8 = 8 digits, UPC-A = 12, EAN-13 = 13. UPC-A is
 * EAN-13 with a leading 0 — the check digit is identical either way.
 * CODE128/CODE39 carry no mandatory check digit; CODE39's mod-43 is
 * optional and not enforced.
 */

export const BARCODE_FORMATS = [
  "code128",
  "ean13",
  "ean8",
  "upca",
  "code39",
  "qr",
] as const;

export type BarcodeFormat = (typeof BARCODE_FORMATS)[number];

export function isBarcodeFormat(value: unknown): value is BarcodeFormat {
  return (
    typeof value === "string" &&
    (BARCODE_FORMATS as readonly string[]).includes(value)
  );
}

const GTIN_LENGTHS: Record<string, number> = {
  ean8: 8,
  upca: 12,
  ean13: 13,
};

const CODE39_CHARSET = /^[0-9A-Z\-. $/+%]+$/;
const CODE128_CHARSET = /^[\x20-\x7e]+$/;

/** GS1 mod-10 check digit for a GTIN payload (digits without the check digit). */
export function gtinCheckDigit(digitsWithoutCheck: string): number | null {
  if (!/^\d+$/.test(digitsWithoutCheck) || digitsWithoutCheck.length === 0) {
    return null;
  }
  // From the rightmost digit, weights alternate 3,1,3,1…
  let sum = 0;
  for (let i = 0; i < digitsWithoutCheck.length; i += 1) {
    const digit = Number(digitsWithoutCheck[digitsWithoutCheck.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** Does a full GTIN (payload + check digit) carry a valid check digit? */
export function gtinCheckDigitIsValid(fullCode: string): boolean {
  if (!/^\d+$/.test(fullCode) || fullCode.length < 2) return false;
  const payload = fullCode.slice(0, -1);
  const supplied = Number(fullCode[fullCode.length - 1]);
  const expected = gtinCheckDigit(payload);
  return expected !== null && expected === supplied;
}

/**
 * Detects the format of an unclassified code. Digits-only codes of GTIN
 * length that pass their check digit are EAN-8/UPC-A/EAN-13 (a GTIN-shaped
 * code that FAILS its check digit is never re-labeled CODE39 — it stays
 * undetected so the caller can report the check-digit problem). Anything
 * else printable is CODE39/CODE128.
 */
export function detectBarcodeFormat(code: string): BarcodeFormat | null {
  const trimmed = code.trim();
  if (/^\d{8}$/.test(trimmed) && gtinCheckDigitIsValid(trimmed)) return "ean8";
  if (/^\d{12}$/.test(trimmed) && gtinCheckDigitIsValid(trimmed)) return "upca";
  if (/^\d{13}$/.test(trimmed) && gtinCheckDigitIsValid(trimmed)) return "ean13";
  if (CODE39_CHARSET.test(trimmed)) return "code39";
  if (CODE128_CHARSET.test(trimmed) && trimmed.length > 0) return "code128";
  return null;
}

export interface BarcodeValidationResult {
  valid: boolean;
  /** The format the code was validated as (after detection/normalization). */
  format?: BarcodeFormat;
  /** Normalized storage form (UPC-A input is preserved as entered). */
  normalized?: string;
  error?: string;
}

/** Validates a code against an explicit format, or auto-detects. */
export function validateBarcode(
  rawCode: string,
  explicitFormat?: BarcodeFormat,
): BarcodeValidationResult {
  const code = rawCode.trim();
  if (code === "") return { valid: false, error: "Barcode is empty." };
  if (code.length > 100) {
    return { valid: false, error: "Barcode exceeds 100 characters." };
  }
  if (/[\x00-\x1f\x7f]/.test(code)) {
    return { valid: false, error: "Barcode contains control characters." };
  }

  // GTIN-shaped digit strings are validated as their GTIN format even
  // without an explicit format — so a bad check digit gets a precise
  // error instead of a generic "unrecognized format".
  const gtinFormat =
    explicitFormat && explicitFormat in GTIN_LENGTHS
      ? explicitFormat
      : (Object.entries(GTIN_LENGTHS).find(
          ([, length]) => /^\d+$/.test(code) && code.length === length,
        )?.[0] as BarcodeFormat | undefined);
  if (gtinFormat) {
    const expectedLength = GTIN_LENGTHS[gtinFormat];
    if (code.length !== expectedLength) {
      return {
        valid: false,
        format: gtinFormat,
        error: `${gtinFormat.toUpperCase()} must be exactly ${expectedLength} digits (got ${code.length}).`,
      };
    }
    if (!gtinCheckDigitIsValid(code)) {
      return {
        valid: false,
        format: gtinFormat,
        error: `Invalid ${gtinFormat.toUpperCase()} check digit — the printed symbol would not scan back to this code. Verify the number with your GS1 provider.`,
      };
    }
    return { valid: true, format: gtinFormat, normalized: code };
  }

  const format = explicitFormat ?? detectBarcodeFormat(code);
  if (!format) {
    return {
      valid: false,
      error:
        "Unrecognized barcode format. Use EAN-13/EAN-8/UPC-A for retail digits, or CODE128/CODE39 for internal codes.",
    };
  }

  if (format === "code39" && !CODE39_CHARSET.test(code)) {
    return {
      valid: false,
      format,
      error: "CODE39 supports A–Z, 0–9, space and - . $ / + % only.",
    };
  }
  if ((format === "code128" || format === "qr") && !CODE128_CHARSET.test(code)) {
    return { valid: false, format, error: "CODE128/QR supports printable ASCII only." };
  }
  return { valid: true, format, normalized: code };
}

/**
 * The internal barcode scheme: CODE128 `EZ` + 12-digit per-business
 * sequence. NEVER EAN/UPC — minting GTIN-looking codes would collide with
 * GS1-allocated identifiers the business does not own.
 */
export function formatInternalBarcode(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 999_999_999_999) {
    throw new Error("Internal barcode sequence out of range.");
  }
  return `EZ${String(sequence).padStart(12, "0")}`;
}
