/**
 * Client-side mirror of the backend's barcode validation
 * (ezPosBackend/src/modules/barcodes/barcodes.validation.ts).
 *
 * RULES must never diverge — the backend is authoritative; this copy
 * exists only for instant UX feedback (the server re-validates every
 * mutation). Keep the two files in sync when changing rules.
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

export const FORMAT_LABELS: Record<BarcodeFormat, string> = {
  code128: "CODE128 (internal / free-form)",
  ean13: "EAN-13 (retail, 13 digits)",
  ean8: "EAN-8 (retail, 8 digits)",
  upca: "UPC-A (retail, 12 digits)",
  code39: "CODE39 (warehouse, A–Z 0–9 -.$/+%)",
  qr: "QR code (2D)",
};

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
  let sum = 0;
  for (let i = 0; i < digitsWithoutCheck.length; i += 1) {
    const digit = Number(digitsWithoutCheck[digitsWithoutCheck.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

export function gtinCheckDigitIsValid(fullCode: string): boolean {
  if (!/^\d+$/.test(fullCode) || fullCode.length < 2) return false;
  const payload = fullCode.slice(0, -1);
  const supplied = Number(fullCode[fullCode.length - 1]);
  const expected = gtinCheckDigit(payload);
  return expected !== null && expected === supplied;
}

export function isBarcodeFormat(value: unknown): value is BarcodeFormat {
  return (
    typeof value === "string" &&
    (BARCODE_FORMATS as readonly string[]).includes(value)
  );
}

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
  format?: BarcodeFormat;
  normalized?: string;
  error?: string;
}

/** Same rules as the backend's validateBarcode. */
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
        error: `Invalid ${gtinFormat.toUpperCase()} check digit — the printed symbol would not scan back to this code.`,
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
