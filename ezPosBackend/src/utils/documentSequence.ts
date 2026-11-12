import { sql } from "drizzle-orm";
import type { NodePgDatabase, NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";

type Tx = PgTransaction<
  NodePgQueryResultHKT,
  Record<string, never>,
  ExtractTablesWithRelations<Record<string, never>>
>;
type Db = NodePgDatabase<Record<string, never>>;

/**
 * Document number allocation.
 *
 * INVARIANT: `document_sequences.next_value` is the NEXT number to allocate
 * (not the last allocated). For a given (businessId, sequenceKey), committed
 * allocations return 1, 2, 3, ... strictly increasing, with no duplicates and
 * no gaps: the counter participates in the CALLER'S transaction, so a rolled
 * back document (sale/purchase/product) rolls back the increment too — failed
 * operations never consume a number.
 *
 * CONCURRENCY: the increment and the returned value happen in ONE statement.
 * Two concurrent transactions for the same (businessId, key) serialize on the
 * conflicting row (insert-wait or row lock); each reads the other's committed
 * value, so duplicates are impossible. Different (businessId, key) pairs never
 * interact. Numbers continue across years — the year embedded in the formatted
 * prefix is the issue year only and never resets the counter.
 *
 * TRANSACTION BOUNDARY: this function MUST be called with the same `tx` that
 * inserts the corresponding document. Passing the bare `db` would allocate a
 * number in its own auto-committed statement, which breaks the rollback
 * guarantee. The `db` overload exists only for callers that intentionally
 * allocate outside a document transaction (currently none).
 *
 * Keys: "sale_invoice" | "purchase_order" | "product_sku".
 */
export async function nextDocumentNumber(
  tx: Tx | Db,
  businessId: number,
  sequenceKey: string,
): Promise<number> {
  const result = await tx.execute(
    sql`INSERT INTO document_sequences (business_id, sequence_key, next_value)
        VALUES (${businessId}, ${sequenceKey}, 2)
        ON CONFLICT (business_id, sequence_key)
        DO UPDATE SET next_value = document_sequences.next_value + 1
        RETURNING next_value - 1 AS number`,
  );
  const row = result.rows[0];
  if (!row) {
    // Unreachable for INSERT ... RETURNING, but fail closed rather than
    // return a meaningless default.
    throw new Error(`Failed to allocate document number for ${sequenceKey}`);
  }
  return Number(row.number);
}

/** Formats a sale invoice number: INV-<issue-year>-<6 digits>. */
export function formatSaleInvoiceNumber(
  year: number,
  number: number,
): string {
  return `INV-${year}-${String(number).padStart(6, "0")}`;
}

/** Formats a purchase order number: PO-<issue-year>-<6 digits>. */
export function formatPurchaseOrderNumber(
  year: number,
  number: number,
): string {
  return `PO-${year}-${String(number).padStart(6, "0")}`;
}

/** Formats a product SKU: SKU-<6 digits>. */
export function formatProductSku(number: number): string {
  return `SKU-${String(number).padStart(6, "0")}`;
}

/** Formats a customer warranty number: WRN-<issue-year>-<6 digits>. */
export function formatWarrantyNumber(year: number, number: number): string {
  return `WRN-${year}-${String(number).padStart(6, "0")}`;
}

/** Formats a customer warranty claim number: CLM-<issue-year>-<6 digits>. */
export function formatWarrantyClaimNumber(year: number, number: number): string {
  return `CLM-${year}-${String(number).padStart(6, "0")}`;
}

/** Formats a supplier warranty claim number: SWC-<issue-year>-<6 digits>. */
export function formatSupplierClaimNumber(year: number, number: number): string {
  return `SWC-${year}-${String(number).padStart(6, "0")}`;
}
