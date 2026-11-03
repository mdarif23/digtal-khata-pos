/**
 * Online Store Profitability (module three) integration tests.
 * Validates the documented calculation policy against the master prompt's
 * §9 worked example:
 *
 *   Net Product Sales 250,000 − COGS 150,000 = Gross Profit 100,000
 *   + 5,000 shipping − 8,000 courier − 4,000 packaging
 *   − 3,000 gateway − 2,000 commission = Net Contribution 88,000
 *
 * COGS comes from real FIFO batch consumption (batches @1,000 and @2,250).
 * Double-guarded like the other suites. Plain `npm test` NEVER runs this.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";
import {
  confirmOnlineOrder,
  createOnlineOrder,
  cancelOnlineOrder,
} from "../modules/commerce/orders.service.js";
import {
  addOrderPackage,
  deliverOrder,
  shipOrder,
} from "../modules/commerce/fulfillment.service.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("online profitability integration", { skip: !runIntegration }, () => {
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
  const uniqueEmail = () =>
    `oprof-${Date.now()}-${(counter += 1)}@example.test`;

  interface Ctx {
    token: string;
    businessId: number;
    userId: number;
    email: string;
  }

  async function api(
    ctx: Ctx,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.token}`,
        "X-Business-Id": String(ctx.businessId),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }

  async function createOwnerCtx(businessName: string): Promise<Ctx> {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Profit Test",
        email,
        password: "strong-password-123",
      }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    const loginBody = (await login.json()) as {
      accessToken: string;
      user: { id: number };
    };
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${loginBody.accessToken}`,
      },
      body: JSON.stringify({ name: businessName }),
    });
    assert.equal(biz.status, 201);
    const bizBody = (await biz.json()) as { business: { id: number } };
    const loc = await fetch(`${baseUrl}/api/locations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${loginBody.accessToken}`,
        "X-Business-Id": String(bizBody.business.id),
      },
      body: JSON.stringify({ name: "Main Store" }),
    });
    assert.equal(loc.status, 201);
    return {
      token: loginBody.accessToken,
      businessId: bizBody.business.id,
      userId: loginBody.user.id,
      email,
    };
  }

  async function seedProfitVariant(businessId: number): Promise<number> {
    counter += 1;
    const location = (await pg!.query(
      "SELECT id FROM locations WHERE business_id = $1 AND is_default = true",
      [businessId],
    )).rows[0] as { id: number } | undefined;
    assert.ok(location, "default location missing");
    const product = await pg!.query(
      `INSERT INTO products (business_id, name, product_type, tracking_type, status)
       VALUES ($1, $2, 'physical', 'batch', 'active') RETURNING id`,
      [businessId, `Profit Product ${counter}`],
    );
    const variant = await pg!.query(
      `INSERT INTO product_variants (business_id, product_id, sku, selling_price, is_default, status)
       VALUES ($1, $2, $3, 2500, true, 'active') RETURNING id`,
      [businessId, product.rows[0]!.id, `PROFSKU-${counter}`],
    );
    const variantId = variant.rows[0]!.id as number;
    // FIFO: batch A (60 @ 1,000) is consumed before batch B (40 @ 2,250).
    await pg!.query(
      `INSERT INTO inventory_batches (business_id, variant_id, location_id, batch_number, purchase_price, quantity_received, quantity_remaining)
       VALUES ($1, $2, $3, $4, 1000, 60, 60)`,
      [businessId, variantId, location.id, `PA-${counter}`],
    );
    await pg!.query(
      `INSERT INTO inventory_batches (business_id, variant_id, location_id, batch_number, purchase_price, quantity_received, quantity_remaining)
       VALUES ($1, $2, $3, $4, 2250, 40, 40)`,
      [businessId, variantId, location.id, `PB-${counter}`],
    );
    await pg!.query(
      `INSERT INTO inventory_stock (business_id, variant_id, location_id, quantity, reserved_quantity)
       VALUES ($1, $2, $3, 100, 0)`,
      [businessId, variantId, location.id],
    );
    return variantId;
  }

  it("reproduces the §9 worked example exactly through the real flow", async () => {
    const owner = await createOwnerCtx("Profit Example Co");
    const variantId = await seedProfitVariant(owner.businessId);

    // Order: 100 × 2,500 = 250,000 product + 5,000 delivery.
    const order = await createOnlineOrder({
      businessId: owner.businessId,
      channel: "custom_storefront",
      integrationId: null,
      externalOrderId: "PROF-1",
      locationId: null,
      customer: { name: "Example Buyer", phone: "01700000009" },
      lines: [{ variantId, quantity: 100 }],
      idempotencyKey: `prof-${Date.now()}-main`,
      paymentMethod: "cod",
      deliveryFee: 5000,
    });

    // COD confirm keeps the sale unpaid; collection is recorded with a fee.
    await confirmOnlineOrder(owner.businessId, order.saleId, {
      paymentMode: "cod",
    });

    // Packaging: two packages, 2,000 each.
    await addOrderPackage(owner.businessId, order.saleId, owner.userId, {
      packageType: "box",
      packingCost: 2000,
    });
    await addOrderPackage(owner.businessId, order.saleId, owner.userId, {
      packageType: "box",
      packingCost: 2000,
    });

    // Courier: 8,000.
    await shipOrder(owner.businessId, order.saleId, owner.userId, {
      courierName: "ProfitCourier",
      trackingNumber: "PC-001",
      shippingCost: 8000,
    });

    // Delivery collects the COD payment: 255,000 collected, 3,000 fee —
    // recorded as a real sale_payments ledger row.
    await deliverOrder(owner.businessId, order.saleId, owner.userId, {
      codCollected: true,
      codMethod: "sslcommerz",
      codGatewayFee: 3000,
    });

    // Marketplace commission 2,000 (set directly — no per-order editor yet).
    await pg!.query(
      "UPDATE sales SET marketplace_commission = 2000 WHERE id = $1",
      [order.saleId],
    );

    const res = await api(
      owner,
      "GET",
      "/api/reports/online-profitability/summary",
    );
    assert.equal(res.status, 200);
    const s = res.body.data;
    assert.equal(s.completedOrders, 1);
    assert.equal(s.grossProductSales, 255000);
    assert.equal(s.discounts, 0);
    assert.equal(s.productRefunds, 0);
    assert.equal(s.netProductSales, 250000);
    assert.equal(s.cogs, 150000); // 60×1,000 + 40×2,250 (real FIFO batches)
    assert.equal(s.grossProfit, 100000);
    assert.equal(s.shippingIncome, 5000);
    assert.equal(s.courierExpense, 8000);
    assert.equal(s.packagingExpense, 4000);
    assert.equal(s.gatewayFees, 3000);
    assert.equal(s.marketplaceCommission, 2000);
    assert.equal(s.netContributionProfit, 88000);
    assert.equal(s.grossMarginPercent, 40);
    assert.equal(s.contributionMarginPercent, 35.2);

    // Channels: one channel row, matching the summary.
    const channels = (
      await api(owner, "GET", "/api/reports/online-profitability/channels")
    ).body.data;
    assert.equal(channels.length, 1);
    assert.equal(channels[0].channel, "custom_storefront");
    assert.equal(channels[0].netContribution, 88000);

    // Products: the variant shows real consumed cost.
    const products = (
      await api(owner, "GET", "/api/reports/online-profitability/products")
    );
    assert.equal(products.status, 200);
    const row = products.body.data.rows[0];
    assert.equal(row.quantitySold, 100);
    assert.equal(row.grossRevenue, 250000);
    assert.equal(row.cogs, 150000);
    assert.equal(row.grossProfit, 100000);
    assert.equal(row.marginPercent, 40);
  });

  it("deducts refunds, excludes cancelled orders, and scopes expenses", async () => {
    const owner = await createOwnerCtx("Profit Refund Co");
    const variantId = await seedProfitVariant(owner.businessId);

    // Completed order: 1 × 2,500.
    const order = await createOnlineOrder({
      businessId: owner.businessId,
      channel: "woocommerce",
      integrationId: null,
      externalOrderId: "PROF-2",
      locationId: null,
      customer: { name: "Refund Buyer" },
      lines: [{ variantId, quantity: 1 }],
      idempotencyKey: `prof-${Date.now()}-refund`,
      paymentMethod: "cod",
    });
    await confirmOnlineOrder(owner.businessId, order.saleId, {
      paymentMode: "cod",
    });
    await deliverOrder(owner.businessId, order.saleId, owner.userId, {
      codCollected: true,
    });

    // Cancelled order must never count as a sale.
    const cancelled = await createOnlineOrder({
      businessId: owner.businessId,
      channel: "woocommerce",
      integrationId: null,
      externalOrderId: "PROF-3",
      locationId: null,
      customer: { name: "Cancelled Buyer" },
      lines: [{ variantId, quantity: 2 }],
      idempotencyKey: `prof-${Date.now()}-cancel`,
      paymentMethod: "cod",
    });

    // Pending order must not count either.
    await createOnlineOrder({
      businessId: owner.businessId,
      channel: "woocommerce",
      integrationId: null,
      externalOrderId: "PROF-4",
      locationId: null,
      customer: { name: "Pending Buyer" },
      lines: [{ variantId, quantity: 1 }],
      idempotencyKey: `prof-${Date.now()}-pending`,
      paymentMethod: "cod",
    });

    const beforeRefund = (
      await api(owner, "GET", "/api/reports/online-profitability/summary")
    ).body.data;
    assert.equal(beforeRefund.completedOrders, 1);
    assert.equal(beforeRefund.cancelledOrders, 0); // cancel happens below
    assert.equal(beforeRefund.netProductSales, 2500);
    assert.equal(beforeRefund.cogs, 1000); // fresh business → FIFO batch A @1,000

    // Cancel the pending order — must never enter the figures.
    await cancelOnlineOrder(owner.businessId, cancelled.saleId);

    // Full refund of the completed order (inspection — no restock).
    const refund = await api(
      owner,
      "POST",
      `/api/sold_products/refunds_all/${order.saleId}`,
      { reason: "customer_request", disposition: "inspection" },
    );
    assert.equal(refund.status, 200);

    const afterRefund = (
      await api(owner, "GET", "/api/reports/online-profitability/summary")
    ).body.data;
    assert.equal(afterRefund.cancelledOrders, 1);
    assert.equal(afterRefund.productRefunds, 2500);
    assert.equal(afterRefund.netProductSales, 0); // revenue − refund, counted once
    assert.equal(afterRefund.grossProfit, -1000); // goods gone (no restock), money back

    // Channel-scoped expenses: woocommerce sees shared + woo; storefront sees shared only.
    await api(owner, "POST", "/api/expenses", {
      title: "Boosted post",
      expense_date: new Date().toISOString().slice(0, 10),
      amount: 500,
      category_id: null,
      payment_method: "Cash",
      channel: "woocommerce",
    });
    await api(owner, "POST", "/api/expenses", {
      title: "Packaging materials (shared)",
      expense_date: new Date().toISOString().slice(0, 10),
      amount: 1000,
      category_id: null,
      payment_method: "Cash",
    });
    const wooExpenses = (
      await api(
        owner,
        "GET",
        "/api/reports/online-profitability/expenses?channel=woocommerce",
      )
    ).body.data;
    assert.equal(wooExpenses.total, 1500);
    const sfExpenses = (
      await api(
        owner,
        "GET",
        "/api/reports/online-profitability/expenses?channel=custom_storefront",
      )
    ).body.data;
    assert.equal(sfExpenses.total, 1000);

    // Trends and products endpoints respond with consistent data.
    const trends = (
      await api(owner, "GET", "/api/reports/online-profitability/trends")
    ).body.data;
    assert.ok(Array.isArray(trends));
    assert.equal(trends.length, 1);
    assert.equal(trends[0].netProductSales, 0);
    const products = (
      await api(owner, "GET", "/api/reports/online-profitability/products")
    ).body.data;
    assert.equal(products.total, 1);
    assert.equal(products.rows[0].returnQuantity, 1);
  });

  it("isolates profitability per business and rejects foreign locations", async () => {
    const ownerA = await createOwnerCtx("Profit Iso A");
    const ownerB = await createOwnerCtx("Profit Iso B");
    await seedProfitVariant(ownerA.businessId);
    const order = await createOnlineOrder({
      businessId: ownerA.businessId,
      channel: "custom_storefront",
      integrationId: null,
      externalOrderId: "PROF-ISO",
      locationId: null,
      customer: { name: "Iso Buyer" },
      lines: [{ variantId: (await pg!.query("SELECT id FROM product_variants WHERE business_id = $1 LIMIT 1", [ownerA.businessId])).rows[0]!.id as number, quantity: 1 }],
      idempotencyKey: `prof-${Date.now()}-iso`,
      paymentMethod: "cod",
    });
    await confirmOnlineOrder(ownerA.businessId, order.saleId, {
      paymentMode: "prepaid",
    });

    const summaryB = (
      await api(ownerB, "GET", "/api/reports/online-profitability/summary")
    ).body.data;
    assert.equal(summaryB.totalOrders, 0);
    assert.equal(summaryB.netProductSales, 0);

    // A's location id is meaningless to B → 404, not data.
    const locationA = (await pg!.query(
      "SELECT id FROM locations WHERE business_id = $1 AND is_default = true",
      [ownerA.businessId],
    )).rows[0] as { id: number };
    const foreignLocation = await api(
      ownerB,
      "GET",
      `/api/reports/online-profitability/summary?locationId=${locationA.id}`,
    );
    assert.equal(foreignLocation.status, 404);
  });
});
