import { renderBarcodeSvgAny } from "./barcodeRenderer.js";
import type { LabelItem, LabelConfig, LabelPageLayout } from "./labelTemplates.js";

/**
 * Label sheet rendering — one HTML document shared by the browser print
 * pipeline (exact @page mm sizing) and the PDF pipeline (svg2pdf converts
 * the same SVGs into vector graphics). Barcodes are always embedded as
 * SVG with fixed module widths — never stretched, never rasterized.
 */

export interface LabelFieldValues {
  shopName: string | null;
  logoDataUrl: string | null;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const MM_PER_PX_AT_96DPI = 25.4 / 96;

function pxFromMm(mm: number): number {
  return mm / MM_PER_PX_AT_96DPI;
}

function barcodeScaleFor(config: LabelConfig): { width: number; height: number; margin: number } {
  // JsBarcode units are "modules" at scale 1 ≈ 1px. Convert mm targets to
  // px at 96dpi, then pick an integer bar width so module edges stay crisp.
  const heightPx = pxFromMm(config.barcodeHeightMm);
  const marginPx = pxFromMm(config.quietZoneMm);
  const width = Math.max(1, Math.round(pxFromMm(0.33) * 2)); // ~0.33mm modules
  return {
    width,
    height: Math.max(20, Math.round(heightPx)),
    margin: Math.max(2, Math.round(marginPx / width)),
  };
}

async function renderLabelCellSvg(item: LabelItem, config: LabelConfig): Promise<string | null> {
  const format = (item.barcodeFormat as never) ?? "code128";
  try {
    const scale = barcodeScaleFor(config);
    return await renderBarcodeSvgAny(item.barcode, format, {
      width: scale.width,
      height: scale.height,
      margin: scale.margin,
      displayValue: true,
      fontSize: Math.max(8, Math.round(config.nameFontSizePt + 2)),
    });
  } catch {
    // An unrenderable code must never silently print a blank/wrong symbol.
    return null;
  }
}

function fieldLines(item: LabelItem, config: LabelConfig): string[] {
  const lines: string[] = [];
  if (config.includeShopName) lines.push("shop");
  if (config.includeProductName) lines.push(item.productName);
  if (config.includeVariantName && item.variantLabel) lines.push(item.variantLabel);
  if (config.includeSku) lines.push(`SKU: ${item.sku}`);
  // UOM (migration 0062): the packaging line (e.g. "Box of 12") for labels
  // whose alias stands for a package. Optional — the default layout is
  // untouched otherwise.
  if (item.packageUnitLine) lines.push(item.packageUnitLine);
  return lines;
}

/** Builds one label cell's inner HTML (SVG placeholder + text fields). */
function labelCellHtml(item: LabelItem, config: LabelConfig, svg: string | null, fields: LabelFieldValues): string {
  const lines = fieldLines(item, config);
  const shopLine =
    config.includeShopName && fields.shopName
      ? `<div class="ez-label-shop">${escapeHtml(fields.shopName)}</div>`
      : "";
  const logo =
    config.includeLogo && fields.logoDataUrl
      ? `<img class="ez-label-logo" src="${fields.logoDataUrl}" alt="" />`
      : "";
  const nameLines = lines
    .filter((line) => line !== "shop")
    .map((line) => `<div class="ez-label-name">${escapeHtml(line)}</div>`)
    .join("");
  const price = config.includePrice
    ? `<div class="ez-label-price">৳ ${item.sellingPrice.toFixed(2)}</div>`
    : "";
  const barcodeBlock = svg
    ? `<div class="ez-label-barcode">${svg}</div>`
    : `<div class="ez-label-barcode-error">Barcode could not be rendered — fix the code before printing.</div>`;
  return `
    <div class="ez-label-cell">
      ${logo}
      ${shopLine}
      ${nameLines}
      ${barcodeBlock}
      ${price}
    </div>`;
}

/** Builds the complete print HTML document for the laid-out pages. */
export async function renderLabelPagesHtml(
  pages: LabelPageLayout[],
  config: LabelConfig,
  fields: LabelFieldValues,
): Promise<string> {
  const pageHtmls: string[] = [];
  for (const page of pages) {
    const cells: string[] = [];
    for (const cell of page.cells) {
      const svg = await renderLabelCellSvg(cell.item, config);
      cells.push(
        `<div class="ez-label-slot" style="left:${cell.xMm}mm;top:${cell.yMm}mm;width:${cell.widthMm}mm;height:${cell.heightMm}mm">${labelCellHtml(
          cell.item,
          config,
          svg,
          fields,
        )}</div>`,
      );
    }
    pageHtmls.push(
      `<section class="ez-label-page" style="width:${page.pageWidthMm}mm;height:${page.pageHeightMm}mm">${cells.join("")}</section>`,
    );
  }

  const padding = config.paddingMm;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>ezPos labels</title>
<style>
  @page { margin: 0; }
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .ez-label-page {
    position: relative;
    page-break-after: always;
    break-after: page;
    overflow: hidden;
    background: #ffffff;
  }
  .ez-label-page:last-child { page-break-after: auto; break-after: auto; }
  .ez-label-slot { position: absolute; box-sizing: border-box; }
  .ez-label-cell {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: ${padding}mm;
    background: #ffffff;
    color: #000000;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    text-align: center;
    overflow: hidden;
    font-family: Arial, "Noto Sans Bengali", sans-serif;
  }
  .ez-label-shop { font-weight: 700; font-size: ${config.nameFontSizePt}pt; white-space: nowrap; }
  .ez-label-name { font-size: ${config.nameFontSizePt}pt; line-height: 1.15; overflow: hidden; max-height: 2.6em; }
  .ez-label-price { font-weight: 700; font-size: ${config.priceFontSizePt}pt; white-space: nowrap; }
  .ez-label-barcode svg { max-width: 100%; height: auto; display: block; }
  .ez-label-barcode-error { font-size: 6pt; color: #b91c1c; }
  .ez-label-logo { max-height: ${Math.max(4, config.barcodeHeightMm / 2)}mm; max-width: 80%; object-fit: contain; }
</style>
</head>
<body>
${pageHtmls.join("")}
</body>
</html>`;
}

/** Injects the exact @page size for the print pipeline (rolls + A4). */
export function withPageSize(html: string, pageWidthMm: number, pageHeightMm: number): string {
  return html.replace(
    "@page { margin: 0; }",
    `@page { size: ${pageWidthMm}mm ${pageHeightMm}mm; margin: 0; }`,
  );
}

/** Prints the label sheet through a hidden iframe (browser print dialog). */
export function printLabelHtml(html: string): void {
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow?.document;
  if (!doc) {
    iframe.remove();
    throw new Error("Unable to create the print frame.");
  }
  doc.open();
  doc.write(html);
  doc.close();
  const win = iframe.contentWindow!;
  const cleanup = () => window.setTimeout(() => iframe.remove(), 500);
  if (win.document.readyState === "complete") {
    win.focus();
    win.print();
    cleanup();
  } else {
    iframe.onload = () => {
      win.focus();
      win.print();
      cleanup();
    };
  }
}
