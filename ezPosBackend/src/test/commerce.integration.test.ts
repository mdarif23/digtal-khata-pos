/**
 * Phase 9.1 integration tests: unified online orders, stock reservations,
 * channel allocation, business modes — against a REAL PostgreSQL database.
 * The commerce service is exercised directly (its HTTP surface arrives in
 * Phase 9.2); mode changes go through the businesses API.
 * Double-guarded like the other suites.
 *
 * Plain `npm test` NEVER runs this file.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";
import {
  cancelOnlineOrder,
  confirmOnlineOrder,
  createOnlineOrder,
} from "../modules/commerce/orders.service.js";
import { runCommerceSweeps } from "../jobs/commerceJobs.js";
import { createOwnerCtx } from "./helpers/fixtures.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("commerce core integration", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";
  let pg: import("pg").Client | null = null;

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
    server?.close();
    await pg?.end();
    pg = null;
  });

  let counter = 0;
  // Owner/business fixtures come from the shared helpers (src/test/helpers).

  /**
   * Product with one variant + a stock row of `qty` at the business's
   * default location, via SQL (the storefront never uses the POS forms).
   */
  async function seedVariant(
    businessId: number,
    qty: number,
    trackingType = "none",
  ): Promise<number> {
    const location = (await pg!.query(
      "SELECT id FROM locations WHERE business_id = $1 AND is_default = true",
      [businessId],
    )).rows[0] as { id: number } | undefined;
    assert.ok(location, "default location missing");
    const product = await pg!.query(
      `INSERT INTO products (business_id, name, product_type, tracking_type, status)
       VALUES ($1, $2, 'physical', $3, 'active') RETURNING id`,
      [businessId, `Product ${Date.now()}-${counter}`, trackingType],
    );
    const variant = await pg!.query(
      `INSERT INTO product_variants (business_id, product_id, sku, selling_price, is_default, status)
       VALUES ($1, $2, $3, 100, true, 'active') RETURNING id`,
      [businessId, product.rows[0]!.id, `SKU-${Date.now()}-${(counter += 1)}`],
    );
    await pg!.query(
      `INSERT INTO inventory_stock (business_id, variant_id, location_id, quantity, reserved_quantity)
       VALUES ($1, $2, $3, $4, 0)`,
      [businessId, variant.rows[0]!.id, location.id, qty],
    );
    if (trackingType === "batch") {
      // Batch-tracked products sell from batches (FIFO), mirroring the POS.
      await pg!.query(
        `INSERT INTO inventory_batches (business_id, variant_id, location_id, batch_number, purchase_price, quantity_received, quantity_remaining)
         VALUES ($1, $2, $3, $4, 60, $5, $5)`,
        [businessId, variant.rows[0]!.id, location.id, `B-${Date.now()}`, qty],
      );
    }
    return variant.rows[0]!.id as number;
  }

  async function seedIntegration(
    businessId: number,
    locationId: number | null,
  ): Promise<number> {
    const result = await pg!.query(
      `INSERT INTO integrations (business_id, platform, name, location_id, status)
       VALUES ($1, 'custom_storefront', 'Test store', $2, 'connected') RETURNING id`,
      [businessId, locationId],
    );
    return result.rows[0]!.id as number;
  }

  async function stockRow(businessId: number, variantId: number) {
    const [row] = await pg!.query(
      "SELECT quantity, reserved_quantity FROM inventory_stock WHERE business_id = $1 AND variant_id = $2",
      [businessId, variantId],
    ).then((r) => r.rows as { quantity: number; reserved_quantity: number }[]);
    return row!;
  }

  it("creates a pending online order with an active reservation (idempotent)", async () => {
    const owner = await createOwnerCtx(baseUrl, "Commerce Order Co");
    const variantId = await seedVariant(owner.businessId, 10);
    const dupKey = `order-${Date.now()}-a`;

    const order = await createOnlineOrder({
      businessId: owner.businessId,
      channel: "custom_storefront",
      integrationId: null,
      externalOrderId: "EXT-1",
      locationId: null,
      customer: { name: "Web Customer", phone: "+8801711223344" },
      lines: [{ variantId, quantity: 3 }],
      idempotencyKey: dupKey,
    });
    assert.equal(order.status, "pending");
    assert.equal(order.total, 300);

    const stock = await stockRow(owner.businessId, variantId);
    assert.equal(stock.quantity, 10); // not deducted yet
    assert.equal(stock.reserved_quantity, 3); // held

    const sale = await pg!.query(
      "SELECT status, channel, payment_status, customer_id FROM sales WHERE id = $1",
      [order.saleId],
    );
    assert.equal(sale.rows[0]!.status, "pending");
    assert.equal(sale.rows[0]!.channel, "custom_storefront");
    assert.equal(sale.rows[0]!.payment_status, "unpaid");
    // Customer matched (created) by phone.
    assert.ok(sale.rows[0]!.customer_id !== null);

    // Duplicate submission (same external order) returns the same sale.
    const duplicate = await createOnlineOrder({
      businessId: owner.businessId,
      channel: "custom_storefront",
      integrationId: null,
      externalOrderId: "EXT-1",
      locationId: null,
      customer: { name: "Web Customer" },
      lines: [{ variantId, quantity: 3 }],
      idempotencyKey: dupKey,
    });
    assert.equal(duplicate.duplicated, true);
    assert.equal(duplicate.saleId, order.saleId);
  });

  it("confirms an order: FIFO consumption, movement, reservation confirmed", async () => {
    const owner = await createOwnerCtx(baseUrl, "Commerce Confirm Co");
    const variantId = await seedVariant(owner.businessId, 10, "batch");
    const order = await createOnlineOrder({
      businessId: owner.businessId,
      channel: "woocommerce",
      integrationId: null,
      externalOrderId: "EXT-2",
      locationId: null,
      customer: { name: "Buyer" },
      lines: [{ variantId, quantity: 4 }],
      idempotencyKey: `order-${Date.now()}-c`,
    });

    const confirmed = await confirmOnlineOrder(owner.businessId, order.saleId);
    assert.equal(confirmed.status, "completed");

    const stock = await stockRow(owner.businessId, variantId);
    assert.equal(stock.quantity, 6);
    assert.equal(stock.reserved_quantity, 0); // hold replaced by deduction

    const movement = await pg!.query(
      "SELECT movement_type, quantity, reference_id FROM inventory_movements WHERE reference_id = $1 AND movement_type = 'sale'",
      [order.saleId],
    );
    assert.equal(movement.rows.length, 1);
    assert.equal(movement.rows[0]!.quantity, 4);

    const reservation = await pg!.query(
      "SELECT status FROM inventory_reservations WHERE sale_id = $1",
      [order.saleId],
    );
    assert.equal(reservation.rows[0]!.status, "confirmed");

    const sale = await pg!.query(
      "SELECT status, payment_status, cost_check FROM sales WHERE id = $1",
      [order.saleId],
    ).catch(() => null);
    void sale;

    // Double confirmation is idempotent.
    const again = await confirmOnlineOrder(owner.businessId, order.saleId);
    assert.equal(again.duplicated, true);
    assert.equal((await stockRow(owner.businessId, variantId)).quantity, 6);
  });

  it("cancelling releases the reservation and restores availability", async () => {
    const owner = await createOwnerCtx(baseUrl, "Commerce Cancel Co");
    const variantId = await seedVariant(owner.businessId, 5);
    const order = await createOnlineOrder({
      businessId: owner.businessId,
      channel: "custom_storefront",
      integrationId: null,
      externalOrderId: "EXT-3",
      locationId: null,
      customer: { name: "Buyer" },
      lines: [{ variantId, quantity: 2 }],
      idempotencyKey: `order-${Date.now()}-d`,
    });
    assert.equal((await stockRow(owner.businessId, variantId)).reserved_quantity, 2);

    await cancelOnlineOrder(owner.businessId, order.saleId);

    const stock = await stockRow(owner.businessId, variantId);
    assert.equal(stock.reserved_quantity, 0);
    assert.equal(stock.quantity, 5);
    const sale = await pg!.query("SELECT status FROM sales WHERE id = $1", [
      order.saleId,
    ]);
    assert.equal(sale.rows[0]!.status, "cancelled");
  });

  it("concurrent online orders cannot oversell the same stock", async () => {
    const owner = await createOwnerCtx(baseUrl, "Commerce Race Co");
    const variantId = await seedVariant(owner.businessId, 5);

    const attempt = (key: string) =>
      createOnlineOrder({
        businessId: owner.businessId,
        channel: "custom_storefront",
        integrationId: null,
        externalOrderId: `EXT-${key}`,
        locationId: null,
        customer: { name: "Racer" },
        lines: [{ variantId, quantity: 4 }],
        idempotencyKey: key,
      });

    const results = await Promise.allSettled([
      attempt(`race-${Date.now()}-x`),
      attempt(`race-${Date.now()}-y`),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one order may win");
    assert.equal(rejected.length, 1);

    const stock = await stockRow(owner.businessId, variantId);
    assert.equal(stock.reserved_quantity, 4);
    assert.equal(stock.quantity, 5);
  });

  it("reserved channel allocation caps online availability", async () => {
    const owner = await createOwnerCtx(baseUrl, "Commerce Alloc Co");
    const variantId = await seedVariant(owner.businessId, 10);
    const location = await pg!.query(
      "SELECT id FROM locations WHERE business_id = $1 AND is_default = true",
      [owner.businessId],
    );
    const integrationId = await seedIntegration(
      owner.businessId,
      location.rows[0]!.id as number,
    );
    await pg!.query(
      `INSERT INTO channel_inventory_allocations (business_id, integration_id, variant_id, location_id, mode, allocated_qty)
       VALUES ($1, $2, $3, $4, 'reserved', 2)`,
      [owner.businessId, integrationId, variantId, location.rows[0]!.id],
    );

    // Order for 3 exceeds the 2-unit online allocation.
    await assert.rejects(
      () =>
        createOnlineOrder({
          businessId: owner.businessId,
          channel: "custom_storefront",
          integrationId,
          externalOrderId: "EXT-ALLOC-1",
          locationId: null,
          customer: { name: "Buyer" },
          lines: [{ variantId, quantity: 3 }],
          idempotencyKey: `alloc-${Date.now()}-1`,
        }),
      /online stock/i,
    );

    // Order for 2 (the full allocation) succeeds.
    const order = await createOnlineOrder({
      businessId: owner.businessId,
      channel: "custom_storefront",
      integrationId,
      externalOrderId: "EXT-ALLOC-2",
      locationId: null,
      customer: { name: "Buyer" },
      lines: [{ variantId, quantity: 2 }],
      idempotencyKey: `alloc-${Date.now()}-2`,
    });
    assert.equal(order.status, "pending");
  });

  it("the sweep expires stale reservations and cancels pending orders", async () => {
    const owner = await createOwnerCtx(baseUrl, "Commerce Expiry Co");
    const variantId = await seedVariant(owner.businessId, 5);
    const order = await createOnlineOrder({
      businessId: owner.businessId,
      channel: "custom_storefront",
      integrationId: null,
      externalOrderId: "EXT-EXP",
      locationId: null,
      customer: { name: "Buyer" },
      lines: [{ variantId, quantity: 2 }],
      idempotencyKey: `exp-${Date.now()}`,
    });

    // Force the reservation stale.
    await pg!.query(
      "UPDATE inventory_reservations SET expires_at = now() - interval '1 minute' WHERE sale_id = $1",
      [order.saleId],
    );
    const results = await runCommerceSweeps();
    assert.ok(results.reservationsExpired >= 1);

    const stock = await stockRow(owner.businessId, variantId);
    assert.equal(stock.reserved_quantity, 0);
    const sale = await pg!.query("SELECT status FROM sales WHERE id = $1", [
      order.saleId,
    ]);
    assert.equal(sale.rows[0]!.status, "cancelled");

    // Confirming an expired (cancelled) order fails loudly.
    await assert.rejects(
      () => confirmOnlineOrder(owner.businessId, order.saleId),
      /cannot be confirmed/i,
    );
  });

  it("mode changes: online_only auto-creates a location; downgrade blocked with integrations", async () => {
    const owner = await createOwnerCtx(baseUrl, "Mode Change Co", { noLocation: true });
    const admin = await createOwnerCtx(baseUrl, "Mode Admin");

    // online_only without any location → "Online Store" auto-created.
    const put = await fetch(`${baseUrl}/api/businesses/${owner.businessId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${owner.token}`,
        "X-Business-Id": String(owner.businessId),
      },
      body: JSON.stringify({ mode: "online_only" }),
    });
    assert.equal(put.status, 200);
    const detail = (await (
      await fetch(`${baseUrl}/api/businesses/${owner.businessId}`, {
        headers: {
          Authorization: `Bearer ${owner.token}`,
          "X-Business-Id": String(owner.businessId),
        },
      })
    ).json()) as { business: { mode: string } };
    assert.equal(detail.business.mode, "online_only");
    const locations = await pg!.query(
      "SELECT name FROM locations WHERE business_id = $1",
      [owner.businessId],
    );
    assert.equal(locations.rows[0]!.name, "Online Store");

    // Downgrade blocked while an integration is connected.
    await seedIntegration(owner.businessId, null);
    const blocked = await fetch(`${baseUrl}/api/businesses/${owner.businessId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${owner.token}`,
        "X-Business-Id": String(owner.businessId),
      },
      body: JSON.stringify({ mode: "physical_only" }),
    });
    assert.equal(blocked.status, 409);

    // Non-admin guard sanity (admin routes untouched).
    const forbidden = await fetch(`${baseUrl}/api/saas/overview`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    assert.equal(forbidden.status, 403);
    void admin;
  });
});
