import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, pool } from "../db/schema/index.js";
import { sales } from "../db/schema/sales.js";
import { saleItems } from "../db/schema/saleItems.js";
import { salePayments } from "../db/schema/salePayments.js";
import { customers } from "../db/schema/customers.js";
import { serialNumbers } from "../db/schema/serialNumbers.js";
import { coupons } from "../db/schema/coupons.js";
import { couponRedemptions } from "../db/schema/coupons.js";
import { syncState, syncIdMap } from "../db/schema/sync.js";
import { env } from "../config/env.js";
import { roundMoney } from "../utils/roundMoney.js";

/**
 * LAN sync agent (Phase 2) — runs INSIDE the same backend process when
 * EZPOS_SYNC_ENABLED=true (a cloud deployment never sets it).
 *
 * Sweep = push, then pull:
 *  1. PUSH — the committed sales table IS the durable outbox: every
 *     completed local sale with synced_at IS NULL is rebuilt into an op and
 *     uploaded. Per-op payload idempotency (client sale idempotency key /
 *     customer client_uuid) makes retries and crashes safe — a re-push can
 *     never create a second cloud record. Failed ops stay pending with
 *     sync_attempts incremented; rows are never deleted.
 *  2. PULL — only when nothing is pending (or the push succeeded): identity
 *     snapshot (small tables, full upsert), catalog delta (watermark), full
 *     stock snapshot for this location, customers delta. Pulling stock
 *     BEFORE a successful push would resurrect units the local server
 *     already sold, so the gate is hard.
 *
 * Customers need id mapping (local serial ids ≠ cloud ids): a customer
 * created locally is uploaded first with its client_uuid, the cloud's
 * result records the mapping in sync_id_map, and the NEXT sweep pushes the
 * sale with the cloud customer id. One-sweep latency, never a broken sale.
 *
 * Honest limitation (documented in docs/multi-terminal/): invoice numbers
 * are assigned independently on each server; the idempotency key links a
 * local receipt to its cloud replica, the numbers themselves differ.
 */

const SYNC_SALE_COLUMNS = {
  id: sales.id,
  businessId: sales.businessId,
  customerId: sales.customerId,
  saleDate: sales.saleDate,
  discount: sales.discount,
  vat: sales.vat,
  dueAmount: sales.dueAmount,
  idempotencyKey: sales.idempotencyKey,
  cashierUserId: sales.cashierUserId,
  createdAt: sales.createdAt,
};

// ---------------------------------------------------------------------------
// Cloud client
// ---------------------------------------------------------------------------

export class SyncCloudClient {
  constructor(
    private readonly baseUrl: string,
    private readonly terminalId: number,
    private readonly secret: string,
  ) {}

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.secret}`,
        "X-Terminal-Id": String(this.terminalId),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const message =
        (json as { message?: string } | null)?.message ??
        `cloud ${method} ${path} -> ${res.status}`;
      throw new CloudSyncError(message, res.status);
    }
    return json as T;
  }

  bootstrap() {
    return this.request<{ data: BootstrapSnapshot }>("GET", "/api/sync/bootstrap");
  }
  catalog(since: string | null) {
    const query = since ? `?since=${encodeURIComponent(since)}` : "";
    return this.request<{ data: CatalogDelta }>("GET", `/api/sync/catalog${query}`);
  }
  stock() {
    return this.request<{ data: StockSnapshot }>("GET", "/api/sync/stock");
  }
  customers(since: string | null) {
    const query = since ? `?since=${encodeURIComponent(since)}` : "";
    return this.request<{ data: CustomersDelta }>("GET", `/api/sync/customers${query}`);
  }
  pushOps(ops: unknown[]) {
    return this.request<{ data: { results: PushOpResult[] } }>("POST", "/api/sync/ops", {
      ops,
    });
  }
}

export class CloudSyncError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface BootstrapSnapshot {
  terminal: { id: number; name: string; locationId: number };
  business: Record<string, unknown>;
  locations: Record<string, unknown>[];
  registers?: Record<string, unknown>[];
  users: Record<string, unknown>[];
  roles: Record<string, unknown>[];
  permissions: Record<string, unknown>[];
  rolePermissions: Record<string, unknown>[];
  userRoles: Record<string, unknown>[];
  memberships: Record<string, unknown>[];
  locationAssignments: Record<string, unknown>[];
  plans: Record<string, unknown>[];
  subscription: Record<string, unknown> | null;
  posSettings: Record<string, unknown> | null;
}
export interface CatalogDelta {
  products: Record<string, unknown>[];
  variants: Record<string, unknown>[];
  barcodeAliases: Record<string, unknown>[];
  productTaxes: Record<string, unknown>[];
  taxRates: Record<string, unknown>[];
  categories: Record<string, unknown>[];
  brands: Record<string, unknown>[];
  units: Record<string, unknown>[];
  cursor: string;
}
export interface StockSnapshot {
  locationId: number;
  stock: Record<string, unknown>[];
  batches: Record<string, unknown>[];
  serials: Record<string, unknown>[];
}
export interface CustomersDelta {
  customers: Record<string, unknown>[];
  cursor: string;
}
export interface PushOpResult {
  opId: string;
  status: "applied" | "duplicate" | "failed";
  customerId?: number;
  saleId?: number;
  error?: string;
}

export function cloudClientFromEnv(): SyncCloudClient | null {
  if (!env.syncEnabled || !env.syncCloudUrl || !env.syncTerminalId || !env.syncTerminalSecret) {
    if (env.syncEnabled) {
      console.error(
        "[sync] agent enabled but misconfigured — cloudUrl/terminalId/secret missing",
      );
    }
    return null;
  }
  return new SyncCloudClient(
    env.syncCloudUrl.replace(/\/$/, ""),
    env.syncTerminalId,
    env.syncTerminalSecret,
  );
}

// ---------------------------------------------------------------------------
// Generic upsert machinery (parameterized; explicit column lists — no
// generated columns, no FK-to-sales columns in any synced table)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

interface TableColumn {
  name: string;
  generated: string;
}
const columnCache = new Map<string, TableColumn[]>();

/** Real table columns (generated columns excluded from writes). */
async function tableColumns(table: string): Promise<TableColumn[]> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  const { rows } = await pool.query<{ column_name: string; is_generated: string }>(
    `SELECT column_name, is_generated FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  const columns = rows.map((row) => ({
    name: row.column_name,
    generated: row.is_generated,
  }));
  columnCache.set(table, columns);
  return columns;
}

/**
 * Full-row upsert keyed by the given conflict columns. The column list is
 * derived from information_schema ∩ row keys, so new schema columns ride
 * along automatically and generated columns (landed_cost_per_unit) are
 * never written.
 */
async function upsertRows(
  table: string,
  conflictColumns: string[],
  rows: Row[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const columns = await tableColumns(table);
  const writable = new Set(
    columns.filter((c) => c.generated !== "ALWAYS").map((c) => c.name),
  );
  // Union of row keys that actually exist in the table (snake-cased).
  const keys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const snake = toSnake(key);
      if (writable.has(snake) && !keys.includes(snake)) keys.push(snake);
    }
  }
  if (keys.length === 0) return 0;

  const colSql = keys.map((c) => `"${c}"`).join(", ");
  // Tables whose ONLY columns are the conflict key (role_permissions) have
  // nothing to update — ON CONFLICT DO UPDATE SET <empty> is a syntax
  // error, so those become DO NOTHING.
  const updateSql = keys
    .filter((c) => !conflictColumns.includes(c))
    .map((c) => `"${c}" = EXCLUDED."${c}"`)
    .join(", ");
  let applied = 0;
  const chunkSize = Math.max(1, Math.floor(60000 / Math.max(keys.length, 1)));
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const values: unknown[] = [];
    const tuples = chunk.map((row) => {
      const snakeRow: Record<string, unknown> = {};
      for (const key of Object.keys(row)) snakeRow[toSnake(key)] = row[key];
      const placeholders = keys.map((c) => {
        const value = normalizeValue(snakeRow[c]);
        const index = values.push(value);
        const cast = value !== null && typeof value === "object" ? "::jsonb" : "";
        return `$${index}${cast}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    const conflictTarget = conflictColumns.map((c) => `"${c}"`).join(", ");
    const conflictAction = updateSql
      ? `DO UPDATE SET ${updateSql}`
      : "DO NOTHING";
    const query =
      `INSERT INTO "${table}" (${colSql}) VALUES ${tuples.join(", ")} ` +
      `ON CONFLICT (${conflictTarget}) ${conflictAction}`;
    const result = await pool.query(query, values);
    applied += result.rowCount ?? 0;
  }
  return applied;
}

function normalizeValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

const SERIAL_TABLES = [
  "businesses",
  "locations",
  "users",
  "roles",
  "permissions",
  "user_roles",
  "user_location_assignments",
  "business_memberships",
  "subscription_plans",
  "subscriptions",
  "products",
  "product_variants",
  "variant_barcode_aliases",
  "tax_rates",
  "categories",
  "brands",
  "units",
  "customers",
  "inventory_stock",
  "inventory_batches",
  "serial_numbers",
];

async function setvalAll(): Promise<void> {
  for (const table of SERIAL_TABLES) {
    // Monotonic on purpose: never rewind a sequence below its current
    // last_value. A naive setval(max(id)) races with UNCOMMITTED inserts in
    // concurrent transactions — the seq moves backward, the next insert
    // reuses an in-flight id and dies on the primary key.
    await pool.query(
      `SELECT setval(
         pg_get_serial_sequence('${table}', 'id'),
         GREATEST(
           COALESCE((SELECT MAX(id) FROM "${table}"), 1),
           (SELECT last_value FROM pg_sequences WHERE schemaname='public' AND sequencename = (SELECT regexp_replace(pg_get_serial_sequence('${table}','id'), '.*\\.', '')))
         ),
         true)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

export interface PushOutcome {
  ok: boolean;
  pending: number;
  pushed: number;
  failed: number;
}

export async function pushOnce(
  client: SyncCloudClient,
  agent: AgentMeta,
): Promise<PushOutcome> {
  // Tenant scope is explicit even though a LAN DB normally holds one
  // business — a shared/repurposed local database must never upload
  // another business's transactions.
  const pendingRows = await db
    .select(SYNC_SALE_COLUMNS)
    .from(sales)
    .where(
      and(
        eq(sales.businessId, agent.businessId),
        isNull(sales.syncedAt),
        // 'pos' = normal LAN sales; 'offline' = sales the LAN's own browser
        // terminals recorded via /api/offline/sync — both are LOCAL sales
        // that must reach the cloud. (On the cloud itself the agent never
        // runs, so replicas are never re-pushed.)
        inArray(sales.channel, ["pos", "offline"]),
        eq(sales.status, "completed"),
        sql`${sales.syncAttempts} < ${env.syncMaxAttempts}`,
      ),
    )
    .orderBy(asc(sales.id))
    .limit(200);

  if (pendingRows.length === 0) {
    await recordSyncState("push", { ok: true, pending: 0 });
    return { ok: true, pending: 0, pushed: 0, failed: 0 };
  }

  // Ensure every referenced customer has a client_uuid (SQL-side, one pass).
  await pool.query(
    `UPDATE customers SET client_uuid = gen_random_uuid()
     WHERE client_uuid IS NULL AND business_id = $1 AND id IN (
       SELECT customer_id FROM sales
       WHERE business_id = $1 AND synced_at IS NULL AND customer_id IS NOT NULL
     )`,
    [agent.businessId],
  );

  // Wave 1: customers of pending sales that have no cloud mapping yet.
  const unmappedCustomerIds = new Set<number>();
  for (const sale of pendingRows) {
    if (
      sale.customerId !== null &&
      !(await remoteCustomerId(agent.businessId, sale.customerId))
    ) {
      unmappedCustomerIds.add(sale.customerId);
    }
  }
  const ops: { opId: string; type: string; recordedAt: string; payload: unknown }[] = [];
  const customerOps = new Map<number, string>(); // localId -> opId
  if (unmappedCustomerIds.size > 0) {
    const rows = await db
      .select()
      .from(customers)
      .where(sql`${customers.id} IN (${sql.join([...unmappedCustomerIds].map((id) => sql`${id}`), sql`, `)})`);
    for (const customer of rows) {
      const opId = `cust-${customer.id}-${Date.now()}`;
      customerOps.set(customer.id, opId);
      ops.push({
        opId,
        type: "customer.create",
        recordedAt: new Date().toISOString(),
        payload: {
          clientUuid: customer.clientUuid,
          name: customer.name,
          phone: customer.phone,
          email: customer.email,
          address: customer.address,
        },
      });
    }
  }

  // Wave 2: sale ops for sales whose customers are (now) mapped.
  const saleOpBySaleId = new Map<number, number>();
  for (const sale of pendingRows) {
    const remote =
      sale.customerId !== null
        ? await remoteCustomerId(agent.businessId, sale.customerId)
        : null;
    if (sale.customerId !== null && remote === null) {
      continue; // customer op in flight — next sweep pushes the sale
    }
    const payload = await buildSaleOpPayload(
      sale.businessId,
      sale.id,
      agent,
      remote,
    );
    if (!payload) continue;
    saleOpBySaleId.set(sale.id, ops.length);
    ops.push({
      opId: payload.sale.idempotencyKey,
      type: "sale.create",
      recordedAt: new Date().toISOString(),
      payload,
    });
  }

  if (ops.length === 0) {
    return { ok: true, pending: pendingRows.length, pushed: 0, failed: 0 };
  }

  try {
    const { data } = await client.pushOps(ops);
    let pushed = 0;
    let failed = 0;
    for (const result of data.results) {
      if (result.status === "failed") {
        failed += 1;
        console.error(`[sync] op ${result.opId} failed: ${result.error ?? "unknown"}`);
        await pool.query(
          `UPDATE sales SET sync_attempts = sync_attempts + 1 WHERE id = $1`,
          [saleIdByOpId(saleOpBySaleId, ops, result.opId)],
        );
        continue;
      }
      pushed += 1;
      const customerEntry = [...customerOps.entries()].find(
        ([, opId]) => opId === result.opId,
      );
      if (customerEntry && result.customerId) {
        await db
          .insert(syncIdMap)
          .values({
            businessId: agent.businessId,
            kind: "customer",
            localId: customerEntry[0],
            remoteId: result.customerId,
          })
          .onConflictDoUpdate({
            target: [syncIdMap.businessId, syncIdMap.kind, syncIdMap.localId],
            set: { remoteId: result.customerId },
          });
      }
      const saleId = saleIdByOpId(saleOpBySaleId, ops, result.opId);
      if (saleId !== null && result.status === "applied") {
        await db
          .update(sales)
          .set({ syncedAt: new Date() })
          .where(eq(sales.id, saleId));
      }
    }
    await recordSyncState("push", {
      ok: failed === 0,
      pending: pendingRows.length - pushed,
      ...(failed > 0 ? { error: `${failed} op(s) failed` } : {}),
    });
    return { ok: failed === 0, pending: pendingRows.length - pushed, pushed, failed };
  } catch (err) {
    await recordSyncState("push", {
      ok: false,
      pending: pendingRows.length,
      error: err instanceof Error ? err.message : "push failed",
    });
    return { ok: false, pending: pendingRows.length, pushed: 0, failed: 0 };
  }
}

function saleIdByOpId(
  saleOpBySaleId: Map<number, number>,
  ops: { opId: string }[],
  opId: string,
): number | null {
  const index = ops.findIndex((op) => op.opId === opId);
  if (index < 0) return null;
  for (const [saleId, opIndex] of saleOpBySaleId) {
    if (opIndex === index) return saleId;
  }
  return null;
}

async function remoteCustomerId(
  businessId: number,
  localId: number,
): Promise<number | null> {
  const [row] = await db
    .select({ remoteId: syncIdMap.remoteId })
    .from(syncIdMap)
    .where(
      and(
        eq(syncIdMap.businessId, businessId),
        eq(syncIdMap.kind, "customer"),
        eq(syncIdMap.localId, localId),
      ),
    );
  return row?.remoteId ?? null;
}

/** The op payload mirrors CreateSalePayload; the cloud re-derives every
 * total from trusted DB data, so only quantities, prices, discounts,
 * payments and serials are reconstructed here. */
interface SaleOpPayload {
  locationId: number;
  cashierUserId: number | null;
  terminalName: string;
  sale: {
    saleDate: string;
    customerId: number | null;
    payments: {
      method: string;
      amount: number;
      reference?: string | null;
      tendered?: number | null;
    }[];
    discount: { type: "fixed"; value: number } | null;
    vatPercent: number | null;
    couponCode?: string;
    idempotencyKey: string;
    items: {
      variantId: number;
      quantity: number;
      unitPrice: number;
      discount: { type: "fixed"; value: number } | null;
      serialNumbers?: string[];
    }[];
  };
}

async function buildSaleOpPayload(
  businessId: number,
  saleId: number,
  agent: AgentMeta,
  resolvedCustomerId: number | null,
): Promise<SaleOpPayload | null> {
  const [sale] = await db
    .select(SYNC_SALE_COLUMNS)
    .from(sales)
    .where(eq(sales.id, saleId));
  if (!sale) return null;

  const items = await db
    .select({
      id: saleItems.id,
      variantId: saleItems.variantId,
      quantity: saleItems.quantity,
      sellingPrice: saleItems.sellingPrice,
      discount: saleItems.discount,
    })
    .from(saleItems)
    .where(and(eq(saleItems.businessId, businessId), eq(saleItems.saleId, saleId)));

  const serialsByItem = new Map<number, string[]>();
  const itemIds = items.map((item) => item.id);
  if (itemIds.length > 0) {
    const serialRows = await db
      .select({
        saleItemId: serialNumbers.saleItemId,
        serialNumber: serialNumbers.serialNumber,
      })
      .from(serialNumbers)
      .where(
        and(
          eq(serialNumbers.businessId, businessId),
          inArray(serialNumbers.saleItemId, itemIds),
        ),
      );
    for (const row of serialRows) {
      if (row.saleItemId === null) continue;
      const list = serialsByItem.get(row.saleItemId) ?? [];
      list.push(row.serialNumber);
      serialsByItem.set(row.saleItemId, list);
    }
  }

  const payments = await db
    .select({
      method: salePayments.paymentMethod,
      amount: salePayments.amount,
      reference: salePayments.reference,
      tendered: salePayments.tendered,
    })
    .from(salePayments)
    .where(and(eq(salePayments.businessId, businessId), eq(salePayments.saleId, saleId)));

  const [couponRow] = await db
    .select({ code: coupons.code })
    .from(couponRedemptions)
    .innerJoin(coupons, eq(coupons.id, couponRedemptions.couponId))
    .where(and(eq(couponRedemptions.businessId, businessId), eq(couponRedemptions.saleId, saleId)));

  // Reconstruction: item lines keep their recorded fixed discounts; the
  // cart-level discount is whatever remains of the sale's total discount.
  const itemDiscountSum = items.reduce(
    (sum, item) => sum + Number(item.discount ?? 0),
    0,
  );
  const cartDiscount = roundMoney(
    Math.max(0, Number(sale.discount ?? 0) - itemDiscountSum),
  );
  const cartBase = items.reduce(
    (sum, item) =>
      sum + Number(item.sellingPrice) * item.quantity - Number(item.discount ?? 0),
    0,
  );
  const vat = Number(sale.vat ?? 0);
  const vatPercent =
    vat > 0 && cartBase > 0 ? Math.round((vat / cartBase) * 100000) / 1000 : 0;

  const paymentPayload: SaleOpPayload["sale"]["payments"] = payments.map(
    (payment) => ({
      method: payment.method,
      amount: roundMoney(Number(payment.amount)),
      // reference/tendered are OPTIONAL (string/number) — explicit nulls
      // are rejected by the payload schema.
      ...(payment.reference !== null ? { reference: payment.reference } : {}),
      ...(payment.tendered !== null ? { tendered: Number(payment.tendered) } : {}),
    }),
  );
  if (Number(sale.dueAmount ?? 0) > 0.009) {
    paymentPayload.push({
      method: "due",
      amount: roundMoney(Number(sale.dueAmount)),
      reference: null,
      tendered: null,
    });
  }

  return {
    locationId: agent.locationId,
    cashierUserId: sale.cashierUserId,
    terminalName: agent.name,
    sale: {
      saleDate: (sale.saleDate ?? sale.createdAt ?? new Date()).toISOString(),
      customerId: resolvedCustomerId,
      payments: paymentPayload,
      discount: cartDiscount > 0 ? { type: "fixed", value: cartDiscount } : null,
      vatPercent,
      ...(couponRow?.code ? { couponCode: couponRow.code } : {}),
      idempotencyKey: sale.idempotencyKey ?? `lan-${saleId}`,
      items: items.map((item) => {
        const serials = serialsByItem.get(item.id);
        return {
          variantId: item.variantId,
          quantity: item.quantity,
          unitPrice: Number(item.sellingPrice),
          discount:
            Number(item.discount ?? 0) > 0
              ? { type: "fixed" as const, value: roundMoney(Number(item.discount)) }
              : null,
          ...(serials && serials.length > 0 ? { serialNumbers: serials } : {}),
        };
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

async function pullBootstrap(client: SyncCloudClient): Promise<void> {
  const { data } = await client.bootstrap();
  // FK-ordered: users first (businesses.created_by_user_id references
  // them), then roles/permissions, then the business, its locations and
  // registers, and finally the membership/plan graphs.
  await upsertRows("users", ["id"], data.users);
  await upsertRows("permissions", ["id"], data.permissions);
  await upsertRows("businesses", ["id"], [data.business]);
  await upsertRows("roles", ["id"], data.roles);
  await upsertRows("role_permissions", ["role_id", "permission_id"], data.rolePermissions);
  await upsertRows("locations", ["id"], data.locations);
  if (data.registers) {
    await upsertRows("registers", ["id"], data.registers);
  }
  await upsertRows("user_roles", ["id"], data.userRoles);
  await upsertRows("business_memberships", ["id"], data.memberships);
  await upsertRows("user_location_assignments", ["id"], data.locationAssignments);
  await upsertRows("subscription_plans", ["id"], data.plans);
  if (data.subscription) {
    await upsertRows("subscriptions", ["id"], [data.subscription]);
  }
  if (data.posSettings) {
    await upsertRows("pos_settings", ["business_id"], [data.posSettings]);
  }
  await setvalAll();
  await recordSyncState("identity", { pulled: true });
  const agentMetaJson = JSON.stringify({
    businessId: data.business.id as number,
    locationId: data.terminal.locationId,
    name: data.terminal.name,
  });
  await db
    .insert(syncState)
    .values({ stream: "agent", cursor: agentMetaJson })
    .onConflictDoUpdate({ target: syncState.stream, set: { cursor: agentMetaJson } });
}

async function pullCatalog(client: SyncCloudClient): Promise<void> {
  const [state] = await db
    .select({ cursor: syncState.cursor })
    .from(syncState)
    .where(eq(syncState.stream, "catalog"));
  const { data } = await client.catalog(state?.cursor ?? null);
  await upsertRows("categories", ["id"], data.categories);
  await upsertRows("brands", ["id"], data.brands);
  await upsertRows("units", ["id"], data.units);
  await upsertRows("tax_rates", ["id"], data.taxRates);
  await upsertRows("products", ["id"], data.products);
  await upsertRows("product_variants", ["id"], data.variants);
  await upsertRows("variant_barcode_aliases", ["id"], data.barcodeAliases);
  await upsertRows("product_taxes", ["product_id", "tax_rate_id"], data.productTaxes);
  await setvalAll();
  await recordSyncState("catalog", { cursor: data.cursor });
}

async function pullStock(client: SyncCloudClient): Promise<void> {
  const { data } = await client.stock();
  await upsertRows(
    "inventory_stock",
    ["business_id", "variant_id", "location_id"],
    data.stock,
  );
  // landed_cost_per_unit is GENERATED — information_schema keeps it out.
  await upsertRows("inventory_batches", ["id"], data.batches);
  await upsertRows(
    "serial_numbers",
    ["business_id", "serial_number"],
    data.serials,
  );
  await setvalAll();
  await recordSyncState("stock", { pulled: true });
}

async function pullCustomers(client: SyncCloudClient): Promise<void> {
  const [state] = await db
    .select({ cursor: syncState.cursor })
    .from(syncState)
    .where(eq(syncState.stream, "customers"));
  const { data } = await client.customers(state?.cursor ?? null);
  await upsertRows("customers", ["id"], data.customers);
  await setvalAll();
  await recordSyncState("customers", { cursor: data.cursor });
}

async function recordSyncState(
  stream: string,
  update: { cursor?: string; ok?: boolean; pulled?: boolean; pending?: number; error?: string },
): Promise<void> {
  await db
    .insert(syncState)
    .values({
      stream,
      cursor: update.cursor ?? null,
      lastPushAt: stream === "push" ? new Date() : null,
      lastPullAt: update.pulled ? new Date() : null,
      lastError: update.error ?? null,
    })
    .onConflictDoUpdate({
      target: syncState.stream,
      set: {
        ...(update.cursor !== undefined ? { cursor: update.cursor } : {}),
        ...(stream === "push" ? { lastPushAt: new Date() } : {}),
        ...(update.pulled ? { lastPullAt: new Date() } : {}),
        lastError: update.error ?? null,
        updatedAt: new Date(),
      },
    });
}

// ---------------------------------------------------------------------------
// Sweep loop
// ---------------------------------------------------------------------------

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

export function isSyncEnabled(): boolean {
  return env.syncEnabled;
}

export function startSyncAgent(): void {
  const client = cloudClientFromEnv();
  if (!client) return;
  if (sweepTimer) return;
  console.log(
    `[sync] agent started — cloud=${env.syncCloudUrl} terminal=${env.syncTerminalId} secretLen=${env.syncTerminalSecret.length}`,
  );
  const intervalMs = Math.max(15, env.syncIntervalSeconds) * 1000;
  void runSweep(client).catch((err) => {
    console.error("[sync] sweep failed:", err);
  });
  sweepTimer = setInterval(() => {
    void runSweep(client).catch((err) => {
      console.error("[sync] sweep failed:", err);
    });
  }, intervalMs);
}

export function stopSyncAgent(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

export async function runSweep(client: SyncCloudClient): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    // Bootstrap first: it carries this terminal's location (push needs it)
    // and upserts identity only — no stock, so it cannot violate the gate.
    await pullBootstrap(client);
    const agent = await agentMeta();
    if (!agent) return;
    const push = await pushOnce(client, agent);
    // Hard gate: never pull catalog/stock while local sales are not yet
    // uploaded — the stock snapshot would resurrect sold units.
    if (push.ok && push.pending === 0) {
      await pullCatalog(client);
      await pullStock(client);
      await pullCustomers(client);
    }
  } finally {
    sweeping = false;
  }
}

interface AgentMeta {
  businessId: number;
  locationId: number;
  name: string;
}

async function agentMeta(): Promise<AgentMeta | null> {
  const [row] = await db
    .select({ cursor: syncState.cursor })
    .from(syncState)
    .where(eq(syncState.stream, "agent"));
  if (!row?.cursor) return null;
  try {
    return JSON.parse(row.cursor) as AgentMeta;
  } catch {
    return null;
  }
}
