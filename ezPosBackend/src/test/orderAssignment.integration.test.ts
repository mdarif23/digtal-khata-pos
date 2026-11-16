/**
 * Flexible Business Operating Model — Phase 3 integration tests: online
 * order assignment (migration 0088) and the failed-delivery workflow.
 *
 * Assignment goes through the HTTP routes so the orders.assign permission
 * gate is exercised; order creation/confirmation go through the commerce
 * service directly (same pattern as commerce.integration.test.ts).
 * Double-guarded like the other suites: plain `npm test` NEVER runs this.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";
import {
  confirmOnlineOrder,
  createOnlineOrder,
} from "../modules/commerce/orders.service.js";
import { createOwnerCtx, uniqueEmail } from "./helpers/fixtures.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("online order assignment (Phase 3)", { skip: !runIntegration }, () => {
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

  /** Product with one variant + `qty` stock at the default location. */
  async function seedVariant(businessId: number, qty: number): Promise<number> {
    const location = (await pg!.query(
      "SELECT id FROM locations WHERE business_id = $1 AND is_default = true",
      [businessId],
    )).rows[0] as { id: number } | undefined;
    assert.ok(location, "default location missing (stock source)");
    const product = await pg!.query(
      `INSERT INTO products (business_id, name, product_type, tracking_type, status)
       VALUES ($1, $2, 'physical', 'none', 'active') RETURNING id`,
      [businessId, `Assign Product ${Date.now()}-${(counter += 1)}`],
    );
    const variant = await pg!.query(
      `INSERT INTO product_variants (business_id, product_id, sku, selling_price, is_default, status)
       VALUES ($1, $2, $3, 100, true, 'active') RETURNING id`,
      [businessId, product.rows[0]!.id, `SKU-A-${Date.now()}-${(counter += 1)}`],
    );
    await pg!.query(
      `INSERT INTO inventory_stock (business_id, variant_id, location_id, quantity, reserved_quantity)
       VALUES ($1, $2, $3, $4, 0)`,
      [businessId, variant.rows[0]!.id, location.id, qty],
    );
    // Online confirm consumes BATCHES (FEFO/FIFO) — without a batch the
    // confirm is short even when the stock row has quantity.
    await pg!.query(
      `INSERT INTO inventory_batches (business_id, variant_id, location_id, batch_number, purchase_price, quantity_received, quantity_remaining)
       VALUES ($1, $2, $3, $4, 40, $5, $5)`,
      [businessId, variant.rows[0]!.id, location.id, `A-${Date.now()}-${(counter += 1)}`, qty],
    );
    return variant.rows[0]!.id as number;
  }

  function orderInput(
    businessId: number,
    variantId: number,
    suffix: string,
  ) {
    return {
      businessId,
      channel: "custom_storefront" as const,
      integrationId: null,
      externalOrderId: `EXT-${Date.now()}-${suffix}`,
      locationId: null,
      customer: { name: `Web Customer ${suffix}`, phone: `+88017000000${suffix}` },
      lines: [{ variantId, quantity: 1 }],
      idempotencyKey: `assign-${Date.now()}-${suffix}`,
      paymentMethod: "cod",
    };
  }

  function businessHeaders(token: string, businessId: number) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Business-Id": String(businessId),
    };
  }

  /** Creates a staff user in `roleSlug` via the HTTP API; returns their id. */
  async function seedStaff(
    ownerToken: string,
    businessId: number,
    roleSlug: string,
  ): Promise<number> {
    const rolesRes = await fetch(`${baseUrl}/api/roles`, {
      headers: businessHeaders(ownerToken, businessId),
    });
    assert.equal(rolesRes.status, 200);
    const rolesBody = (await rolesRes.json()) as {
      data: { id: number; slug: string }[];
    };
    const role = rolesBody.data.find((r) => r.slug === roleSlug);
    assert.ok(role, `${roleSlug} role not seeded`);

    const email = uniqueEmail(`assign-${roleSlug}`);
    const res = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: businessHeaders(ownerToken, businessId),
      body: JSON.stringify({
        fullName: `Staff ${roleSlug}`,
        email,
        password: "strong-password-123",
        roleIds: [role.id],
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { data: { userId: number } | { id: number } };
    const user = body.data as { userId?: number; id?: number };
    return (user.userId ?? user.id)!;
  }

  async function login(email: string, password = "strong-password-123") {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(res.status, 200);
    return ((await res.json()) as { accessToken: string }).accessToken;
  }

  it("assigns, reassigns and unassigns with a full timeline trail", async () => {
    const owner = await createOwnerCtx(baseUrl, "Assign Flow Co");
    const variantId = await seedVariant(owner.businessId, 10);
    const order = await createOnlineOrder(
      orderInput(owner.businessId, variantId, "a"),
    );

    const staffA = await seedStaff(owner.token, owner.businessId, "cashier");
    const staffB = await seedStaff(owner.token, owner.businessId, "cashier");

    // Assign (owner holds the wildcard → orders.assign).
    const assign = await fetch(
      `${baseUrl}/api/businesses/${owner.businessId}/orders/${order.saleId}/assign`,
      {
        method: "POST",
        headers: businessHeaders(owner.token, owner.businessId),
        body: JSON.stringify({ userId: staffA }),
      },
    );
    assert.equal(assign.status, 200);

    const detail = await fetch(
      `${baseUrl}/api/businesses/${owner.businessId}/orders/${order.saleId}`,
      { headers: businessHeaders(owner.token, owner.businessId) },
    );
    const detailBody = (await detail.json()) as {
      data: { assignedToUserId: number | null; assignedToName: string | null };
    };
    assert.equal(detailBody.data.assignedToUserId, staffA);
    assert.ok(detailBody.data.assignedToName, "assignee name is surfaced");

    // Reassign — the previous owner stays in the timeline.
    const reassign = await fetch(
      `${baseUrl}/api/businesses/${owner.businessId}/orders/${order.saleId}/assign`,
      {
        method: "POST",
        headers: businessHeaders(owner.token, owner.businessId),
        body: JSON.stringify({ userId: staffB }),
      },
    );
    assert.equal(reassign.status, 200);

    const timeline = await fetch(
      `${baseUrl}/api/businesses/${owner.businessId}/orders/${order.saleId}/timeline`,
      { headers: businessHeaders(owner.token, owner.businessId) },
    );
    const timelineBody = (await timeline.json()) as {
      data: { eventType: string; metadata: Record<string, unknown> }[];
    };
    const events = timelineBody.data.map((e) => e.eventType);
    assert.ok(events.includes("assigned"), "assigned event recorded");
    assert.ok(events.includes("reassigned"), "reassigned event recorded");

    // Unassign.
    const unassign = await fetch(
      `${baseUrl}/api/businesses/${owner.businessId}/orders/${order.saleId}/assign`,
      {
        method: "DELETE",
        headers: businessHeaders(owner.token, owner.businessId),
      },
    );
    assert.equal(unassign.status, 200);
    const afterDetail = (await (
      await fetch(
        `${baseUrl}/api/businesses/${owner.businessId}/orders/${order.saleId}`,
        { headers: businessHeaders(owner.token, owner.businessId) },
      )
    ).json()) as { data: { assignedToUserId: number | null } };
    assert.equal(afterDetail.data.assignedToUserId, null);
    const finalTimeline = (await (
      await fetch(
        `${baseUrl}/api/businesses/${owner.businessId}/orders/${order.saleId}/timeline`,
        { headers: businessHeaders(owner.token, owner.businessId) },
      )
    ).json()) as { data: { eventType: string }[] };
    assert.ok(
      finalTimeline.data.some((e) => e.eventType === "unassigned"),
      "unassigned event recorded",
    );
  });

  it("rejects assignees who are not active members of the business", async () => {
    const owner = await createOwnerCtx(baseUrl, "Assign Foreign Co");
    const variantId = await seedVariant(owner.businessId, 5);
    const order = await createOnlineOrder(
      orderInput(owner.businessId, variantId, "b"),
    );

    const res = await fetch(
      `${baseUrl}/api/businesses/${owner.businessId}/orders/${order.saleId}/assign`,
      {
        method: "POST",
        headers: businessHeaders(owner.token, owner.businessId),
        body: JSON.stringify({ userId: 9_999_999 }),
      },
    );
    assert.equal(res.status, 400);
  });

  it("enforces orders.assign — managers may assign, cashiers may not", async () => {
    const owner = await createOwnerCtx(baseUrl, "Assign Perm Co");
    const variantId = await seedVariant(owner.businessId, 5);
    const order = await createOnlineOrder(
      orderInput(owner.businessId, variantId, "c"),
    );

    const managerId = await seedStaff(owner.token, owner.businessId, "manager");
    const cashierId = await seedStaff(owner.token, owner.businessId, "cashier");

    // Log both staff in (emails come from their users rows).
    const staffRows = (await pg!.query(
      `SELECT u.id, u.email, r.slug FROM users u
         JOIN business_memberships m ON m.user_id = u.id
         JOIN roles r ON r.id = m.role_id
        WHERE m.business_id = $1 AND r.slug IN ('manager', 'cashier')`,
      [owner.businessId],
    )).rows as { id: number; email: string; slug: string }[];
    const managerRow = staffRows.find(
      (row) => row.slug === "manager" && row.id === managerId,
    );
    const cashierRow = staffRows.find(
      (row) => row.slug === "cashier" && row.id === cashierId,
    );
    assert.ok(managerRow, "manager row not found");
    assert.ok(cashierRow, "cashier row not found");
    const cashierToken = await login(cashierRow.email);
    const managerToken = await login(managerRow.email);

    // Cashier has no orders.assign → 403.
    const forbidden = await fetch(
      `${baseUrl}/api/businesses/${owner.businessId}/orders/${order.saleId}/assign`,
      {
        method: "POST",
        headers: businessHeaders(cashierToken, owner.businessId),
        body: JSON.stringify({ userId: managerId }),
      },
    );
    assert.equal(forbidden.status, 403);

    // Manager holds orders.assign (default manager template, new businesses).
    const allowed = await fetch(
      `${baseUrl}/api/businesses/${owner.businessId}/orders/${order.saleId}/assign`,
      {
        method: "POST",
        headers: businessHeaders(managerToken, owner.businessId),
        body: JSON.stringify({ userId: managerId }),
      },
    );
    assert.equal(allowed.status, 200);
  });

  it("counts unassigned open orders in the summary", async () => {
    const owner = await createOwnerCtx(baseUrl, "Assign Summary Co");
    const variantId = await seedVariant(owner.businessId, 10);
    const first = await createOnlineOrder(
      orderInput(owner.businessId, variantId, "d1"),
    );
    await createOnlineOrder(orderInput(owner.businessId, variantId, "d2"));

    const summaryRes = await fetch(
      `${baseUrl}/api/businesses/${owner.businessId}/orders/summary`,
      { headers: businessHeaders(owner.token, owner.businessId) },
    );
    const summaryBefore = (await summaryRes.json()) as {
      data: { unassignedCount: number };
    };
    // Both orders are pending (unassignedCount counts open orders); pending
    // orders are not "completed" so they do not count — assign open counts
    // only completed orders. Confirm one to make it an open completed order.
    await confirmOnlineOrder(owner.businessId, first.saleId);
    const afterConfirm = (await (
      await fetch(
        `${baseUrl}/api/businesses/${owner.businessId}/orders/summary`,
        { headers: businessHeaders(owner.token, owner.businessId) },
      )
    ).json()) as { data: { unassignedCount: number } };
    assert.equal(afterConfirm.data.unassignedCount, 1);

    const staffId = await seedStaff(owner.token, owner.businessId, "cashier");
    await fetch(
      `${baseUrl}/api/businesses/${owner.businessId}/orders/${first.saleId}/assign`,
      {
        method: "POST",
        headers: businessHeaders(owner.token, owner.businessId),
        body: JSON.stringify({ userId: staffId }),
      },
    );
    const afterAssign = (await (
      await fetch(
        `${baseUrl}/api/businesses/${owner.businessId}/orders/summary`,
        { headers: businessHeaders(owner.token, owner.businessId) },
      )
    ).json()) as { data: { unassignedCount: number } };
    assert.equal(afterAssign.data.unassignedCount, 0);
  });

  it("lists orders by assignee filter (me / unassigned)", async () => {
    const owner = await createOwnerCtx(baseUrl, "Assign Filter Co");
    const variantId = await seedVariant(owner.businessId, 10);
    const order = await createOnlineOrder(
      orderInput(owner.businessId, variantId, "e"),
    );
    const staffId = await seedStaff(owner.token, owner.businessId, "cashier");

    await fetch(
      `${baseUrl}/api/businesses/${owner.businessId}/orders/${order.saleId}/assign`,
      {
        method: "POST",
        headers: businessHeaders(owner.token, owner.businessId),
        body: JSON.stringify({ userId: staffId }),
      },
    );

    const assignedList = (await (
      await fetch(
        `${baseUrl}/api/businesses/${owner.businessId}/orders?assignee=${staffId}`,
        { headers: businessHeaders(owner.token, owner.businessId) },
      )
    ).json()) as {
      orders: { id: number; assignedToUserId: number | null; assignedToName: string | null }[];
    };
    assert.ok(
      assignedList.orders.some(
        (o) => o.id === order.saleId && o.assignedToUserId === staffId,
      ),
      "assigned order surfaces under its assignee",
    );

    const unassignedList = (await (
      await fetch(
        `${baseUrl}/api/businesses/${owner.businessId}/orders?assignee=unassigned`,
        { headers: businessHeaders(owner.token, owner.businessId) },
      )
    ).json()) as { orders: { id: number }[] };
    assert.ok(
      !unassignedList.orders.some((o) => o.id === order.saleId),
      "assigned order is not in the unassigned bucket",
    );
  });

  it("marks delivery failed and supports redelivery without touching money or stock", async () => {
    const owner = await createOwnerCtx(baseUrl, "Delivery Failed Co");
    const variantId = await seedVariant(owner.businessId, 10);
    const order = await createOnlineOrder(
      orderInput(owner.businessId, variantId, "f"),
    );
    await confirmOnlineOrder(owner.businessId, order.saleId, {
      paymentMode: "cod",
    });

    // No shipment yet → 404.
    const earlyFail = await fetch(
      `${baseUrl}/api/businesses/${owner.businessId}/orders/${order.saleId}/delivery-failed`,
      {
        method: "POST",
        headers: businessHeaders(owner.token, owner.businessId),
        body: JSON.stringify({ note: "too early" }),
      },
    );
    assert.equal(earlyFail.status, 404);

    // Ship.
    const ship = await fetch(
      `${baseUrl}/api/businesses/${owner.businessId}/orders/${order.saleId}/ship`,
      {
        method: "POST",
        headers: businessHeaders(owner.token, owner.businessId),
        body: JSON.stringify({
          courierName: "Steadfast",
          trackingNumber: `TRK-${Date.now()}`,
        }),
      },
    );
    assert.equal(ship.status, 200);

    // Mark failed.
    const fail = await fetch(
      `${baseUrl}/api/businesses/${owner.businessId}/orders/${order.saleId}/delivery-failed`,
      {
        method: "POST",
        headers: businessHeaders(owner.token, owner.businessId),
        body: JSON.stringify({ note: "customer unreachable" }),
      },
    );
    assert.equal(fail.status, 200);

    const fulfillment = (await (
      await fetch(
        `${baseUrl}/api/businesses/${owner.businessId}/orders/${order.saleId}/fulfillment`,
        { headers: businessHeaders(owner.token, owner.businessId) },
      )
    ).json()) as { data: { shipment: { status: string } | null } };
    assert.equal(fulfillment.data.shipment?.status, "failed");

    // Redelivery: patch the shipment, then deliver.
    const repatch = await fetch(
      `${baseUrl}/api/businesses/${owner.businessId}/orders/${order.saleId}/shipment`,
      {
        method: "PATCH",
        headers: businessHeaders(owner.token, owner.businessId),
        body: JSON.stringify({ trackingNumber: `TRK2-${Date.now()}` }),
      },
    );
    assert.equal(repatch.status, 200);
    const deliver = await fetch(
      `${baseUrl}/api/businesses/${owner.businessId}/orders/${order.saleId}/deliver`,
      {
        method: "POST",
        headers: businessHeaders(owner.token, owner.businessId),
        body: JSON.stringify({ codCollected: true, codAmount: 100, codMethod: "cash" }),
      },
    );
    assert.equal(deliver.status, 200);

    const timeline = (await (
      await fetch(
        `${baseUrl}/api/businesses/${owner.businessId}/orders/${order.saleId}/timeline`,
        { headers: businessHeaders(owner.token, owner.businessId) },
      )
    ).json()) as { data: { eventType: string }[] };
    assert.ok(
      timeline.data.some((e) => e.eventType === "delivery_failed"),
      "delivery_failed event recorded",
    );

    // Stock was consumed exactly once (confirm) and never restored/re-deducted.
    const stock = (await pg!.query(
      "SELECT quantity, reserved_quantity FROM inventory_stock WHERE business_id = $1 AND variant_id = $2",
      [owner.businessId, variantId],
    )).rows[0] as { quantity: number; reserved_quantity: number };
    assert.equal(stock.quantity, 9);
    assert.equal(stock.reserved_quantity, 0);
  });
});
