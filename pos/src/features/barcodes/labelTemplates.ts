/**
 * Label geometry: sizes, page layouts, and the field set printed on a
 * label. All dimensions are millimeters — the same unit the print CSS
 * (@page) and the jsPDF document use, so preview == print == PDF.
 */

export interface LabelSize {
  id: string;
  label: string;
  /** Label width in mm. */
  widthMm: number;
  /** Label height in mm. */
  heightMm: number;
  /** Continuous sheet (thermal roll) vs A4 grid. */
  kind: "roll" | "a4";
  /** Suggested defaults tuned for handheld scanners (GS1 guidance). */
  defaults: LabelConfig;
}

export interface LabelConfig {
  /** A4 grid only: labels per row. */
  labelsPerRow?: number;
  /** Horizontal gap between labels on A4 (mm). */
  horizontalSpacingMm?: number;
  /** Vertical gap between labels on A4 (mm). */
  verticalSpacingMm?: number;
  /** Page margins (mm) — A4 only; rolls print edge-to-edge. */
  pageMarginMm?: number;
  /** Label inner padding (mm). */
  paddingMm: number;
  /** Linear barcode bar height in mm (≥ 8 for reliable scans). */
  barcodeHeightMm: number;
  /** Linear barcode quiet zone in mm (≥ 2.5 ≈ 10 modules at 0.25mm). */
  quietZoneMm: number;
  /** Product/variant name font size (pt). */
  nameFontSizePt: number;
  /** Price font size (pt). */
  priceFontSizePt: number;
  /** Include which fields. */
  includeProductName: boolean;
  includeVariantName: boolean;
  includeSku: boolean;
  includePrice: boolean;
  includeShopName: boolean;
  includeLogo: boolean;
}

export interface LabelItem {
  variantId: number;
  productId: number;
  productName: string;
  variantLabel: string | null;
  sku: string;
  barcode: string;
  barcodeFormat: string | null;
  sellingPrice: number;
  /**
   * UOM (migration 0062): optional packaging line, e.g. "Box of 12" —
   * printed under the code when the label's alias stands for a package.
   * Absent/null keeps the default layout untouched.
   */
  packageUnitLine?: string | null;
}

export const LABEL_SIZES: LabelSize[] = [
  {
    id: "40x25",
    label: "40 × 25 mm (small item)",
    widthMm: 40,
    heightMm: 25,
    kind: "roll",
    defaults: {
      paddingMm: 1.5,
      barcodeHeightMm: 8,
      quietZoneMm: 2.5,
      nameFontSizePt: 6,
      priceFontSizePt: 10,
      includeProductName: true,
      includeVariantName: true,
      includeSku: false,
      includePrice: true,
      includeShopName: false,
      includeLogo: false,
    },
  },
  {
    id: "50x30",
    label: "50 × 30 mm (standard)",
    widthMm: 50,
    heightMm: 30,
    kind: "roll",
    defaults: {
      paddingMm: 2,
      barcodeHeightMm: 10,
      quietZoneMm: 3,
      nameFontSizePt: 7,
      priceFontSizePt: 12,
      includeProductName: true,
      includeVariantName: true,
      includeSku: true,
      includePrice: true,
      includeShopName: false,
      includeLogo: false,
    },
  },
  {
    id: "60x40",
    label: "60 × 40 mm (large)",
    widthMm: 60,
    heightMm: 40,
    kind: "roll",
    defaults: {
      paddingMm: 2.5,
      barcodeHeightMm: 12,
      quietZoneMm: 3,
      nameFontSizePt: 8,
      priceFontSizePt: 14,
      includeProductName: true,
      includeVariantName: true,
      includeSku: true,
      includePrice: true,
      includeShopName: true,
      includeLogo: true,
    },
  },
  {
    id: "a4",
    label: "A4 sheet (65 × 35 mm grid)",
    widthMm: 65,
    heightMm: 35,
    kind: "a4",
    defaults: {
      labelsPerRow: 3,
      horizontalSpacingMm: 2.5,
      verticalSpacingMm: 4,
      pageMarginMm: 7,
      paddingMm: 2,
      barcodeHeightMm: 10,
      quietZoneMm: 3,
      nameFontSizePt: 7,
      priceFontSizePt: 12,
      includeProductName: true,
      includeVariantName: true,
      includeSku: true,
      includePrice: true,
      includeShopName: false,
      includeLogo: false,
    },
  },
];

export const DEFAULT_LABEL_SIZE_ID = "50x30";

export function labelSizeById(id: string): LabelSize {
  return LABEL_SIZES.find((size) => size.id === id) ?? LABEL_SIZES[1]!;
}

export function defaultConfigFor(size: LabelSize, shopName: string | null): LabelConfig {
  return { ...size.defaults };
}

/** Expands the print queue: copies per item, barcode per variant. */
export function expandLabelQueue(items: LabelItem[], copiesPerItem: number): LabelItem[] {
  const copies = Math.max(1, Math.min(Math.round(copiesPerItem), 1000));
  const queue: LabelItem[] = [];
  for (const item of items) {
    for (let i = 0; i < copies; i += 1) queue.push(item);
  }
  return queue;
}

/** A4 page geometry (mm). */
export const A4 = { widthMm: 210, heightMm: 297 };

export interface LabelLayoutCell {
  item: LabelItem;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

export interface LabelPageLayout {
  kind: "roll" | "a4";
  /** Page size in mm (roll = one label per page). */
  pageWidthMm: number;
  pageHeightMm: number;
  cells: LabelLayoutCell[];
}

/**
 * Lays the queue out onto pages. Roll sizes → one label per "page" (the
 * print CSS @page matches the label exactly). A4 → grid with margins,
 * spacing and labels-per-row.
 */
export function layoutLabels(
  queue: LabelItem[],
  size: LabelSize,
  config: LabelConfig,
): LabelPageLayout[] {
  if (size.kind === "roll") {
    return queue.map((item) => ({
      kind: "roll" as const,
      pageWidthMm: size.widthMm,
      pageHeightMm: size.heightMm,
      cells: [{ item, xMm: 0, yMm: 0, widthMm: size.widthMm, heightMm: size.heightMm }],
    }));
  }

  const perRow = Math.max(1, Math.min(config.labelsPerRow ?? 3, 6));
  const margin = config.pageMarginMm ?? 7;
  const gapX = config.horizontalSpacingMm ?? 2.5;
  const gapY = config.verticalSpacingMm ?? 4;
  const cellWidth = size.widthMm;
  const cellHeight = size.heightMm;
  const usableWidth = A4.widthMm - margin * 2;
  const perPage = Math.floor(
    (A4.heightMm - margin * 2 + gapY) / (cellHeight + gapY),
  ) * perRow;

  const pages: LabelPageLayout[] = [];
  for (let index = 0; index < queue.length; index += perPage) {
    const pageItems = queue.slice(index, index + perPage);
    const cells: LabelLayoutCell[] = pageItems.map((item, position) => {
      const row = Math.floor(position / perRow);
      const column = position % perRow;
      return {
        item,
        xMm: margin + column * (cellWidth + gapX),
        yMm: margin + row * (cellHeight + gapY),
        widthMm: cellWidth,
        heightMm: cellHeight,
      };
    });
    pages.push({
      kind: "a4",
      pageWidthMm: A4.widthMm,
      pageHeightMm: A4.heightMm,
      cells,
    });
  }
  void usableWidth;
  return pages;
}
