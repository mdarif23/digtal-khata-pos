/**
 * Pricing integration tests — Phase 1 (settings + preview engine end to end).
 *
 * Covers: settings defaults/CRUD with cross-field validation, cost-provider
 * resolution (available / unavailable / not-required), markup/margin/fixed
 * previews through the approved engine, final-stage rounding, minimum-price
 * floors, cost visibility stripping (products.view_cost), permission
 * enforcement, role-preset + retro-grant verification, and tenant isolation.
 *
 * Effective-price separation invariant: every read here must NOT change
 * product_variants.selling_price — previews never persist.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("pricing integration", { skip: !runIntegration }, () => {
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
    `pricing-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  // --- owner fixture (business A) -------------------------------------------
  let token = "";
  let businessId = 0;
  let locationId = 0;
  let variantId = 0; // opening stock: cost 50, sells 100
  let noStockVariantId = 0; // no priced batches

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

  async function createOwnerWithBusiness(label: string) {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: `${label} Owner`,
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
    const accessToken = ((await login.json()) as { accessToken: string })
      .accessToken;
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ name: `Pricing ${label} ${Date.now()}` }),
    });
    assert.equal(biz.status, 201);
    const newBusinessId = ((await biz.json()) as { business: { id: number } })
      .business.id;
    const loc = await fetch(`${baseUrl}/api/locations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "X-Business-Id": String(newBusinessId),
      },
      body: JSON.stringify({ name: "Main Store" }),
    });
    assert.equal(loc.status, 201);
    return { accessToken, businessId: newBusinessId };
  }

  async function createProduct(
    label: string,
    opts: {
      sellingPrice: number;
      purchasePrice: number;
      quantity: number;
      /** "opening" stocks a priced batch; "purchase" registers with no batch. */
      source?: "opening" | "purchase";
    },
  ) {
    const source = opts.source ?? "opening";
    const unit = await api("POST", "/api/product/unit", {
      unitName: `${label} Unit ${Date.now()}`,
      abbreviation: "pu",
    });
    assert.equal(unit.status, 201);
    const unitId = (unit.json as { data: { value: number } }).data.value;
    const prod = await api("POST", "/api/product", {
      name: `${label} Product`,
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
      source,
      variants: [
        {
          sku: "",
          barcode: null,
          sellingPrice: opts.sellingPrice,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: source === "opening" ? "" : "",
          purchasePrice: opts.purchasePrice,
          quantity: opts.quantity,
          expiryDate: null,
        },
      ],
    });
    assert.equal(prod.status, 201, JSON.stringify(prod.json));
    const list = await api("GET", "/api/products");
    const found = (list.json as { id: number; name: string }[]).find(
      (p) => p.name === `${label} Product`,
    )!;
    const detail = await api("GET", `/api/product/${found.id}`);
    return (detail.json as { variants: { id: number }[] }).variants[0]!.id;
  }

  before(async () => {
    const owner = await createOwnerWithBusiness("A");
    token = owner.accessToken;
    businessId = owner.businessId;
    const locs = await api("GET", "/api/locations");
    locationId = (locs.json as { data: { id: number }[] }).data[0]!.id;
    variantId = await createProduct("Pricing", {
      sellingPrice: 100,
      purchasePrice: 50,
      quantity: 50,
    });
    noStockVariantId = await createProduct("Pricing Empty", {
      sellingPrice: 100,
      purchasePrice: 50,
      quantity: 0,
      source: "purchase",
    });
  });

  // --- settings --------------------------------------------------------------

  it("GET settings returns defaults when no row exists", async () => {
    const res = await api("GET", "/api/pricing/settings");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data, {
      defaultMethod: "fixed",
      defaultPercentage: null,
      roundingIncrement: "none",
      roundingDirection: "nearest",
      autoUpdateEnabled: false,
      autoUpdateFixedPrices: false,
      minMarginPercent: null,
      updatedAt: null,
    });
  });

  it("PUT settings persists markup defaults and rejects invalid cross-fields", async () => {
    const put = await api("PUT", "/api/pricing/settings", {
      defaultMethod: "markup",
      defaultPercentage: 30,
    });
    assert.equal(put.status, 200);
    assert.equal(put.json.data.defaultMethod, "markup");
    assert.equal(put.json.data.defaultPercentage, 30);
    assert.notEqual(put.json.data.updatedAt, null);

    // Margin 100 is a division by zero — rejected by validation AND the DB.
    const badMargin = await api("PUT", "/api/pricing/settings", {
      defaultMethod: "margin",
      defaultPercentage: 100,
    });
    assert.equal(badMargin.status, 400);

    const badFixed = await api("PUT", "/api/pricing/settings", {
      defaultMethod: "fixed",
      defaultPercentage: 10,
    });
    assert.equal(badFixed.status, 400);

    // A partial PUT is merged with the current row and validated as a WHOLE:
    // fixed + inherited percentage 30 must be rejected...
    const badPartial = await api("PUT", "/api/pricing/settings", {
      defaultMethod: "fixed",
    });
    assert.equal(badPartial.status, 400);

    // ...while margin + inherited percentage 30 is a legal merge.
    const goodPartial = await api("PUT", "/api/pricing/settings", {
      defaultMethod: "margin",
    });
    assert.equal(goodPartial.status, 200);
    assert.equal(goodPartial.json.data.defaultMethod, "margin");

    // Deterministic state for the tests that follow.
    const reset = await api("PUT", "/api/pricing/settings", {
      defaultMethod: "markup",
      defaultPercentage: 30,
    });
    assert.equal(reset.status, 200);

    const get = await api("GET", "/api/pricing/settings");
    assert.equal(get.json.data.defaultMethod, "markup");
    assert.equal(get.json.data.defaultPercentage, 30);
  });

  // --- preview: the engine end to end ---------------------------------------

  it("previews markup 30% from the settings default with the weighted-avg cost", async () => {
    const res = await api("POST", "/api/pricing/preview", {
      variantIds: [variantId],
    });
    assert.equal(res.status, 200);
    const row = res.json.data[0];
    assert.equal(row.variantId, variantId);
    assert.equal(row.source.kind, "settings_default");
    assert.equal(row.method, "markup");
    assert.equal(row.percentage, 30);
    assert.equal(row.costStatus, "available");
    assert.equal(row.cost, 50); // opening batch: purchase 50, no landed cost
    assert.equal(row.currentSellingPrice, 100);
    // 50 × 1.30 = 65 — the effective price is NOT touched by previews.
    assert.equal(row.recommendedPrice, 65);
    assert.deepEqual(row.minimumViolations, []);
  });

  it("separation invariant: previews never change the selling price", async () => {
    const detail = await api("GET", "/api/products");
    const row = (detail.json as { id: number; variants: { sellingPrice: number }[] }[])
      .flatMap((p) => p.variants)
      .find((v) => v.sellingPrice !== undefined);
    assert.ok(row);
    // The product above sells at 100; the 65 recommendation was never applied.
    assert.equal(row.sellingPrice, 100);
  });

  it("previews a request override (margin 20% → 50/0.8 = 62.50) and fixed price", async () => {
    const marginRes = await api("POST", "/api/pricing/preview", {
      variantIds: [variantId],
      method: "margin",
      percentage: 20,
    });
    assert.equal(marginRes.status, 200);
    const marginRow = marginRes.json.data[0];
    assert.equal(marginRow.source.kind, "request_override");
    assert.equal(marginRow.recommendedPrice, 62.5);

    const fixedRes = await api("POST", "/api/pricing/preview", {
      variantIds: [variantId],
      method: "fixed",
      fixedPrice: 199.99,
    });
    assert.equal(fixedRes.status, 200);
    const fixedRow = fixedRes.json.data[0];
    assert.equal(fixedRow.costStatus, "not_required");
    assert.equal(fixedRow.recommendedPrice, 199.99);

    // Margin 100 → 400 (never a division by zero).
    const bad = await api("POST", "/api/pricing/preview", {
      variantIds: [variantId],
      method: "margin",
      percentage: 100,
    });
    assert.equal(bad.status, 400);
  });

  it("applies the configured rounding exactly once at the final stage", async () => {
    await api("PUT", "/api/pricing/settings", {
      roundingIncrement: "10",
      roundingDirection: "nearest",
    });
    const nearest = await api("POST", "/api/pricing/preview", {
      variantIds: [variantId],
    });
    assert.equal(nearest.json.data[0].recommendedPrice, 70); // 65 → 70

    await api("PUT", "/api/pricing/settings", {
      roundingIncrement: "10",
      roundingDirection: "down",
    });
    const down = await api("POST", "/api/pricing/preview", {
      variantIds: [variantId],
    });
    assert.equal(down.json.data[0].recommendedPrice, 60); // 65 → 60

    await api("PUT", "/api/pricing/settings", {
      roundingIncrement: "none",
      roundingDirection: "nearest",
    });
  });

  it("flags minimum-price and margin-floor violations without fabricating cost", async () => {
    // Business-wide margin floor 40%: 30% markup on cost 50 → 65 → margin
    // 15/65 = 23.08% → violation.
    await api("PUT", "/api/pricing/settings", { minMarginPercent: 40 });
    const floorRes = await api("POST", "/api/pricing/preview", {
      variantIds: [variantId],
    });
    assert.deepEqual(floorRes.json.data[0].minimumViolations, [
      "minimum_margin",
    ]);

    // Per-variant explicit floor 70 → 65 also violates minimum_price.
    await pgClient!.query(
      `UPDATE product_variants SET min_selling_price = 70 WHERE id = $1`,
      [variantId],
    );
    const bothRes = await api("POST", "/api/pricing/preview", {
      variantIds: [variantId],
    });
    assert.deepEqual(bothRes.json.data[0].minimumViolations, [
      "minimum_price",
      "minimum_margin",
    ]);
    await pgClient!.query(
      `UPDATE product_variants SET min_selling_price = NULL WHERE id = $1`,
      [variantId],
    );
    await api("PUT", "/api/pricing/settings", { minMarginPercent: null });

    // Fixed method needs no cost and cannot violate the margin floor.
    const fixedRes = await api("POST", "/api/pricing/preview", {
      variantIds: [variantId],
      method: "fixed",
      fixedPrice: 10,
    });
    assert.deepEqual(fixedRes.json.data[0].minimumViolations, []);
  });

  it("reports explicit cost_unavailable instead of pricing from zero", async () => {
    const res = await api("POST", "/api/pricing/preview", {
      variantIds: [noStockVariantId],
    });
    assert.equal(res.status, 200);
    const row = res.json.data[0];
    assert.equal(row.costStatus, "unavailable");
    assert.equal(row.recommendedPrice, null);
    assert.ok(row.unavailableReason.length > 0);
  });

  it("strips cost fields for pricing.view callers without products.view_cost", async () => {
    // Custom role: pricing.view WITHOUT products.view_cost.
    const roleRes = await api("POST", "/api/roles", {
      name: `Pricing Viewer ${Date.now()}`,
      permissionKeys: ["pricing.view", "products.view"],
    });
    assert.equal(roleRes.status, 201);
    const roleId = (roleRes.json as { data: { id: number } }).data.id;

    const userRes = await api("POST", "/api/users", {
      fullName: "Pricing Viewer",
      email: uniqueEmail(),
      password: "strong-password-123",
      roleIds: [roleId],
      locationIds: [locationId],
    });
    assert.equal(userRes.status, 201);
    const viewerEmail = userRes.json.data.email as string;

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: viewerEmail,
        password: "strong-password-123",
      }),
    });
    const viewerToken = ((await login.json()) as { accessToken: string })
      .accessToken;

    const res = await fetch(`${baseUrl}/api/pricing/preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${viewerToken}`,
        "X-Business-Id": String(businessId),
        "X-Location-Id": String(locationId),
      },
      body: JSON.stringify({ variantIds: [variantId] }),
    });
    assert.equal(res.status, 200);
    const row = ((await res.json()) as { data: { cost: number | null }[] })
      .data[0]!;
    assert.equal(row.cost, null); // stripped

    // Same caller without pricing.view on a guarded route → 403.
    const settingsRes = await fetch(`${baseUrl}/api/pricing/settings`, {
      headers: {
        Authorization: `Bearer ${viewerToken}`,
        "X-Business-Id": String(businessId),
      },
    });
    assert.equal(settingsRes.status, 200); // pricing.view grants the read

    const putRes = await fetch(`${baseUrl}/api/pricing/settings`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${viewerToken}`,
        "X-Business-Id": String(businessId),
      },
      body: JSON.stringify({ roundingIncrement: "5" }),
    });
    assert.equal(putRes.status, 403); // no pricing.manage
  });

  it("verifies the new-business role presets carry pricing keys", async () => {
    // ensureDefaultRolesInTx built this business's roles from
    // DEFAULT_ROLE_PERMISSIONS — the manager preset includes pricing.manage.
    const { rows } = await pgClient!.query(
      `SELECT p.key
         FROM roles r
         JOIN role_permissions rp ON rp.role_id = r.id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.business_id = $1 AND r.slug = 'manager' AND p.key = 'pricing.manage'`,
      [businessId],
    );
    assert.equal(rows.length, 1);
  });

  it("enforces tenant isolation — another business cannot preview foreign variants", async () => {
    const other = await createOwnerWithBusiness("B");
    const res = await fetch(`${baseUrl}/api/pricing/preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${other.accessToken}`,
        "X-Business-Id": String(other.businessId),
      },
      body: JSON.stringify({ variantIds: [variantId] }),
    });
    assert.equal(res.status, 404);
  });
});
