/**
 * Shared CSV cell handling (Phase 1 hardening). Two concerns:
 *
 * 1. RFC-4180 escaping — quote cells containing delimiters/quotes/newlines.
 * 2. Formula injection guarding — a cell beginning with = + - @ (optionally
 *    after whitespace/TAB padding, which Excel strips) can execute as a
 *    formula when the export is opened in a spreadsheet application. The
 *    standard mitigation is a leading apostrophe, which the guard below
 *    applies (same rule the products export has used since 0047).
 *
 * Every server-side CSV producer must run values through guardCsvCell —
 * including numbers from the database (a crafted customer name is the
 * classic vector, but reference numbers and notes are user input too).
 */

/** RFC-4180 escape: wrap in quotes when needed and double embedded quotes. */
export function escapeCsvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Neutralize formula-injection: leading = + - @ (after TAB/CR/space padding)
 * gets a prefixed apostrophe so spreadsheets treat the cell as text.
 */
export function guardCsvCell(value: unknown): string {
  return String(value ?? "")
    .replace(/^[\t\r ]*[=+\-@]/, "'$&");
}

/** Combined: guard then escape — the default for any user-reachable value. */
export function safeCsvCell(value: unknown): string {
  return escapeCsvCell(guardCsvCell(value));
}
