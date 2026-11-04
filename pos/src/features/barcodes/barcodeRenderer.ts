import JsBarcode from "jsbarcode";
import QRCode from "qrcode";
import type { BarcodeFormat } from "./barcodeFormats.js";

/**
 * Barcode SVG rendering — kept strictly separate from business logic
 * (master prompt §9). Everything renders to an SVG STRING so the same
 * artifact feeds the live preview, the browser-print sheet, and the
 * jsPDF (vector via svg2pdf) pipeline — no raster stretching, ever.
 *
 * Aspect ratios are sacred: JsBarcode computes the bar geometry from the
 * content; we never scale the symbol non-uniformly. Quiet zones come from
 * the `margin` option (in module widths, GS1-consistent).
 */

export interface BarcodeRenderOptions {
  /** Bar module width (px units at render scale). */
  width?: number;
  /** Bar height (px units at render scale). */
  height?: number;
  /** Quiet zone in module widths (default 10 for linear symbols). */
  margin?: number;
  /** Show the code text under the bars. */
  displayValue?: boolean;
  fontSize?: number;
}

const FORMAT_TO_JS_BARCODE: Partial<Record<BarcodeFormat, string>> = {
  code128: "CODE128",
  ean13: "EAN13",
  ean8: "EAN8",
  upca: "UPC",
  code39: "CODE39",
};

/** Renders a linear barcode to a standalone SVG string. Throws on invalid codes. */
export function renderBarcodeSvg(
  code: string,
  format: BarcodeFormat,
  options: BarcodeRenderOptions = {},
): string {
  const encoder = FORMAT_TO_JS_BARCODE[format];
  if (!encoder) {
    throw new Error(`Format ${format} is not rendered by JsBarcode.`);
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  JsBarcode(svg, code, {
    format: encoder,
    width: options.width ?? 2,
    height: options.height ?? 60,
    margin: options.margin ?? 10,
    displayValue: options.displayValue ?? true,
    fontSize: options.fontSize ?? 14,
    fontOptions: "bold",
    lineColor: "#000000",
    background: "#ffffff",
    // Fail loudly on invalid codes — never print a symbol that will not scan.
    valid: (valid: boolean) => {
      if (!valid) {
        throw new Error(
          `Code ${code} cannot be encoded as ${format} — the printed symbol would not scan.`,
        );
      }
    },
  });
  return svg.outerHTML;
}

/** Renders a QR code to a standalone SVG string (quiet zone = 4 modules). */
export async function renderQrSvg(code: string, sizePx = 120): Promise<string> {
  return QRCode.toString(code, {
    type: "svg",
    margin: 4,
    width: sizePx,
    errorCorrectionLevel: "M",
    color: { dark: "#000000", light: "#ffffff" },
  });
}

/** Renders any supported format; QR is async, linear formats are sync. */
export async function renderBarcodeSvgAny(
  code: string,
  format: BarcodeFormat,
  options: BarcodeRenderOptions = {},
): Promise<string> {
  if (format === "qr") {
    return renderQrSvg(code, (options.height ?? 60) * 2);
  }
  return renderBarcodeSvg(code, format, options);
}
