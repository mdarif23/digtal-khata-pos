import ExcelJS from "exceljs";

/**
 * File parsing for product import (Phase D).
 *
 * CSV: in-house RFC 4180 parser — BOM-tolerant, UTF-8/Bengali safe, quoted
 * fields, CRLF/LF, embedded newlines. No extra dependency.
 * XLSX: exceljs. Worksheet selection + header-row selection + duplicate
 * header detection. ORIGINAL spreadsheet row numbers are preserved
 * everywhere (they drive row-level error reporting).
 *
 * File validation: extension + MIME + magic bytes. Macro-enabled formats
 * (.xls/.xlsm/.xltm) and executables are rejected outright.
 */

export const SUPPORTED_EXTENSIONS = [".csv", ".xlsx"] as const;
export const DEFAULT_MAX_FILE_MB = 15;

export class FileParseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FileParseError";
    this.code = code;
  }
}

export function assertUploadAcceptable(input: {
  filename: string;
  mimeType?: string | null;
  bytes: Buffer;
  maxMb?: number;
}): void {
  const maxMb = input.maxMb ?? DEFAULT_MAX_FILE_MB;
  if (input.bytes.length === 0) {
    throw new FileParseError("empty_file", "The uploaded file is empty.");
  }
  if (input.bytes.length > maxMb * 1024 * 1024) {
    throw new FileParseError(
      "file_too_large",
      `File exceeds the ${maxMb} MB import limit.`,
    );
  }
  const lower = input.filename.toLowerCase();
  const isCsv = lower.endsWith(".csv");
  const isXlsx = lower.endsWith(".xlsx");
  if (!isCsv && !isXlsx) {
    throw new FileParseError(
      "unsupported_format",
      "Only .csv and .xlsx files are accepted (macro-enabled workbooks are not).",
    );
  }
  if (input.mimeType) {
    const mime = input.mimeType.toLowerCase();
    const allowed = isCsv
      ? [
          "text/csv",
          "text/plain",
          "application/vnd.ms-excel",
          "application/csv",
          "application/octet-stream",
        ]
      : [
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/octet-stream",
        ];
    if (!allowed.includes(mime)) {
      throw new FileParseError(
        "unsupported_mime",
        `Unexpected content type "${input.mimeType}" for a ${isCsv ? "CSV" : "XLSX"} file.`,
      );
    }
  }
  // Magic bytes: CSV must be text-ish; XLSX must be a ZIP (PK\x03\x04).
  if (isXlsx) {
    if (
      !(
        input.bytes[0] === 0x50 &&
        input.bytes[1] === 0x4b &&
        (input.bytes[2] === 0x03 || input.bytes[2] === 0x05 || input.bytes[2] === 0x07)
      )
    ) {
      throw new FileParseError(
        "invalid_signature",
        "The .xlsx file does not look like a valid Excel workbook.",
      );
    }
  } else {
    const sample = input.bytes.subarray(0, 4096);
    if (sample.includes(0x00)) {
      throw new FileParseError(
        "invalid_signature",
        "The CSV file contains binary data.",
      );
    }
    const lowerText = sample.toString("latin1").slice(0, 200).toLowerCase();
    if (lowerText.includes("<?php") || lowerText.includes("mz\x90")) {
      throw new FileParseError(
        "rejected_executable",
        "Executable or script content is not accepted.",
      );
    }
  }
}

export interface ParsedSheet {
  /** Worksheet name (XLSX) or "CSV". */
  worksheet: string;
  /** 1-based spreadsheet row numbers, preserved for error reporting. */
  rowNumbers: number[];
  /** Cell values per row, keyed by ORIGINAL header text (trimmed). */
  rows: Record<string, string | null>[];
  headers: string[];
  duplicateHeaders: string[];
  availableWorksheets: string[];
  totalRowCount: number;
  columnCount: number;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

/** RFC 4180 CSV parser: quoted cells, embedded newlines, BOM, CRLF/LF. */
export function parseCsv(text: string): string[][] {
  const normalized = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (inQuotes) {
      if (char === '"') {
        if (normalized[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && normalized[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else {
      cell += char;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function detectDuplicateHeaders(headers: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const header of headers) {
    const key = header.toLowerCase();
    if (seen.has(key)) duplicates.add(header);
    seen.add(key);
  }
  return [...duplicates];
}

function buildSheet(
  worksheet: string,
  matrix: string[][],
  headerRow: number,
  availableWorksheets: string[],
): ParsedSheet {
  if (matrix.length <= headerRow) {
    throw new FileParseError(
      "no_data_rows",
      `No data rows found below the header row (${headerRow}).`,
    );
  }
  const rawHeaders = (matrix[headerRow - 1] ?? []).map((h) => h.trim());
  const headers = rawHeaders.map((h, i) => (h === "" ? `column_${i + 1}` : h));
  const duplicateHeaders = detectDuplicateHeaders(headers);
  const rowNumbers: number[] = [];
  const rows: Record<string, string | null>[] = [];
  for (let i = headerRow; i < matrix.length; i += 1) {
    const raw = matrix[i] ?? [];
    const hasContent = raw.some((cell) => (cell ?? "").trim() !== "");
    if (!hasContent) continue; // empty rows are skipped, not errored
    const record: Record<string, string | null> = {};
    headers.forEach((header, col) => {
      record[header] = raw[col] === undefined ? null : String(raw[col]);
    });
    // Spreadsheet row number = file position (1-based, header at headerRow).
    rowNumbers.push(i + 1);
    rows.push(record);
  }
  const columnCount = Math.max(
    0,
    ...matrix.slice(0, Math.min(matrix.length, headerRow + 50)).map((r) => r.length),
  );
  return {
    worksheet,
    rowNumbers,
    rows,
    headers,
    duplicateHeaders,
    availableWorksheets,
    totalRowCount: rows.length,
    columnCount,
  };
}

export function parseCsvUpload(bytes: Buffer, headerRow: number): ParsedSheet {
  const matrix = parseCsv(bytes.toString("utf8"));
  return buildSheet("CSV", matrix, headerRow, ["CSV"]);
}

export async function parseXlsxUpload(
  bytes: Buffer,
  worksheetName: string | null,
  headerRow: number,
): Promise<ParsedSheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const names = workbook.worksheets.map((sheet) => sheet.name);
  if (names.length === 0) {
    throw new FileParseError("empty_workbook", "The workbook has no worksheets.");
  }
  const target = (
    (worksheetName && workbook.worksheets.find((s) => s.name === worksheetName)) ||
    workbook.worksheets[0]
  ) as ExcelJS.Worksheet;
  if (!target) {
    throw new FileParseError("empty_workbook", "The workbook has no worksheets.");
  }
  const matrix: string[][] = [];
  target.eachRow({ includeEmpty: true }, (row: ExcelJS.Row) => {
    const values: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell: ExcelJS.Cell, colNumber: number) => {
      values[colNumber - 1] = cell.value == null ? "" : String(cell.value).trim();
    });
    for (let i = 0; i < values.length; i += 1) {
      if (values[i] === undefined) values[i] = "";
    }
    matrix.push(values);
  });
  return buildSheet(target.name, matrix, headerRow, names);
}

// ----------------------------------------------------
// Template generation (Phase D): CSV + XLSX with instructions
// ----------------------------------------------------

export interface TemplateColumn {
  header: string;
  description: string;
  required: boolean;
  example: string;
}

export const TEMPLATE_COLUMNS: TemplateColumn[] = [
  { header: "product_name", description: "Product name (required, max 100 chars). Rows with the same product name (+ category/brand) are grouped into one product with multiple variants.", required: true, example: "Football" },
  { header: "product_type", description: "physical | service | digital (default physical).", required: false, example: "physical" },
  { header: "category", description: "Category name. Matched case-insensitively; created when allowed.", required: false, example: "Sports" },
  { header: "brand", description: "Brand name. Matched case-insensitively; created when allowed.", required: false, example: "Adidas" },
  { header: "unit", description: "Unit name (required). Matched case-insensitively; created when allowed.", required: true, example: "Piece" },
  { header: "description", description: "Product description (max 120 chars).", required: false, example: "Size 5 football" },
  { header: "sku", description: "SKU — the per-variant SKU (for simple products this is the product SKU). Unique per business. Leave empty to auto-generate.", required: false, example: "FOOT-S" },
  { header: "has_variants", description: "true | false. Auto-detected when several rows share the same product.", required: false, example: "true" },
  { header: "variant_options", description: 'Variant attributes in canonical form "Size: Small | Color: Red". One row per variant.', required: false, example: "Size: Small" },
  { header: "barcode", description: "Barcode (unique per business when present). EAN-8/EAN-13/UPC-A check digits validated.", required: false, example: "8801234567890" },
  { header: "selling_price", description: "Selling price per unit (required, >= 0, 2 decimals).", required: true, example: "500" },
  { header: "purchase_price", description: "Purchase cost used for the opening-stock batch (internal field).", required: false, example: "350" },
  { header: "alert_quantity", description: "Low-stock alert threshold (default 0).", required: false, example: "5" },
  { header: "tracking_type", description: "none | batch | serial (default none).", required: false, example: "none" },
  { header: "opening_stock", description: "Optional opening quantity at the location. Requires purchase_price when tracking is batch.", required: false, example: "10" },
  { header: "location", description: "Location name for the opening stock. Defaults to the business default location.", required: false, example: "Main Store" },
  { header: "batch_number", description: "Batch number (required when tracking_type = batch).", required: false, example: "BATCH-001" },
  { header: "expiry_date", description: "Expiry date, YYYY-MM-DD (batch-tracked goods).", required: false, example: "2027-12-31" },
  { header: "serial_numbers", description: "Semicolon-separated serial numbers (required when tracking_type = serial; count must equal opening_stock).", required: false, example: "SN1;SN2" },
  { header: "weight", description: "Variant weight for landed-cost weight allocation (0 or empty = none).", required: false, example: "0.45" },
  { header: "weight_unit", description: "kg | g | lb | oz (default kg).", required: false, example: "kg" },
  { header: "image_url", description: "https:// image URL stored as the product image.", required: false, example: "https://example.com/ball.jpg" },
  { header: "status", description: "draft | active | inactive (default active). Import as draft to stay under the product plan limit.", required: false, example: "active" },
];

const SAMPLE_ROWS: string[][] = [
  ["Football", "physical", "Sports", "Adidas", "Piece", "Size 5 football", "FOOT-S", "true", "Size: Small", "8801234567890", "500", "350", "5", "none", "10", "Main Store", "", "", "", "https://example.com/ball.png", "active"],
  ["Football", "physical", "Sports", "Adidas", "Piece", "Size 5 football", "FOOT-M", "true", "Size: Medium", "", "550", "350", "5", "none", "10", "Main Store", "", "", "", "", "active"],
  ["Football", "physical", "Sports", "Adidas", "Piece", "Size 5 football", "FOOT-L", "true", "Size: Large", "", "600", "350", "5", "none", "0", "Main Store", "", "", "", "", "active"],
  ["Water Bottle", "physical", "Accessories", " ", "Piece", "1L bottle", "BTL-1", "false", "", "8809876543210", "120", "70", "10", "batch", "50", "Main Store", "BATCH-2026", "2027-12-31", "", "", "active"],
];

export async function generateTemplate(
  format: "csv" | "xlsx",
): Promise<{ filename: string; contentType: string; bytes: globalThis.Buffer }> {
  const headers = TEMPLATE_COLUMNS.map((c) => c.header);
  if (format === "csv") {
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const lines = [
      headers.join(","),
      ...SAMPLE_ROWS.map((row) => row.map(escape).join(",")),
    ];
    return {
      filename: "ezpos-product-import-template.csv",
      contentType: "text/csv; charset=utf-8",
      bytes: Buffer.from("\uFEFF" + lines.join("\r\n"), "utf8"),
    };
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ezPos";
  const instructions = workbook.addWorksheet("Instructions");
  instructions.columns = [
    { header: "Column", key: "col", width: 22 },
    { header: "Required", key: "req", width: 10 },
    { header: "Description", key: "desc", width: 90 },
    { header: "Example", key: "ex", width: 30 },
  ];
  instructions.getRow(1).font = { bold: true };
  instructions.addRow({});
  instructions.addRow({
    col: "HOW TO IMPORT",
    req: "",
    desc:
      "1. Fill the 'Products' worksheet (one row per variant for variant products; rows sharing product_name + category + brand group into one product). " +
      "2. Keep the header row unchanged (row 1). 3. Dates are YYYY-MM-DD. 4. Booleans are true/false. 5. Save as .xlsx and upload in Import Products. " +
      "IMPORTANT: purchase_price is an internal cost field — it is never included in ordinary public exports.",
    ex: "",
  });
  instructions.getRow(3).font = { bold: true };
  for (const column of TEMPLATE_COLUMNS) {
    instructions.addRow({
      col: column.header,
      req: column.required ? "YES" : "optional",
      desc: column.description,
      ex: column.example,
    });
  }
  const sheet = workbook.addWorksheet("Products");
  const headerRow = sheet.addRow(headers);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFD9F2E7" },
  };
  for (const row of SAMPLE_ROWS) sheet.addRow(row);
  sheet.columns.forEach((column) => {
    column.width = 18;
  });
  const bytes = Buffer.from(
    (await workbook.xlsx.writeBuffer()) as ArrayBuffer,
  );
  return {
    filename: "ezpos-product-import-template.xlsx",
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes,
  };
}
