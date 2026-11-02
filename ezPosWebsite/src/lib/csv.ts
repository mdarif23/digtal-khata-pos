/**
 * Minimal RFC 4180-style CSV building and browser download, shared by the
 * portal invoice export and the admin payments export. Both export data
 * already loaded from the backend — no additional API calls.
 */

export type CsvCell = string | number | null | undefined;

function escapeCell(value: CsvCell): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(
  headers: string[],
  rows: CsvCell[][],
): string {
  return [headers, ...rows]
    .map((row) => row.map(escapeCell).join(","))
    .join("\r\n");
}

/**
 * Downloads a CSV in the browser. The UTF-8 BOM makes Excel open the file
 * with the right encoding by default.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([`\uFEFF${csv}`], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
