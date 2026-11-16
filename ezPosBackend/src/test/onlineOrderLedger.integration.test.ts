/**
 * Flexible Business Operating Model — Phase 4 integration tests: online
 * orders now post to the same double-entry GL as POS sales.
 *
 * Covers: COD confirm → 1040 receivable posting; COD collection at delivery
 * → cash (net of gateway fee) + 5080 fee + 1040 settlement; prepaid
 * (mark-paid) → cash net of fee at the sale posting; books balanced on every
 * entry. Double-guarded like the other suites: plain `npm test` NEVER runs
 * this.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";
import {
  confirmOnlineOrder,
  createOnlineOrder,
  markOnlineOrderPaid,
} from "../modules/commerce/orders.service.js";
import { deliverOrder } from "../modules/commerce/fulfillment.service.js";
import { createOwnerCtx } from "./helpers/fixtures.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("online order GL posting (Phase 4)", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";
  let pg: import("pg").Client | null = null;
  let counter = 0;

  before(async () => {
    const { default: pgDefault } = await import("pg");
    const client = new pgDefault.Client({
      connectionString: process.env.DATABASE_URL,
    });
    await client.connect();
    const db = await client.query("SELECT current_database() AS db");
    if (db.rows[0]?.db !== "ezpos_test") {
      await client.end();
      throw new Error(
        `SAFETY ABORT: connected to "${db.rows[0]?.db}" — integration tests may only run against ezpos_test.`,
      );
    }
    pg = client;
    await ensureRbacSeed();

    const app = buildApp();
    server = app.listen(0);
    const address = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await pg?.end();
  });

  interface OwnerCtx {
    token: string;
    businessId: number;
    userId: number;
    email: string;
  }
  let owner: OwnerCtx;
  let variantId = 0;

  async function api(
    ctx: OwnerCtx,
    method: string,
    path: string,
    payload?: unknown,
  ) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.token}`,
        "X-Business-Id": String(ctx.businessId),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  /** Variant selling at 100 with one stocked batch costing 40/unit. */
  async function seedVariant(businessId: number, qty: number): Promise<number> {
    const location = (await pg!.query(
      "SELECT id FROM locations WHERE business_id = $1 AND is_default = true",
      [businessId],
    )).rows[0] as { id: number } | undefined;
    assert.ok(location, "default location missing (stock source)");
    const product = await pg!.query(
      `INSERT INTO products (business_id, name, product_type, tracking_type, status)
       VALUES ($1, $2, 'physical', 'none', 'active') RETURNING id`,
      [businessId, `GL Product ${Date.now()}-${(counter += 1)}`],
    );
    const variant = await pg!.query(
      `INSERT INTO product_variants (business_id, product_id, sku, selling_price, is_default, status)
       VALUES ($1, $2, $3, 100, true, 'active') RETURNING id`,
      [businessId, product.rows[0]!.id, `SKU-GL-${Date.now()}-${(counter += 1)}`],
    );
    await pg!.query(
      `INSERT INTO inventory_stock (business_id, variant_id, location_id, quantity, reserved_quantity)
       VALUES ($1, $2, $3, $4, 0)`,
      [businessId, variant.rows[0]!.id, location.id, qty],
    );
    await pg!.query(
      `INSERT INTO inventory_batches (business_id, variant_id, location_id, batch_number, purchase_price, quantity_received, quantity_remaining)
       VALUES ($1, $2, $3, $4, 40, $5, $5)`,
      [businessId, variant.rows[0]!.id, location.id, `GLB-${Date.now()}`, qty],
    );
    return variant.rows[0]!.id as number;
  }

  /** Journal lines for one posted entry, joined to the COA codes. */
  async function entryLines(sourceType: string, sourceId: number) {
    const rows = (await pg!.query(
      `SELECT c.code, l.debit, l.credit
         FROM journal_entries je
         JOIN journal_entry_lines l ON l.entry_id = je.id
         JOIN chart_of_accounts c ON c.id = l.account_id
        WHERE je.business_id = $1 AND je.source_type = $2 AND je.source_id = $3
          AND je.status = 'posted'`,
      [owner.businessId, sourceType, sourceId],
    )).rows as { code: string; debit: string; credit: string }[];
    return rows.map((r) => ({
      code: r.code,
      debit: Number(r.debit),
      credit: Number(r.credit),
    }));
  }

  before(async () => {
    owner = (await createOwnerCtx(baseUrl, "Online GL Co")) as OwnerCtx;
    variantId = await seedVariant(owner.businessId, 20);
    // Activate the ledger (cash 10000, inventory at cost, capital plug).
    const activation = await api(owner, "POST", "/api/finance/activation", {
      accounts: [{ name: "Cash Drawer", type: "cash", openingBalance: 10000 }],
      inventoryValue: 800,
      ownerCapital: 10800,
    });
    assert.equal(
      activation.status,
      201,
      JSON.stringify(activation.body),
    );
  });

  it("posts a COD confirmation to 1040 receivable with revenue and COGS", async () => {
    const order = await createOnlineOrder({
      businessId: owner.businessId,
      channel: "custom_storefront",
      integrationId: null,
      externalOrderId: `GL-EXT-${Date.now()}-1`,
      locationId: null,
      customer: { name: "GL Customer", phone: "+8801700000001" },
      lines: [{ variantId, quantity: 1 }],
      idempotencyKey: `gl-cod-${Date.now()}`,
      paymentMethod: "cod",
    });
    await confirmOnlineOrder(owner.businessId, order.saleId);

    const lines = await entryLines("sale", order.saleId);
    const revenue = lines.find((l) => l.code === "4010");
    const ar = lines.find((l) => l.code === "1040");
    const cogs = lines.find((l) => l.code === "5010");
    const inventory = lines.find((l) => l.code === "1050");
    assert.ok(revenue, "4010 revenue line posted");
    assert.equal(revenue.credit, 100);
    assert.ok(ar, "1040 receivable line posted for the COD residual");
    assert.equal(ar.debit, 100);
    assert.ok(cogs, "5010 COGS line posted");
    assert.equal(cogs.debit, 40);
    assert.ok(inventory, "1050 inventory credit posted");
    assert.equal(inventory.credit, 40);

    const debits = lines.reduce((s, l) => s + l.debit, 0);
    const credits = lines.reduce((s, l) => s + l.credit, 0);
    assert.equal(Math.round(debits * 100), Math.round(credits * 100));
  });

  it("settles COD at delivery into cash net of the gateway fee (fee → 5080)", async () => {
    const order = await createOnlineOrder({
      businessId: owner.businessId,
      channel: "custom_storefront",
      integrationId: null,
      externalOrderId: `GL-EXT-${Date.now()}-2`,
      locationId: null,
      customer: { name: "GL Customer 2", phone: "+8801700000002" },
      lines: [{ variantId, quantity: 1 }],
      idempotencyKey: `gl-cod2-${Date.now()}`,
      paymentMethod: "cod",
    });
    await confirmOnlineOrder(owner.businessId, order.saleId);
    // Ship first (delivery requires a recorded shipment flow-wise).
    await pg!.query(
      `INSERT INTO sale_shipments (business_id, sale_id, courier_name, tracking_number, status)
       VALUES ($1, $2, 'Pathao', $3, 'in_transit')`,
      [owner.businessId, order.saleId, `TRK-${Date.now()}`],
    );
    await deliverOrder(owner.businessId, order.saleId, null, {
      codCollected: true,
      codAmount: 100,
      codMethod: "cash",
      codGatewayFee: 10,
    });

    const collectionEntry = (await pg!.query(
      `SELECT je.id FROM journal_entries je
        WHERE je.business_id = $1 AND je.source_type = 'sale_due_collection'
          AND je.memo LIKE '%sale payment%'
        ORDER BY je.id DESC LIMIT 1`,
      [owner.businessId],
    )).rows[0] as { id: number } | undefined;
    assert.ok(collectionEntry, "collection entry posted");

    const rows = (await pg!.query(
      `SELECT c.code, l.debit, l.credit
         FROM journal_entry_lines l
         JOIN chart_of_accounts c ON c.id = l.account_id
        WHERE l.entry_id = $1`,
      [collectionEntry.id],
    )).rows as { code: string; debit: string; credit: string }[];
    const mapped = rows.map((r) => ({
      code: r.code,
      debit: Number(r.debit),
      credit: Number(r.credit),
    }));
    const fee = mapped.find((l) => l.code === "5080");
    const cash = mapped.find((l) => l.code === "1010" || l.code === "1020");
    const ar = mapped.find((l) => l.code === "1040");
    assert.ok(fee, "5080 gateway-fee line posted");
    assert.equal(fee.debit, 10);
    assert.ok(cash, "cash account debited");
    assert.equal(cash.debit, 90);
    assert.ok(ar, "1040 settled");
    assert.equal(ar.credit, 100);
    const debits = mapped.reduce((s, l) => s + l.debit, 0);
    const credits = mapped.reduce((s, l) => s + l.credit, 0);
    assert.equal(Math.round(debits * 100), Math.round(credits * 100));
  });

  it("posts a prepaid (mark-paid) confirmation net of the gateway fee", async () => {
    const order = await createOnlineOrder({
      businessId: owner.businessId,
      channel: "custom_storefront",
      integrationId: null,
      externalOrderId: `GL-EXT-${Date.now()}-3`,
      locationId: null,
      customer: { name: "GL Customer 3", phone: "+8801700000003" },
      lines: [{ variantId, quantity: 1 }],
      idempotencyKey: `gl-prepaid-${Date.now()}`,
      paymentMethod: "cod",
    });
    // Collection on the pending order: the payment row exists before the
    // confirm posting runs, so the sale entry debits cash directly.
    await markOnlineOrderPaid(owner.businessId, order.saleId, {
      method: "card",
      gatewayFee: 5,
    });

    const lines = await entryLines("sale", order.saleId);
    const fee = lines.find((l) => l.code === "5080");
    const ar = lines.find((l) => l.code === "1040");
    const revenue = lines.find((l) => l.code === "4010");
    assert.ok(fee, "5080 fee line posted on the sale entry");
    assert.equal(fee.debit, 5);
    assert.ok(revenue, "4010 posted");
    assert.equal(revenue.credit, 100);
    // Fully paid at confirm → no receivable residual.
    assert.ok(!ar, "no 1040 residual for a fully paid online order");
    const debits = lines.reduce((s, l) => s + l.debit, 0);
    const credits = lines.reduce((s, l) => s + l.credit, 0);
    assert.equal(Math.round(debits * 100), Math.round(credits * 100));
  });
});
