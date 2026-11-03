/**
 * Online order management & fulfillment (module two) integration tests:
 * workflow transitions, packaging, shipping, delivery with COD collection,
 * order timeline, return states and tenant isolation.
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
  confirmOnlineOrder,
  createOnlineOrder,
} from "../modules/commerce/orders.service.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("online order fulfillment integration", { skip: !runIntegration }, () => {
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
    `oful-${Date.now()}-${(counter += 1)}@example.test`;

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
        fullName: "Fulfillment Test",
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

  async function seedVariant(
    businessId: number,
    qty: number,
  ): Promise<number> {
    counter += 1;
    const location = (await pg!.query(
      "SELECT id FROM locations WHERE business_id = $1 AND is_default = true",
      [businessId],
    )).rows[0] as { id: number } | undefined;
    assert.ok(location, "default location missing");
    const product = await pg!.query(
      `INSERT INTO products (business_id, name, product_type, tracking_type, status,
         shipping_weight_kg, packaging_instructions, handling_instructions, is_fragile)
       VALUES ($1, $2, 'physical', 'batch', 'active', 2.5, 'Bubble-wrap the unit', 'Keep upright', true)
       RETURNING id`,
      [businessId, `OF Product ${counter}`],
    );
    const variant = await pg!.query(
      `INSERT INTO product_variants (business_id, product_id, sku, selling_price, is_default, status)
       VALUES ($1, $2, $3, 200, true, 'active') RETURNING id`,
      [businessId, product.rows[0]!.id, `OFSKU-${counter}`],
    );
    await pg!.query(
      `INSERT INTO inventory_stock (business_id, variant_id, location_id, quantity, reserved_quantity)
       VALUES ($1, $2, $3, $4, 0)`,
      [businessId, variant.rows[0]!.id, location.id, qty],
    );
    await pg!.query(
      `INSERT INTO inventory_batches (business_id, variant_id, location_id, batch_number, purchase_price, quantity_received, quantity_remaining)
       VALUES ($1, $2, $3, $4, 120, $5, $5)`,
      [businessId, variant.rows[0]!.id, location.id, `OFB-${counter}`, qty],
    );
    return variant.rows[0]!.id as number;
  }

  const ordersPath = (bizId: number) =>
    `/api/businesses/${bizId}/orders`;

  async function saleRow(businessId: number, saleId: number) {
    const r = await pg!.query(
      "SELECT status, payment_status, fulfillment_status, due_amount FROM sales WHERE id = $1 AND business_id = $2",
      [saleId, businessId],
    );
    return r.rows[0] as
      | {
          status: string;
          payment_status: string;
          fulfillment_status: string;
          due_amount: string;
        }
      | undefined;
  }

  async function createCodOrder(
    owner: Ctx,
    variantId: number,
    tag: string,
  ): Promise<number> {
    const order = await createOnlineOrder({
      businessId: owner.businessId,
      channel: "custom_storefront",
      integrationId: null,
      externalOrderId: `EXT-${tag}`,
      locationId: null,
      customer: {
        name: "COD Buyer",
        phone: "01700000001",
        address: "12/A Test Road",
      },
      shippingName: "COD Buyer",
      shippingPhone: "01700000001",
      shippingAddress: "12/A Test Road",
      shippingCity: "Dhaka",
      shippingArea: "Banani",
      deliveryInstructions: "Call before delivery",
      lines: [{ variantId, quantity: 2 }],
      idempotencyKey: `order-${Date.now()}-${tag}`,
      paymentMethod: "cod",
    });
    assert.equal(order.duplicated, false);
    return order.saleId;
  }

  it("runs the full COD workflow: create → confirm(unpaid) → process → pack → ready → ship → deliver(collect)", async () => {
    const owner = await createOwnerCtx("Fulfillment Flow Co");
    const variantId = await seedVariant(owner.businessId, 10);

    // --- create with shipping snapshot + timeline
    const saleId = await createCodOrder(owner, variantId, "flow");
    const created = (await pg!.query(
      "SELECT shipping_name, shipping_city, delivery_instructions, payment_status, fulfillment_status FROM sales WHERE id = $1",
      [saleId],
    )).rows[0] as any;
    assert.equal(created.shipping_name, "COD Buyer");
    assert.equal(created.shipping_city, "Dhaka");
    assert.equal(created.delivery_instructions, "Call before delivery");
    assert.equal(created.payment_status, "unpaid");

    let timeline = (
      await api(owner, "GET", `${ordersPath(owner.businessId)}/${saleId}/timeline`)
    ).body.data as any[];
    assert.equal(timeline[0]!.eventType, "created");
    assert.equal(timeline[0]!.actorType, "integration");

    // --- COD confirm: stock consumed, sale stays UNPAID
    await confirmOnlineOrder(owner.businessId, saleId, { paymentMode: "cod" });
    let sale = await saleRow(owner.businessId, saleId);
    assert.equal(sale!.status, "completed");
    assert.equal(sale!.payment_status, "unpaid", "COD confirm must not mark paid");
    assert.equal(sale!.fulfillment_status, "confirmed");
    assert.ok(Number(sale!.due_amount) > 0);

    // --- start processing
    const proc = await api(
      owner,
      "POST",
      `${ordersPath(owner.businessId)}/${saleId}/start-processing`,
    );
    assert.equal(proc.status, 200);
    assert.equal((await saleRow(owner.businessId, saleId))!.fulfillment_status, "processing");

    // --- packaging defaults from the product
    const defaults = (
      await api(
        owner,
        "GET",
        `${ordersPath(owner.businessId)}/${saleId}/packaging-defaults`,
      )
    ).body.data as any;
    assert.equal(defaults.totalWeightKg, 5); // 2.5 kg × qty 2
    assert.equal(defaults.isFragile, true);
    assert.deepEqual(defaults.packagingInstructions, ["Bubble-wrap the unit"]);

    // --- packages
    const pkg = await api(
      owner,
      "POST",
      `${ordersPath(owner.businessId)}/${saleId}/packages`,
      { packageType: "box", weightKg: 5.2, packingCost: 40, materialsNote: "2 boxes" },
    );
    assert.equal(pkg.status, 201);
    assert.equal(pkg.body.data.packageNo, 1);

    // --- ready-to-ship (packages exist)
    const rts = await api(
      owner,
      "POST",
      `${ordersPath(owner.businessId)}/${saleId}/ready-to-ship`,
    );
    assert.equal(rts.status, 200);
    assert.equal((await saleRow(owner.businessId, saleId))!.fulfillment_status, "ready_to_ship");

    // --- ship validation: missing courier → 400
    const badShip = await api(
      owner,
      "POST",
      `${ordersPath(owner.businessId)}/${saleId}/ship`,
      { trackingNumber: "TRK-1" },
    );
    assert.equal(badShip.status, 400);

    // --- ship
    const ship = await api(
      owner,
      "POST",
      `${ordersPath(owner.businessId)}/${saleId}/ship`,
      {
        courierName: "Steadfast",
        courierService: "Same day",
        trackingNumber: "STF-778899",
        shippingCost: 130,
      },
    );
    assert.equal(ship.status, 200);
    sale = await saleRow(owner.businessId, saleId);
    assert.equal(sale!.fulfillment_status, "shipped");
    assert.equal(sale!.payment_status, "unpaid", "shipping must not mark COD paid");
    const shipment = (await pg!.query(
      "SELECT courier_name, tracking_number, shipping_cost, status FROM sale_shipments WHERE sale_id = $1",
      [saleId],
    )).rows[0] as any;
    assert.equal(shipment.courier_name, "Steadfast");
    assert.equal(shipment.tracking_number, "STF-778899");
    assert.equal(Number(shipment.shipping_cost), 130);
    assert.equal(shipment.status, "in_transit");

    // --- deliver + COD collection → ledger row + paid
    const deliver = await api(
      owner,
      "POST",
      `${ordersPath(owner.businessId)}/${saleId}/deliver`,
      { codCollected: true, codMethod: "cash" },
    );
    assert.equal(deliver.status, 200);
    sale = await saleRow(owner.businessId, saleId);
    assert.equal(sale!.fulfillment_status, "delivered");
    assert.equal(sale!.payment_status, "paid");
    assert.equal(Number(sale!.due_amount), 0);
    const payment = (await pg!.query(
      "SELECT payment_method, amount, notes FROM sale_payments WHERE sale_id = $1",
      [saleId],
    )).rows[0] as any;
    assert.equal(payment.payment_method, "cash");
    assert.equal(Number(payment.amount), 400); // 200 × 2

    // --- timeline covers the whole workflow in order
    timeline = (
      await api(owner, "GET", `${ordersPath(owner.businessId)}/${saleId}/timeline`)
    ).body.data as any[];
    const eventTypes = timeline.map((e) => e.eventType);
    assert.deepEqual(eventTypes, [
      "created",
      "confirmed",
      "processing",
      "package_added",
      "ready_to_ship",
      "courier_assigned",
      "shipped",
      "delivered",
      "payment_recorded",
    ]);
  });

  it("rejects invalid transitions and ready-to-ship without packages", async () => {
    const owner = await createOwnerCtx("Fulfillment Guard Co");
    const variantId = await seedVariant(owner.businessId, 5);
    const saleId = await createCodOrder(owner, variantId, "guard");
    await confirmOnlineOrder(owner.businessId, saleId, { paymentMode: "cod" });

    // Backward move: processing → confirmed is rejected.
    await api(owner, "POST", `${ordersPath(owner.businessId)}/${saleId}/start-processing`);
    const back = await api(
      owner,
      "POST",
      `${ordersPath(owner.businessId)}/${saleId}/fulfillment`,
      { status: "confirmed" },
    );
    assert.equal(back.status, 409);

    // Ready-to-ship without any package is rejected.
    const saleId2 = await createCodOrder(owner, variantId, "guard2");
    await confirmOnlineOrder(owner.businessId, saleId2, { paymentMode: "cod" });
    const rts = await api(
      owner,
      "POST",
      `${ordersPath(owner.businessId)}/${saleId2}/ready-to-ship`,
    );
    assert.equal(rts.status, 409);

    // Delivered is terminal.
    await api(owner, "POST", `${ordersPath(owner.businessId)}/${saleId}/deliver`);
    const after = await api(
      owner,
      "POST",
      `${ordersPath(owner.businessId)}/${saleId}/deliver`,
    );
    assert.equal(after.status, 409);
  });

  it("mirrors refunds onto the fulfillment workflow (partial + full returns)", async () => {
    const owner = await createOwnerCtx("Fulfillment Return Co");
    const v1 = await seedVariant(owner.businessId, 5);
    const v2 = await seedVariant(owner.businessId, 5);

    const order = await createOnlineOrder({
      businessId: owner.businessId,
      channel: "woocommerce",
      integrationId: null,
      externalOrderId: "EXT-RET",
      locationId: null,
      customer: { name: "Return Buyer" },
      lines: [
        { variantId: v1, quantity: 1 },
        { variantId: v2, quantity: 1 },
      ],
      idempotencyKey: `order-${Date.now()}-ret`,
    });
    await confirmOnlineOrder(owner.businessId, order.saleId, { paymentMode: "cod" });
    await api(owner, "POST", `${ordersPath(owner.businessId)}/${order.saleId}/start-processing`);
    await api(owner, "POST", `${ordersPath(owner.businessId)}/${order.saleId}/deliver`);

    const items = (await pg!.query(
      "SELECT id, variant_id FROM sale_items WHERE sale_id = $1 ORDER BY id",
      [order.saleId],
    )).rows as { id: number; variant_id: number }[];
    assert.equal(items.length, 2);

    // Partial: refund the first line only (no restock — damaged disposition).
    const partial = await api(
      owner,
      "POST",
      `/api/sold_products/refund/${items[0]!.id}`,
      { reason: "damaged", disposition: "damaged" },
    );
    assert.equal(partial.status, 200);
    assert.equal(
      (await saleRow(owner.businessId, order.saleId))!.fulfillment_status,
      "partially_returned",
    );

    // Full: refund the rest — the order becomes returned (and cannot regress).
    const full = await api(
      owner,
      "POST",
      `/api/sold_products/refunds_all/${order.saleId}`,
      { reason: "customer_request", disposition: "inspection" },
    );
    assert.equal(full.status, 200);
    const finalRow = await saleRow(owner.businessId, order.saleId);
    assert.equal(finalRow!.fulfillment_status, "returned");
    assert.equal(finalRow!.status, "refunded");

    // Damaged items were NOT restocked; inspection disposition was not restocked either.
    const stock1 = (await pg!.query(
      "SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2",
      [v1, owner.businessId],
    )).rows[0] as any;
    assert.equal(stock1.quantity, 4); // 5 − 1 sold, damaged → no restock
    const stock2 = (await pg!.query(
      "SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2",
      [v2, owner.businessId],
    )).rows[0] as any;
    assert.equal(stock2.quantity, 4); // inspection → no automatic restock

    // Return events are on the timeline.
    const timeline = (
      await api(owner, "GET", `${ordersPath(owner.businessId)}/${order.saleId}/timeline`)
    ).body.data as any[];
    const types = timeline.map((e) => e.eventType);
    assert.ok(types.includes("partially_returned"));
    assert.equal(types[types.length - 1], "returned");
  });

  it("isolates orders, timeline and fulfillment per business", async () => {
    const ownerA = await createOwnerCtx("Fulfillment Iso A");
    const ownerB = await createOwnerCtx("Fulfillment Iso B");
    const variantId = await seedVariant(ownerA.businessId, 4);
    const saleId = await createCodOrder(ownerA, variantId, "iso");
    await confirmOnlineOrder(ownerA.businessId, saleId, { paymentMode: "cod" });

    const foreignOrder = await api(
      ownerB,
      "GET",
      `${ordersPath(ownerB.businessId)}/${saleId}`,
    );
    assert.equal(foreignOrder.status, 404);

    const foreignTimeline = await api(
      ownerB,
      "GET",
      `${ordersPath(ownerB.businessId)}/${saleId}/timeline`,
    );
    assert.equal(foreignTimeline.status, 404);

    const foreignAction = await api(
      ownerB,
      "POST",
      `${ordersPath(ownerB.businessId)}/${saleId}/start-processing`,
    );
    assert.equal(foreignAction.status, 404);
  });

  it("mark-paid records a ledger row and confirms an unpaid COD order", async () => {
    const owner = await createOwnerCtx("Fulfillment MarkPaid Co");
    const variantId = await seedVariant(owner.businessId, 4);
    const saleId = await createCodOrder(owner, variantId, "markpaid");

    const res = await api(
      owner,
      "POST",
      `${ordersPath(owner.businessId)}/${saleId}/mark-paid`,
      { method: "bangla_qr", reference: "BQR-991" },
    );
    assert.equal(res.status, 200);
    const sale = await saleRow(owner.businessId, saleId);
    assert.equal(sale!.payment_status, "paid");
    assert.equal(sale!.fulfillment_status, "confirmed");
    const payment = (await pg!.query(
      "SELECT payment_method, reference FROM sale_payments WHERE sale_id = $1",
      [saleId],
    )).rows[0] as any;
    assert.equal(payment.payment_method, "bangla_qr");
    assert.equal(payment.reference, "BQR-991");

    // Double mark-paid is rejected (only pending orders).
    const again = await api(
      owner,
      "POST",
      `${ordersPath(owner.businessId)}/${saleId}/mark-paid`,
    );
    assert.equal(again.status, 409);
  });
});
