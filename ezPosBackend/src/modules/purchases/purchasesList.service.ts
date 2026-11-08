import { sql, type SQL } from "drizzle-orm";
import { db } from "../../db/schema/index.js";
import { deriveLandedCostStatus } from "./purchases.service.js";
import type { PurchaseListQuery } from "./purchasesList.schema.js";

// Takes the caller's server-verified businessId (from requireBusinessContext).

/**
 * Purchase-list summary row (Phase 4/5). ONE grouped query: header +
 * supplier + landed-cost status + item aggregates + return aggregates.
 * Receiving status and return status are SERVER-AUTHORITATIVE and
 * independent:
 * - receivingStatus mirrors the purchase's receiving workflow state.
 * - returnStatus derives from actual accepted received quantities vs
 *   actual returned quantities (NULL = no returns).
 * - fullyCancelled flags workflow-complete purchases with ZERO accepted
 *   goods (they must never read as received goods in the UI).
 *
 * Outstanding quantity is clamped at zero per line (over-receiving must
 * not produce negative outstanding). All money fields come from the
 * purchase header (the denormalized figures maintained by the receiving,
 * return, payment and resolution flows) — exact numeric arithmetic
 * server-side, converted to numbers only for transport.
 */
export interface PurchaseListItem {
  id: number;
  purchaseOrderNumber: string;
  purchaseDate: string;
  supplierId: number | null;
  supplierName: string | null;
  supplierPhone: string | null;
  receivingStatus: "ordered" | "partially_received" | "received";
  returnStatus: "Returned" | "Partially returned" | null;
  fullyCancelled: boolean;

  totalItems: number;
  orderedQuantity: number;
  acceptedReceivedQuantity: number;
  rejectedQuantity: number;
  cancelledQuantity: number;
  returnedQuantity: number;
  outstandingQuantity: number;

  subtotal: number;
  discount: number;
  tax: number;
  shippingCost: number;
  landedCostStatus: "pending" | "allocated" | null;

  totalAmount: number;
  paidAmount: number;
  dueAmount: number;
  paymentStatus: "paid" | "unpaid" | "partial";

  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseListPage {
  data: PurchaseListItem[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
  /** Tab counts + cards, scoped to the active data filters (search,
   *  supplier, dates) but NEVER to the page — they always describe the
   *  full filtered set. */
  counts: {
    all: number;
    ordered: number;
    partially_received: number;
    received: number;
    partially_returned: number;
    returned: number;
    cancelled: number;
  };
  summary: {
    totalPurchases: number;
    awaitingReceipt: number;
    outstandingBalance: number;
  };
}

/** Sort whitelist — user input never reaches ORDER BY unquoted. */
const SORT_COLUMNS: Record<PurchaseListQuery["sortBy"], string> = {
  purchaseDate: "p.purchase_date",
  totalAmount: "p.total_amount",
  dueAmount: "p.due_amount",
  purchaseOrderNumber: "p.purchase_order_number",
};

export async function listPurchases(
  businessId: number,
  query: PurchaseListQuery,
): Promise<PurchaseListPage> {
  // ---- WHERE (row-shaping filters) -------------------------------------
  const conditions: SQL[] = [sql`p.business_id = ${businessId}`];
  // Aggregate-dimension expressions (declared early: the receiving-status
  // tab filter references them for its exclusions).
  const havingConditions: SQL[] = [];
  const returnedSum = sql`COALESCE(SUM(ret.returned_quantity), 0)`;
  const receivedSum = sql`COALESCE(SUM(pi.received_quantity), 0)`;
  const cancelledSum = sql`COALESCE(SUM(pi.cancelled_quantity), 0)`;

  if (query.search) {
    const pattern = `%${query.search}%`;
    // Search scope (Phase 2 §2.4): PO number, supplier name + phone, notes,
    // plus product/SKU/barcode via an EXISTS probe (one hashed subplan per
    // query — no item lines loaded anywhere).
    conditions.push(sql`(
      p.purchase_order_number ILIKE ${pattern}
      OR s.name ILIKE ${pattern}
      OR s.phone ILIKE ${pattern}
      OR p.notes ILIKE ${pattern}
      OR EXISTS (
        SELECT 1
        FROM purchase_items sx
        JOIN product_variants sv ON sv.id = sx.variant_id
        JOIN products sp ON sp.id = sv.product_id
        WHERE sx.purchase_id = p.id
          AND (sv.sku ILIKE ${pattern} OR sv.barcode ILIKE ${pattern} OR sp.name ILIKE ${pattern})
      )
    )`);
  }
  if (query.supplierId !== undefined) {
    conditions.push(sql`p.supplier_id = ${query.supplierId}`);
  }
  if (query.dateFrom !== undefined) {
    conditions.push(sql`p.purchase_date >= ${query.dateFrom}`);
  }
  if (query.dateTo !== undefined) {
    conditions.push(sql`p.purchase_date <= ${query.dateTo}`);
  }
  // Status-dimension filters (receiving/return/cancelled) apply to the
  // DATA page only — the stats CTE keeps the full distribution so tab
  // badges stay stable regardless of the active tab.
  const statsConditions: SQL[] = [...conditions];
  if (query.receivingStatus !== undefined) {
    conditions.push(sql`p.status = ${query.receivingStatus}`);
    // Tab semantics (Phase 2 §2.2): "Received" excludes fully-returned
    // and fully-cancelled orders.
    if (query.receivingStatus === "received") {
      havingConditions.push(
        sql`NOT (${returnedSum} > 0 AND ${returnedSum} >= ${receivedSum})`,
      );
      havingConditions.push(
        sql`NOT (${receivedSum} = 0 AND ${cancelledSum} > 0)`,
      );
    }
  }
  const where = sql.join(conditions, sql` AND `);
  const statsWhere = sql.join(statsConditions, sql` AND `);

  // ---- HAVING (aggregate-dimension filters) -----------------------------
  // The return status and cancellation flag are computed from aggregates,
  // so filtering by them happens after grouping.
  if (query.returnStatus === "Returned") {
    havingConditions.push(
      sql`${returnedSum} > 0 AND ${returnedSum} >= ${receivedSum}`,
    );
  } else if (query.returnStatus === "Partially returned") {
    havingConditions.push(
      sql`${returnedSum} > 0 AND ${returnedSum} < ${receivedSum}`,
    );
  }
  if (query.fullyCancelled !== undefined) {
    const isCancelled = sql`(${receivedSum} = 0 AND ${cancelledSum} > 0)`;
    havingConditions.push(
      query.fullyCancelled === "true"
        ? isCancelled
        : sql`NOT ${isCancelled}`,
    );
  }
  const having =
    havingConditions.length > 0
      ? sql` HAVING ${sql.join(havingConditions, sql` AND `)}`
      : sql``;

  // ---- Stable sort: whitelisted column + unique id tie-breaker ----------
  const sortColumn = SORT_COLUMNS[query.sortBy];
  const direction = query.sortOrder === "asc" ? sql`ASC` : sql`DESC`;
  const orderBy = sql`ORDER BY ${sql.raw(sortColumn)} ${direction}, p.id ${direction}`;
  const limitOffset = sql` LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`;

  const baseWhere = sql`WHERE ${where}`;

  // ---- Data page ---------------------------------------------------------
  const dataResult = await db.execute(sql`
    SELECT
      p.id,
      p.purchase_order_number,
      p.purchase_date,
      p.supplier_id,
      s.name AS supplier_name,
      s.phone AS supplier_phone,
      p.status AS receiving_status,
      p.subtotal,
      p.discount,
      p.tax,
      p.shipping_cost,
      p.total_amount,
      p.paid_amount,
      p.due_amount,
      p.payment_status,
      p.notes,
      p.created_at,
      p.updated_at,
      lc.status AS landed_cost_doc_status,
      lc.pending_allocation_amount AS landed_cost_pending,
      COUNT(pi.id)::int AS total_items,
      COALESCE(SUM(pi.quantity), 0)::float8 AS ordered_quantity,
      COALESCE(SUM(pi.received_quantity), 0)::float8 AS accepted_received_quantity,
      COALESCE(SUM(pi.rejected_quantity), 0)::float8 AS rejected_quantity,
      COALESCE(SUM(pi.cancelled_quantity), 0)::float8 AS cancelled_quantity,
      COALESCE(SUM(GREATEST(pi.quantity - pi.received_quantity - pi.cancelled_quantity, 0)), 0)::float8 AS outstanding_quantity,
      COALESCE(SUM(ret.returned_quantity), 0)::float8 AS returned_quantity,
      CASE
        WHEN COALESCE(SUM(ret.returned_quantity), 0) = 0 THEN NULL
        WHEN COALESCE(SUM(ret.returned_quantity), 0) >= COALESCE(SUM(pi.received_quantity), 0)
          THEN 'Returned'
        ELSE 'Partially returned'
      END AS return_status,
      (
        COALESCE(SUM(pi.received_quantity), 0) = 0
        AND COALESCE(SUM(pi.cancelled_quantity), 0) > 0
      ) AS fully_cancelled
    FROM purchases p
    LEFT JOIN suppliers s ON s.id = p.supplier_id
    LEFT JOIN landed_costs lc
      ON lc.purchase_id = p.id AND lc.business_id = p.business_id
    LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
    LEFT JOIN (
      -- Pre-aggregated per item: joining raw return rows here would fan
      -- out the purchase_items rows and inflate the quantity sums.
      SELECT pri.purchase_item_id, SUM(pri.quantity) AS returned_quantity
      FROM purchase_return_items pri
      WHERE pri.business_id = ${businessId}
      GROUP BY pri.purchase_item_id
    ) ret ON ret.purchase_item_id = pi.id
    ${baseWhere}
    GROUP BY p.id, s.name, s.phone, lc.status, lc.pending_allocation_amount
    ${having}
    ${orderBy}
    ${limitOffset}
  `);

  // ---- Counts + summary: NO pagination, two scopes ----------------------
  // - `distribution` (search/supplier/date scope): the tab badges — stable
  //   regardless of the active receiving/return/cancelled tab.
  // - `filtered` (EVERY active filter): the summary cards reflect exactly
  //   what the user filtered to, but never just the current page.
  const aggregateSelect = sql`
    SELECT
      p.status AS receiving_status,
      p.due_amount,
      COALESCE(SUM(ret.returned_quantity), 0) AS returned_quantity,
      COALESCE(SUM(pi.received_quantity), 0) AS received_quantity,
      COALESCE(SUM(pi.cancelled_quantity), 0) AS cancelled_quantity
    FROM purchases p
    LEFT JOIN suppliers s ON s.id = p.supplier_id
    LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
    LEFT JOIN (
      SELECT pri.purchase_item_id, SUM(pri.quantity) AS returned_quantity
      FROM purchase_return_items pri
      WHERE pri.business_id = ${businessId}
      GROUP BY pri.purchase_item_id
    ) ret ON ret.purchase_item_id = pi.id
  `;

  const statsResult = await db.execute(sql`
    WITH filtered AS (
      ${aggregateSelect}
      WHERE ${where}
      GROUP BY p.id, p.status, p.due_amount
      ${having}
    ),
    distribution AS (
      ${aggregateSelect}
      WHERE ${statsWhere}
      GROUP BY p.id, p.status, p.due_amount
    )
    SELECT
      (SELECT COUNT(*) FROM filtered)::int AS filtered_total,
      (SELECT COUNT(*) FROM filtered WHERE receiving_status <> 'received')::int AS filtered_awaiting,
      (SELECT COALESCE(SUM(due_amount), 0) FROM filtered)::float8 AS filtered_outstanding,
      (SELECT COUNT(*) FROM distribution)::int AS total_items,
      (SELECT COUNT(*) FROM distribution WHERE receiving_status = 'ordered')::int AS ordered,
      (SELECT COUNT(*) FROM distribution WHERE receiving_status = 'partially_received')::int AS partially_received,
      (SELECT COUNT(*) FROM distribution WHERE receiving_status = 'received'
        AND NOT (returned_quantity > 0 AND returned_quantity >= received_quantity)
        AND NOT (received_quantity = 0 AND cancelled_quantity > 0))::int AS received,
      (SELECT COUNT(*) FROM distribution WHERE returned_quantity > 0 AND returned_quantity < received_quantity)::int AS partially_returned,
      (SELECT COUNT(*) FROM distribution WHERE returned_quantity > 0 AND returned_quantity >= received_quantity)::int AS returned,
      (SELECT COUNT(*) FROM distribution WHERE received_quantity = 0 AND cancelled_quantity > 0)::int AS cancelled
  `);

  const dataRows = (dataResult as unknown as { rows: Record<string, unknown>[] })
    .rows;
  const stats = (
    statsResult as unknown as { rows: Record<string, unknown>[] }
  ).rows[0] as Record<string, unknown> | undefined;

  const totalItems = Number(stats?.total_items ?? 0);
  const totalPages = Math.ceil(totalItems / query.pageSize);

  return {
    data: dataRows.map(mapListRow),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      totalItems,
      totalPages,
    },
    counts: {
      all: totalItems,
      ordered: Number(stats?.ordered ?? 0),
      partially_received: Number(stats?.partially_received ?? 0),
      received: Number(stats?.received ?? 0),
      partially_returned: Number(stats?.partially_returned ?? 0),
      returned: Number(stats?.returned ?? 0),
      cancelled: Number(stats?.cancelled ?? 0),
    },
    summary: {
      totalPurchases: Number(stats?.filtered_total ?? 0),
      awaitingReceipt: Number(stats?.filtered_awaiting ?? 0),
      outstandingBalance: Number(stats?.filtered_outstanding ?? 0),
    },
  };
}

function mapListRow(row: Record<string, unknown>): PurchaseListItem {
  const landedCostDocStatus = row.landed_cost_doc_status as string | null;
  const landedCostPending = row.landed_cost_pending as string | null;
  return {
    id: Number(row.id),
    purchaseOrderNumber: String(row.purchase_order_number),
    purchaseDate: String(row.purchase_date),
    supplierId: row.supplier_id === null ? null : Number(row.supplier_id),
    supplierName: (row.supplier_name as string | null) ?? null,
    supplierPhone: (row.supplier_phone as string | null) ?? null,
    receivingStatus: row.receiving_status as PurchaseListItem["receivingStatus"],
    returnStatus: (row.return_status as PurchaseListItem["returnStatus"]) ?? null,
    fullyCancelled: Boolean(row.fully_cancelled),

    totalItems: Number(row.total_items),
    orderedQuantity: Number(row.ordered_quantity),
    acceptedReceivedQuantity: Number(row.accepted_received_quantity),
    rejectedQuantity: Number(row.rejected_quantity),
    cancelledQuantity: Number(row.cancelled_quantity),
    returnedQuantity: Number(row.returned_quantity),
    outstandingQuantity: Number(row.outstanding_quantity),

    subtotal: Number(row.subtotal),
    discount: Number(row.discount),
    tax: Number(row.tax),
    shippingCost: Number(row.shipping_cost),
    landedCostStatus: deriveLandedCostStatus({
      landedCostDocStatus,
      landedCostPending,
    }),

    totalAmount: Number(row.total_amount),
    paidAmount: Number(row.paid_amount),
    dueAmount: Number(row.due_amount),
    paymentStatus: row.payment_status as PurchaseListItem["paymentStatus"],

    notes: (row.notes as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
