import { renderLabelPagesHtml } from "./labelRenderer.js";
import type { LabelConfig, LabelPageLayout } from "./labelTemplates.js";

/**
 * Label PDF export: jsPDF (mm-exact pages) + svg2pdf (vector barcode SVGs,
 * sharp at any print size). jsPDF is lazily imported — it is only needed
 * on the generator route, never in the checkout bundle.
 */

interface SvgInPdf {
  (svg: Element, pdf: unknown, options: { x?: number; y?: number; width?: number; height?: number }): Promise<void>;
}

function svgElementFromString(svg: string): Element {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const element = doc.documentElement;
  if (element.tagName.toLowerCase() !== "svg" || element.querySelector("parsererror")) {
    throw new Error("Invalid SVG produced for the label PDF.");
  }
  return element;
}

export async function downloadLabelsPdf(
  pages: LabelPageLayout[],
  config: LabelConfig,
  fields: { shopName: string | null; logoDataUrl: string | null },
  fileName: string,
): Promise<void> {
  const [{ jsPDF }, { svg2pdf }] = await Promise.all([
    import("jspdf"),
    import("svg2pdf.js"),
  ]);
  const svg2pdfFn = svg2pdf as unknown as SvgInPdf;

  const html = await renderLabelPagesHtml(pages, config, fields);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const pageElements = Array.from(doc.querySelectorAll(".ez-label-page"));
  if (pageElements.length === 0) {
    throw new Error("Nothing to print — select at least one item.");
  }

  let pdf: import("jspdf").jsPDF | null = null;
  for (const [index, pageElement] of pageElements.entries()) {
    const layout = pages[index]!;
    if (index === 0) {
      const JsPdfConstructor = jsPDF as unknown as new (options: {
        unit: string;
        format: [number, number];
        orientation: string;
      }) => import("jspdf").jsPDF;
      pdf = new JsPdfConstructor({
        unit: "mm",
        format: [layout.pageWidthMm, layout.pageHeightMm],
        orientation: layout.pageWidthMm > layout.pageHeightMm ? "landscape" : "portrait",
      });
    } else {
      pdf!.addPage([layout.pageWidthMm, layout.pageHeightMm], layout.pageWidthMm > layout.pageHeightMm ? "landscape" : "portrait");
    }

    for (const cell of layout.cells) {
      // The label cell's SVG (bars) is regenerated as a standalone element —
      // svg2pdf needs an <svg> node, not HTML context.
      const barcodeSvg = pageElement.querySelectorAll(".ez-label-barcode svg")[layout.cells.indexOf(cell)];
      if (barcodeSvg instanceof Element) {
        const standalone = svgElementFromString(barcodeSvg.outerHTML);
        // Barcode block sits centered; compute a conservative box from the
        // cell rect minus padding — svg2pdf scales the symbol to fit width.
        const padding = config.paddingMm;
        await svg2pdfFn(standalone, pdf, {
          x: cell.xMm + padding,
          y: cell.yMm + cell.heightMm / 2 - config.barcodeHeightMm / 2 - 2,
          width: cell.widthMm - padding * 2,
          height: config.barcodeHeightMm + 6,
        });
      }
    }

    // Text fields: drawn with jsPDF text at the cell layout (top-down).
    for (const cell of layout.cells) {
      const item = cell.item;
      const padding = config.paddingMm;
      let y = cell.yMm + padding + 3;
      const textLines: { text: string; size: number; bold: boolean }[] = [];
      if (config.includeShopName && fields.shopName) {
        textLines.push({ text: fields.shopName, size: config.nameFontSizePt, bold: true });
      }
      if (config.includeProductName) {
        textLines.push({ text: item.productName, size: config.nameFontSizePt, bold: false });
      }
      if (config.includeVariantName && item.variantLabel) {
        textLines.push({ text: item.variantLabel, size: config.nameFontSizePt, bold: false });
      }
      if (config.includeSku) {
        textLines.push({ text: `SKU: ${item.sku}`, size: config.nameFontSizePt - 1, bold: false });
      }
      pdf!.setTextColor(0, 0, 0);
      for (const line of textLines) {
        pdf!.setFontSize(line.size);
        pdf!.setFont("helvetica", line.bold ? "bold" : "normal");
        pdf!.text(line.text.slice(0, 60), cell.xMm + padding, y, { maxWidth: cell.widthMm - padding * 2 });
        y += line.size * 0.45;
      }
      if (config.includePrice) {
        pdf!.setFontSize(config.priceFontSizePt);
        pdf!.setFont("helvetica", "bold");
        pdf!.text(
          `৳ ${item.sellingPrice.toFixed(2)}`,
          cell.xMm + padding,
          cell.yMm + cell.heightMm - padding - 1,
        );
      }
    }
  }

  pdf!.save(fileName);
}
