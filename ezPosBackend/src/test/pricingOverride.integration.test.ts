/**
 * POS price override + minimum-price protection integration tests — Phase 6
 * (report §18 gate: permission matrix tests). Covers: the
 * pricing.price_override permission gate, the override snapshot (sale line
 * charged at the cashier's price, variant row untouched, price_adjustments
 * entry with signed amount + reason, audit row), the quote warnings for
 * below-minimum lines, the createSale block without
 * pricing.below_minimum_override, the mandatory reason when approved, the
 * business-wide margin floor (and its explicit skip when cost is
 * unavailable), and the receipt rendering the attribution breakdown.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("pos price override + minimum floors integration", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";
  let pgClient: import("pg").Client | undefined;

  before(async () => {
    const { default: pg } = await import("pg");
    pgClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await pgClient.connect();
    const db = await pgClient.query("SELECT current_database() AS db");
    if (db.rows[0]?.db !== "ezpos_test") {
      throw new Error(
        `SAFETY ABORT: connected to "${db.rows[0]?.db}" — integration tests may only run against ezpos_test.`,
      );
    }
    await pgClient.query(
      `INSERT INTO subscription_plans (name, slug, interval, price, currency, is_active)
       VALUES ('Free trial', 'free-trial', 'monthly', 0, 'BDT', true)
       ON CONFLICT (slug) DO UPDATE
       SET limits = NULL,
           features = '{"multiLocation":true,"advancedReports":true,"storefrontApi":true,"woocommerceIntegration":true,"customStorefront":true,"multipleOnlineStores":true,"advancedWebhooks":true}'::jsonb,
           is_active = true`,
    );
    const { ensureRbacSeed } = await import("../rbac/seed.js");
    await ensureRbacSeed();

    const app = buildApp();
    server = app.listen(0);
    const address = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    server?.close();
    await pgClient?.end();
  });

  const uniqueEmail = () =>
    `pricing-override-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let locationId = 0;
  let variantPriced = 0; // price 100, cost 50, 30 on hand
  let variantNoBatch = 0; // price 100, NO batches (cost unavailable)
  let overriderToken = ""; // pricing.price_override + below_minimum_override
  let plainToken = ""; // no pricing permissions
  let priceOnlyToken = ""; // price_override but NOT below_minimum_override

  async function api(
    method: string,
    path: string,
    body?: unknown,
    overrides: Record<string, string> = {},
  ) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Business-Id": String(businessId),
        ...overrides,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  function quoteWith(bearer: string, items: Record<string, unknown>[]) {
    return fetch(`${baseUrl}/api/sales/quote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        "X-Business-Id": String(businessId),
      },
      body: JSON.stringify({ items, cartDiscount: null, vatPercent: null }),
    }).then(async (res) => ({ status: res.status, json: await res.json() }));
  }

  function saleWith(bearer: string, items: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
    return fetch(`${baseUrl}/api/sales`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        "X-Business-Id": String(businessId),
      },
      body: JSON.stringify({
        saleDate: new Date().toISOString(),
        customerId: null,
        payments: [{ method: "cash", amount: 1, tendered: 1 }],
        discount: null,
        vatPercent: 0,
        items,
        ...extra,
      }),
    }).then(async (res) => ({ status: res.status, json: await res.json() }));
  }

  async function makeUser(permissionKeys: string[]): Promise<string> {
    const roleRes = await api("POST", "/api/roles", {
      name: `Override Role ${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      permissionKeys,
    });
    const roleId = (roleRes.json as { data: { id: number } }).data.id;
    const userRes = await api("POST", "/api/users", {
      fullName: "Override User",
      email: uniqueEmail(),
      password: "strong-password-123",
      roleIds: [roleId],
      locationIds: [locationId],
    });
    const email = (userRes.json as { data: { email: string } }).data.email;
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    return ((await login.json()) as { accessToken: string }).accessToken;
  }

  before(async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Override Owner", email, password: "strong-password-123" }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    token = ((await login.json()) as { accessToken: string }).accessToken;
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: `Override Biz ${Date.now()}` }),
    });
    assert.equal(biz.status, 201);
    businessId = ((await biz.json()) as { business: { id: number } }).business.id;
    const loc = await fetch(`${baseUrl}/api/locations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Business-Id": String(businessId),
      },
      body: JSON.stringify({ name: "Main Store" }),
    });
    assert.equal(loc.status, 201);
    locationId = ((await loc.json()) as { data: { id: number } }).data.id;

    const variants: number[] = [];
    for (const spec of [
      { name: "Override Priced", price: 100, qty: 30, cost: 50, source: "opening" as const },
      // Sellable stock, but the batch cost is zeroed right after creation —
      // the margin-floor case needs a variant with NO PRICED batches (the
      // cost provider returns "unavailable" only for a zero/absent total),
      // and opening stock validation rejects a 0 purchase price up front.
      { name: "Override NoBatch", price: 100, qty: 10, cost: 50, source: "opening" as const },
    ]) {
      const unit = await api("POST", "/api/product/unit", {
        unitName: `${spec.name} Unit ${Date.now()}`,
        abbreviation: "ou",
      });
      const unitId = (unit.json as { data: { value: number } }).data.value;
      const prod = await api("POST", "/api/product", {
        name: spec.name,
        categoryId: null,
        brandId: null,
        unitId,
        description: "",
        productType: "physical",
        hasVariants: false,
        trackingType: "none",
        supplierId: null,
        status: "active",
        imageUrl: null,
        imageFile: null,
        source: spec.source,
        variants: [
          {
            sku: "",
            barcode: null,
            sellingPrice: spec.price,
            alertQuantity: 0,
            isDefault: true,
            status: "active",
            imageUrl: null,
            imageFile: null,
            batchNumber: "",
            purchasePrice: spec.cost,
            quantity: spec.qty,
            expiryDate: null,
          },
        ],
      });
      assert.equal(prod.status, 201, JSON.stringify(prod.json));
      const list = await api("GET", "/api/products");
      const found = (list.json as { id: number; name: string }[]).find(
        (p) => p.name === spec.name,
      )!;
      const detail = await api("GET", `/api/product/${found.id}`);
      variants.push(
        (detail.json as { variants: { id: number }[] }).variants[0]!.id,
      );
    }
    variantPriced = variants[0]!;
    variantNoBatch = variants[1]!;

    // Zero the NoBatch variant's batch purchase price (landed_cost_per_unit
    // is GENERATED from it): sellable stock, but the cost provider reports
    // "unavailable" — no priced batches on hand.
    await pgClient!.query(
      `UPDATE inventory_batches SET purchase_price = 0 WHERE variant_id = $1`,
      [variantNoBatch],
    );

    // Base sale permissions are required to reach the override/floor gates at
    // all — without pos.create_sale every sale 403s before pricing runs. The
    // line-discount cases also need pos.apply_discount.
    overriderToken = await makeUser([
      "pos.view",
      "pos.create_sale",
      "pos.apply_discount",
      "pricing.price_override",
      "pricing.below_minimum_override",
    ]);
    plainToken = await makeUser([
      "pos.view",
      "pos.create_sale",
      "pos.apply_discount",
    ]);
    // Sits at the override gate: may price-override, but a below-floor line
    // still 400s because allowBelowMinimum stays false.
    priceOnlyToken = await makeUser([
      "pos.view",
      "pos.create_sale",
      "pos.apply_discount",
      "pricing.price_override",
    ]);
  });

  it("quotes an override and warns when the line lands below its minimum", async () => {
    // Normal override: quoted total reflects the cashier's price.
    const ok = await quoteWith(token, [
      { variantId: variantPriced, quantity: 2, discount: null, priceOverride: { unitPrice: 80 } },
    ]);
    assert.equal(
      (ok.json as { data: { finalTotal: number; warnings?: unknown } }).data.finalTotal,
      160,
    );
    assert.equal(
      (ok.json as { data: { warnings?: unknown } }).data.warnings,
      undefined,
    );

    // Below the floor: warning present, total still quoted.
    await pgClient!.query(
      `UPDATE product_variants SET min_selling_price = 90 WHERE id = $1`,
      [variantPriced],
    );
    const warned = await quoteWith(token, [
      { variantId: variantPriced, quantity: 1, discount: null, priceOverride: { unitPrice: 80 } },
    ]);
    const data = (warned.json as {
      data: {
        finalTotal: number;
        warnings: {
          variantId: number;
          code: string;
          effectiveUnitPrice: number;
          minPrice: number | null;
          message: string;
        }[];
      };
    }).data;
    assert.equal(data.warnings.length, 1);
    assert.equal(data.warnings[0]!.code, "below_minimum");
    assert.equal(data.warnings[0]!.effectiveUnitPrice, 80);
    assert.equal(data.warnings[0]!.minPrice, 90);
    assert.equal(data.finalTotal, 80);
    await pgClient!.query(
      `UPDATE product_variants SET min_selling_price = NULL WHERE id = $1`,
      [variantPriced],
    );
  });

  it("blocks overrides without pricing.price_override and permits with it", async () => {
    const denied = await saleWith(plainToken, [
      { variantId: variantPriced, quantity: 1, unitPrice: 100, discount: null, priceOverride: { unitPrice: 80 } },
    ]);
    assert.equal(denied.status, 403);

    const allowed = await saleWith(overriderToken, [
      { variantId: variantPriced, quantity: 2, unitPrice: 100, discount: null, priceOverride: { unitPrice: 80 } },
    ], {
      payments: [{ method: "cash", amount: 160, tendered: 160 }],
    });
    assert.equal(allowed.status, 201, JSON.stringify(allowed.json));
    const saleId = (allowed.json as { data: { sale: { id: number; finalTotal: number } } }).data.sale.id;
    assert.equal(
      (allowed.json as { data: { sale: { finalTotal: number } } }).data.sale.finalTotal,
      160,
    );

    const rows = await pgClient!.query(
      `SELECT selling_price, price_adjustments FROM sale_items WHERE sale_id = $1`,
      [saleId],
    );
    const item = rows.rows[0] as { selling_price: string; price_adjustments: { kind: string; name: string | null; amount: number; reason: string | null }[] };
    // Charged at the cashier's price; the variant row stays untouched.
    assert.equal(Number(item.selling_price), 80);
    const overrideEntry = item.price_adjustments.find((a) => a.name === "Price override");
    assert.ok(overrideEntry);
    assert.equal(overrideEntry.amount, 40); // (100 − 80) × 2 saved
    const variantRow = await pgClient!.query(
      `SELECT selling_price FROM product_variants WHERE id = $1`,
      [variantPriced],
    );
    assert.equal(Number(variantRow.rows[0]!.selling_price), 100);

    const audit = await pgClient!.query(
      `SELECT action, metadata FROM audit_log WHERE entity_type = 'sale' AND entity_id = $1 AND action = 'pricing.price_override'`,
      [saleId],
    );
    assert.equal(audit.rows.length, 1);
    void audit;
  });

  it("blocks a sale below the minimum floor without the override permission", async () => {
    await pgClient!.query(
      `UPDATE product_variants SET min_selling_price = 90 WHERE id = $1`,
      [variantPriced],
    );
    // price_override WITHOUT below_minimum_override → the controller override
    // gate passes, but the floor still blocks (400) because allowBelowMinimum
    // stays false.
    const blocked = await saleWith(priceOnlyToken, [
      { variantId: variantPriced, quantity: 1, unitPrice: 100, discount: null, priceOverride: { unitPrice: 80 } },
    ]);
    assert.equal(blocked.status, 400);
    assert.match(
      String((blocked.json as { message: string }).message),
      /below the minimum/,
    );

    // Even the overrider needs a reason.
    const noReason = await saleWith(overriderToken, [
      { variantId: variantPriced, quantity: 1, unitPrice: 100, discount: null, priceOverride: { unitPrice: 80 } },
    ], {
      payments: [{ method: "cash", amount: 80, tendered: 80 }],
    });
    assert.equal(noReason.status, 400);
    assert.match(String((noReason.json as { message: string }).message), /reason/i);

    // With the reason the sale goes through and the approval is snapshotted.
    const approved = await saleWith(overriderToken, [
      { variantId: variantPriced, quantity: 1, unitPrice: 100, discount: null, priceOverride: { unitPrice: 80 } },
    ], {
      payments: [{ method: "cash", amount: 80, tendered: 80 }],
      belowMinimumReason: "Damaged box, manager approved",
    });
    assert.equal(approved.status, 201, JSON.stringify(approved.json));
    const saleId = (approved.json as { data: { sale: { id: number } } }).data.sale.id;
    const items = await pgClient!.query(
      `SELECT price_adjustments FROM sale_items WHERE sale_id = $1`,
      [saleId],
    );
    const adjustments = (items.rows[0] as { price_adjustments: { name: string | null; amount: number; reason: string | null }[] }).price_adjustments;
    const approval = adjustments.find((a) => a.name === "Below-minimum approval");
    assert.ok(approval);
    assert.equal(approval.reason, "Damaged box, manager approved");
    await pgClient!.query(
      `UPDATE product_variants SET min_selling_price = NULL WHERE id = $1`,
      [variantPriced],
    );
  });

  it("enforces the business-wide margin floor and skips it explicitly when cost is unavailable", async () => {
    const settings = await api("PUT", "/api/pricing/settings", { minMarginPercent: 40 });
    assert.equal(settings.status, 200, JSON.stringify(settings.json));

    // variantPriced: cost 50 → 40% margin needs a charge ≥ 83.33/unit.
    // A 20% LINE discount drives the charge to 80 → blocked without the
    // below-minimum permission (no override needed to trigger the floor).
    const discounted = await saleWith(plainToken, [
      { variantId: variantPriced, quantity: 1, unitPrice: 100, discount: { type: "percentage", value: 20 } },
    ], {
      payments: [{ method: "cash", amount: 80, tendered: 80 }],
    });
    assert.equal(discounted.status, 400);
    assert.match(String((discounted.json as { message: string }).message), /margin/i);

    // Quote warns with the margin detail.
    const q = await quoteWith(token, [
      { variantId: variantPriced, quantity: 1, discount: { type: "percentage", value: 20 } },
    ]);
    const warnings = (q.json as { data: { warnings: { marginPercent: number; floorMarginPercent: number }[] } }).data.warnings;
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.floorMarginPercent, 40);
    assert.ok(warnings[0]!.marginPercent < 40);

    // Overrider + reason → approved.
    const approved = await saleWith(overriderToken, [
      { variantId: variantPriced, quantity: 1, unitPrice: 100, discount: { type: "percentage", value: 20 } },
    ], {
      payments: [{ method: "cash", amount: 80, tendered: 80 }],
      belowMinimumReason: "Clearance, owner approved",
    });
    assert.equal(approved.status, 201, JSON.stringify(approved.json));

    // No priced batches → the margin check CANNOT run (never priced from
    // nothing): a low override on variantNoBatch goes through with a warning
    // only when a price floor exists (it does not here).
    const noBatch = await saleWith(overriderToken, [
      { variantId: variantNoBatch, quantity: 1, unitPrice: 100, discount: null, priceOverride: { unitPrice: 10 } },
    ], {
      payments: [{ method: "cash", amount: 10, tendered: 10 }],
    });
    assert.equal(noBatch.status, 201, JSON.stringify(noBatch.json));

    const reset = await api("PUT", "/api/pricing/settings", { minMarginPercent: null });
    assert.equal(reset.status, 200);
  });

  it("renders the attribution breakdown on the receipt", async () => {
    const sale = await saleWith(overriderToken, [
      { variantId: variantPriced, quantity: 1, unitPrice: 100, discount: null, priceOverride: { unitPrice: 70, reason: "Loyalty gesture" } },
    ], {
      payments: [{ method: "cash", amount: 70, tendered: 70 }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.json));
    const saleId = (sale.json as { data: { sale: { id: number } } }).data.sale.id;
    const receipt = await api("GET", `/api/sales/${saleId}/receipt`);
    assert.equal(receipt.status, 200);
    const line = (receipt.json as {
      items: { priceAdjustments: { kind: string; name: string | null; amount: number; reason: string | null }[] }[];
    }).items[0]!;
    const overrideEntry = line.priceAdjustments.find((a) => a.name === "Price override");
    assert.ok(overrideEntry);
    assert.equal(overrideEntry.amount, 30);
    assert.equal(overrideEntry.reason, "Loyalty gesture");
  });
});
