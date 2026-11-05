/**
 * LAN sync agent (Phase 2) — LOCAL side, against a SCRIPTED cloud (node:http
 * server). Proves: durable-outbox push (sales table + synced_at), customer
 * id mapping (deferred sale), failure dead-lettering, and the hard
 * push-before-pull gate that stops a stock snapshot from resurrecting sold
 * units. Cloud-side op semantics are proven in lanSync.integration.test.ts.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { buildApp } from "../app.js";
import {
  SyncCloudClient,
  pushOnce,
  runSweep,
  type BootstrapSnapshot,
  type CatalogDelta,
  type PushOpResult,
  type StockSnapshot,
} from "../sync/sync.agent.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("LAN sync agent (Phase 2, scripted cloud)", { skip: !runIntegration, concurrency: 1 }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";
  let dbClient: import("pg").Client;

  // --- scripted cloud -----------------------------------------------------
  let mockCloud: Server | undefined;
  let mockCloudUrl = "";
  const cloudCalls: { method: string; url: string }[] = [];
  let opsHandler: (body: any) => { results: PushOpResult[] } = () => ({
    results: [],
  });
  let bootstrapPayload: BootstrapSnapshot | null = null;
  let catalogPayload: CatalogDelta | null = null;
  let stockPayload: StockSnapshot | null = null;

  before(async () => {
    const { default: pg } = await import("pg");
    dbClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await dbClient.connect();
    if ((await dbClient.query("SELECT current_database() AS db")).rows[0]?.db !== "ezpos_test") {
      throw new Error("SAFETY ABORT: integration tests may only run against ezpos_test.");
    }
    await dbClient.query(
      `INSERT INTO subscription_plans (name, slug, interval, price, currency, is_active)
       VALUES ('Free trial', 'free-trial', 'monthly', 0, 'BDT', true)
       ON CONFLICT (slug) DO UPDATE SET is_active = true`,
    );
    const { ensureRbacSeed } = await import("../rbac/seed.js");
    await ensureRbacSeed();

    const app = buildApp();
    server = app.listen(0);
    const address = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    mockCloud = createServer((req, res) => {
      const url = req.url ?? "";
      cloudCalls.push({ method: req.method ?? "", url });
      const respond = (payload: unknown, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (url.startsWith("/api/sync/bootstrap")) {
        respond(bootstrapPayload ? { data: bootstrapPayload } : { data: null });
      } else if (url.startsWith("/api/sync/catalog")) {
        respond({ data: catalogPayload ?? { products: [], variants: [], barcodeAliases: [], productTaxes: [], taxRates: [], categories: [], brands: [], units: [], cursor: new Date().toISOString() } });
      } else if (url.startsWith("/api/sync/stock")) {
        respond({ data: stockPayload ?? { locationId: 0, stock: [], batches: [], serials: [] } });
      } else if (url.startsWith("/api/sync/customers")) {
        respond({ data: { customers: [], cursor: new Date().toISOString() } });
      } else if (url.startsWith("/api/sync/ops")) {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
          let body: any = { ops: [] };
          try {
            body = JSON.parse(raw);
          } catch {
            body = { ops: [] };
          }
          respond({ data: opsHandler(body) });
        });
      } else {
        respond({ message: "not found" }, 404);
      }
    });
    mockCloud.listen(0);
    mockCloudUrl = `http://127.0.0.1:${(mockCloud.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.close();
    mockCloud?.close();
    await dbClient?.end();
  });

  const uniqueEmail = () =>
    `agent-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let ownerUserId = 0;
  let mainLocationId = 0;
  let unitId = 0;
  let customerId = 0;
  let variantId = 0;
  let client: SyncCloudClient;

  async function api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Business-Id": String(businessId),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  before(async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Agent Owner", email, password: "strong-password-123" }),
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
    token = loginBody.accessToken;
    ownerUserId = loginBody.user.id;
    const biz = await api("POST", "/api/businesses", { name: `Agent Biz ${Date.now()}` });
    assert.equal(biz.status, 201);
    businessId = biz.json.business.id;
    const loc = await api("POST", "/api/locations", { name: "Main Store" });
    assert.equal(loc.status, 201);
    const locs = await api("GET", "/api/locations");
    mainLocationId = locs.json.data.find((l: any) => l.name === "Main Store").id;
    const unit = await api("POST", "/api/product/unit", { unitName: "Piece", abbreviation: "Pcs" });
    unitId = unit.json.data.value;
    const cust = await api("POST", "/api/customers", { name: "Agent Customer", phone: "1744000033" });
    customerId = cust.json.id;
    const prodRes = await api("POST", "/api/product", {
      name: "Agent Product",
      categoryId: null, brandId: null, unitId, description: "", productType: "physical",
      hasVariants: false, trackingType: "none", supplierId: null, status: "active",
      imageUrl: null, imageFile: null, source: "opening",
      variants: [{ sku: "", barcode: null, sellingPrice: 50, alertQuantity: 0, isDefault: true,
        status: "active", imageUrl: null, imageFile: null, batchNumber: "", purchasePrice: 20,
        quantity: 30, expiryDate: null }],
    });
    assert.equal(prodRes.status, 201);
    const list = await api("GET", "/api/products");
    const found = (list.json as { id: number; name: string }[]).find((p) => p.name === "Agent Product")!;
    const detail = await api("GET", `/api/product/${found.id}`);
    variantId = (detail.json as { variants: { id: number }[] }).variants[0]!.id;

    client = new SyncCloudClient(mockCloudUrl, 1, "ezpos_tb_agent-test-secret");

    // Default scripted bootstrap for every runSweep — the pull tests
    // override the payloads they care about.
    bootstrapPayload = {
      terminal: { id: 1, name: "LAN Server", locationId: mainLocationId },
      business: { id: businessId, name: "Agent Biz", slug: `agent-biz-${Date.now()}`, createdByUserId: ownerUserId },
      locations: [{ id: mainLocationId, businessId, name: "Main Store", isDefault: true }],
      users: [{ id: ownerUserId, fullName: "Agent Owner", email: uniqueEmail(), passwordHash: "x", platformRole: "none", isActive: true }],
      roles: [],
      permissions: [],
      rolePermissions: [],
      userRoles: [],
      memberships: [],
      locationAssignments: [],
      plans: [{ id: 1, name: "Free trial", slug: "free-trial", interval: "monthly", price: 0, currency: "BDT", isActive: true }],
      subscription: null,
      posSettings: null,
    };
  });

  async function ringSale(idempotencyKey: string, withCustomer: boolean) {
    const res = await api("POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: withCustomer ? customerId : null,
      payments: [{ method: "cash", amount: 100, tendered: 100 }],
      discount: null,
      vatPercent: 0,
      idempotencyKey,
      items: [{ variantId, quantity: 2, unitPrice: 50, discount: null }],
    });
    assert.equal(res.status, 201);
    return res.json.data.sale.id as number;
  }

  async function pendingSales(): Promise<number> {
    const { rows } = await dbClient.query(
      `SELECT count(*)::int AS n FROM sales
       WHERE business_id = $1 AND synced_at IS NULL AND channel = 'pos' AND status = 'completed'`,
      [businessId],
    );
    return rows[0].n;
  }

  async function pendingSalesDetail(): Promise<unknown> {
    const { rows } = await dbClient.query(
      `SELECT id, idempotency_key, business_id FROM sales
       WHERE synced_at IS NULL AND channel = 'pos' AND status = 'completed' ORDER BY id DESC LIMIT 5`,
    );
    return rows;
  }

  it("pushes a customer-less sale as one idempotent op and marks it synced", async () => {
    const saleId = await ringSale(`agent-push-${Date.now()}`, false);
    assert.equal(
      await pendingSales(),
      1,
      `businessId=${businessId} pending=${JSON.stringify(await pendingSalesDetail())}`,
    );

    let seenSaleOp: any = null;
    opsHandler = (body) => {
      console.log("MOCK-OPS:", JSON.stringify(body.ops.map((o: any) => ({ type: o.type, opId: o.opId }))));
      const saleOp = body.ops.find((op: any) => op.type === "sale.create");
      if (saleOp) seenSaleOp = saleOp;
      return {
        results: body.ops.map((op: any) =>
          op.type === "sale.create"
            ? { opId: op.opId, status: "applied", saleId: 4242, invoiceNumber: "INV-CLOUD-000001" }
            : { opId: op.opId, status: "applied", customerId: 999 },
        ),
      };
    };

    const outcome = await pushOnce(client, { businessId, locationId: mainLocationId, name: "LAN Server" });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.pushed, 1);
    assert.equal(seenSaleOp.payload.sale.items[0].variantId, variantId);
    assert.equal(seenSaleOp.payload.sale.items[0].quantity, 2);
    assert.equal(seenSaleOp.payload.sale.items[0].unitPrice, 50);
    assert.equal(seenSaleOp.payload.locationId, mainLocationId);

    const row = await dbClient.query(`SELECT synced_at, sync_attempts FROM sales WHERE id = $1`, [saleId]);
    assert.ok(row.rows[0].synced_at, "sale marked synced");
    assert.equal(await pendingSales(), 0);
  });

  it("defers a sale whose customer has no cloud mapping, then pushes it mapped", async () => {
    const saleId = await ringSale(`agent-cust-${Date.now()}`, true);
    const { rows: localCustomer } = await dbClient.query(
      `SELECT id FROM customers WHERE id = $1`,
      [customerId],
    );
    assert.ok(localCustomer[0]);

    let customerOpSeen = false;
    let saleOpSeenInFirstPush = false;
    opsHandler = (body) => ({
      results: body.ops.map((op: any) => {
        if (op.type === "customer.create") customerOpSeen = true;
        if (op.type === "sale.create") saleOpSeenInFirstPush = true;
        return op.type === "customer.create"
          ? { opId: op.opId, status: "applied", customerId: 987654 }
          : { opId: op.opId, status: "applied", saleId: 1, invoiceNumber: "X" };
      }),
    });

    // Sweep 1: bootstrap+push — the customer op goes out, the sale waits.
    await runSweep(client);
    assert.ok(customerOpSeen, "customer.create pushed first");
    assert.equal(saleOpSeenInFirstPush, false, "sale deferred until the customer is mapped");
    assert.equal((await dbClient.query(`SELECT synced_at FROM sales WHERE id = $1`, [saleId])).rows[0].synced_at, null);

    // Sweep 2: the mapping now exists — the sale carries the CLOUD id.
    let mappedCustomerId: number | null = null;
    opsHandler = (body) => {
      const saleOp = body.ops.find((op: any) => op.type === "sale.create");
      if (saleOp) mappedCustomerId = saleOp.payload.sale.customerId;
      return {
        results: body.ops.map((op: any) =>
          op.type === "sale.create"
            ? { opId: op.opId, status: "applied", saleId: 4243, invoiceNumber: "INV-CLOUD-000002" }
            : { opId: op.opId, status: "duplicate", customerId: 987654 },
        ),
      };
    };
    await runSweep(client);
    assert.equal(mappedCustomerId, 987654, "sale op rewritten to the cloud customer id");
    assert.ok((await dbClient.query(`SELECT synced_at FROM sales WHERE id = $1`, [saleId])).rows[0].synced_at);
    const mapping = await dbClient.query(
      `SELECT remote_id FROM sync_id_map WHERE kind = 'customer' AND local_id = $1`,
      [customerId],
    );
    assert.equal(mapping.rows[0].remote_id, 987654);
  });

  it("a failed op dead-letters (attempts++) and hard-gates the pull", async () => {
    const saleId = await ringSale(`agent-fail-${Date.now()}`, false);
    cloudCalls.length = 0;
    opsHandler = (body) => ({
      results: body.ops.map((op: any) => ({
        opId: op.opId,
        status: "failed",
        error: "Insufficient stock on cloud (simulated)",
      })),
    });
    const outcome = await pushOnce(client, { businessId, locationId: mainLocationId, name: "LAN Server" });
    assert.equal(outcome.ok, false);
    const row = await dbClient.query(`SELECT sync_attempts, synced_at FROM sales WHERE id = $1`, [saleId]);
    assert.equal(row.rows[0].sync_attempts, 1);
    assert.equal(row.rows[0].synced_at, null);

    // The gate: a failing push must NEVER be followed by a stock pull.
    await runSweep(client);
    assert.ok(
      !cloudCalls.some((call) => call.url.startsWith("/api/sync/stock")),
      "stock snapshot must not be pulled while ops are failing",
    );
  });

  it("runSweep pulls identity, catalog, stock and customers, recording cursors", async () => {
    // The dead-lettered sale from the previous test still pends; a
    // succeeding push unblocks the pull gate for everything.
    opsHandler = (body) => ({
      results: body.ops.map((op: any) =>
        op.type === "sale.create"
          ? { opId: op.opId, status: "applied", saleId: 4244, invoiceNumber: "INV-CLOUD-000003" }
          : { opId: op.opId, status: "duplicate", customerId: 987654 },
      ),
    });
    cloudCalls.length = 0;

    const { rows: uidRows } = await dbClient.query(
      `SELECT COALESCE(MAX(id),0)+100 AS base FROM users`,
    );
    const cloudUserId = Number(uidRows[0].base);
    bootstrapPayload = {
      terminal: { id: 1, name: "LAN Server", locationId: mainLocationId },
      business: { id: businessId, name: "Agent Biz (cloud-updated)", slug: `agent-biz-${Date.now()}`, createdByUserId: ownerUserId },
      locations: [{ id: mainLocationId, businessId, name: "Main Store", isDefault: true }],
      users: [
        { id: ownerUserId, fullName: "Agent Owner", email: uniqueEmail(), passwordHash: "x", platformRole: "none", isActive: true },
        { id: cloudUserId, fullName: "Cloud Cashier", email: `cloud-cashier-${Date.now()}@example.test`, passwordHash: "x", platformRole: "none", isActive: true },
      ],
      roles: [],
      permissions: [],
      rolePermissions: [],
      userRoles: [],
      memberships: [],
      locationAssignments: [],
      plans: [{ id: 1, name: "Free trial", slug: "free-trial", interval: "monthly", price: 0, currency: "BDT", isActive: true }],
      subscription: null,
      posSettings: null,
    };
    // Collision-proof cloud ids: derive from the DB's current max so two
    // runs (or parallel suites sharing ezpos_test) never reuse ids under a
    // different business (composite-FK upserts).
    const { rows: idRows } = await dbClient.query(
      `SELECT GREATEST((SELECT COALESCE(MAX(id),0)+100 FROM products),
                       (SELECT COALESCE(MAX(id),0)+100 FROM product_variants),
                       (SELECT COALESCE(MAX(id),0)+100 FROM inventory_batches)) AS base`,
    );
    const cloudProductId = Number(idRows[0].base);
    const cloudVariantId = cloudProductId + 1;
    const cloudBatchId = cloudProductId + 2;
    catalogPayload = {
      products: [{ id: cloudProductId, businessId, name: "Cloud Product", productType: "physical", hasVariants: true, trackingType: "none", status: "active" }],
      variants: [{ id: cloudVariantId, businessId, productId: cloudProductId, sku: "CLOUD-1", sellingPrice: 60, alertQuantity: 0, isDefault: true, status: "active" }],
      barcodeAliases: [],
      productTaxes: [],
      taxRates: [],
      categories: [],
      brands: [],
      units: [],
      cursor: "2026-11-06T00:00:00.000Z",
    };
    stockPayload = {
      locationId: mainLocationId,
      stock: [{ businessId, variantId: cloudVariantId, locationId: mainLocationId, quantity: 12, reservedQuantity: 0 }],
      batches: [{ id: cloudBatchId, businessId, variantId: cloudVariantId, locationId: mainLocationId, batchNumber: "CLOUD-B1", purchasePrice: 30, quantityReceived: 12, quantityRemaining: 12 }],
      serials: [],
    };

    await runSweep(client);

    assert.ok(cloudCalls.some((c) => c.url.startsWith("/api/sync/catalog")));
    assert.ok(cloudCalls.some((c) => c.url.startsWith("/api/sync/stock")));

    const cloudUser = await dbClient.query(`SELECT full_name FROM users WHERE id = $1`, [cloudUserId]);
    assert.equal(cloudUser.rows[0].full_name, "Cloud Cashier");
    const cloudVariant = await dbClient.query(`SELECT sku FROM product_variants WHERE id = $1`, [cloudVariantId]);
    assert.equal(cloudVariant.rows[0].sku, "CLOUD-1");
    const stock = await dbClient.query(
      `SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2`,
      [cloudVariantId, businessId],
    );
    assert.equal(Number(stock.rows[0].quantity), 12);
    const catalogCursor = await dbClient.query(`SELECT cursor FROM sync_state WHERE stream = 'catalog'`);
    assert.equal(catalogCursor.rows[0].cursor, "2026-11-06T00:00:00.000Z");
  });
});
