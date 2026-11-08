/**
 * Pricing rules integration tests — Phase 2 (report §18 P2 gate: precedence
 * tests green). Covers: rule CRUD with scope-conflict conflicts, the
 * variant > product > nearest-category-ancestor > global > settings-default
 * resolution chain, materialization to the effective selling price (locked
 * row, price history row, audit entry), minimum-floor blocking, fixed rules
 * without cost, history pagination + cost stripping, permissions, and
 * tenant isolation.
 *
 * The Phase-2 CRUD covers global + category scopes; the product/variant
 * RESOLUTION arms are exercised via absence-fallthrough here and gain CRUD
 * in Phase 3.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("pricing rules integration", { skip: !runIntegration }, () => {
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
    `pricing-rules-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let childCategoryId = 0;
  let parentCategoryId = 0;
  let grandCategoryId = 0;
  let variantId = 0; // cost 50, sells 100, category = child
  let noStockVariantId = 0;
  let locationId = 0;

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

  before(async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Rules Owner",
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
    token = ((await login.json()) as { accessToken: string }).accessToken;
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: `Rules Biz ${Date.now()}` }),
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

    // Category tree: Grandparent > Parent > Child.
    const grand = await api("POST", "/api/product/category", {
      categoryName: `Grand ${Date.now()}`,
      parentCategoryId: null,
      description: "",
      status: "active",
    });
    assert.equal(grand.status, 201);
    grandCategoryId = grand.json.data.value;
    const parent = await api("POST", "/api/product/category", {
      categoryName: `Parent ${Date.now()}`,
      parentCategoryId: grandCategoryId,
      description: "",
      status: "active",
    });
    assert.equal(parent.status, 201);
    parentCategoryId = parent.json.data.value;
    const child = await api("POST", "/api/product/category", {
      categoryName: `Child ${Date.now()}`,
      parentCategoryId,
      description: "",
      status: "active",
    });
    assert.equal(child.status, 201);
    childCategoryId = child.json.data.value;

    // Product in the child category with opening stock (cost 50, price 100).
    const unit = await api("POST", "/api/product/unit", {
      unitName: `Rules Unit ${Date.now()}`,
      abbreviation: "ru",
    });
    const unitId = (unit.json as { data: { value: number } }).data.value;
    const prod = await api("POST", "/api/product", {
      name: `Rules Product ${Date.now()}`,
      categoryId: childCategoryId,
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
      source: "opening",
      variants: [
        {
          sku: "",
          barcode: null,
          sellingPrice: 100,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: "",
          purchasePrice: 50,
          quantity: 50,
          expiryDate: null,
        },
      ],
    });
    assert.equal(prod.status, 201, JSON.stringify(prod.json));
    const list = await api("GET", "/api/products");
    const found = (list.json as { id: number; name: string }[]).find((p) =>
      p.name.startsWith("Rules Product"),
    )!;
    const detail = await api("GET", `/api/product/${found.id}`);
    variantId = (detail.json as { variants: { id: number }[] }).variants[0]!.id;

    // Second product with no priced batches (registered for purchase).
    const unit2 = await api("POST", "/api/product/unit", {
      unitName: `Rules Unit 2 ${Date.now()}`,
      abbreviation: "r2",
    });
    const unit2Id = (unit2.json as { data: { value: number } }).data.value;
    const prod2 = await api("POST", "/api/product", {
      name: `Rules Empty ${Date.now()}`,
      categoryId: null,
      brandId: null,
      unitId: unit2Id,
      description: "",
      productType: "physical",
      hasVariants: false,
      trackingType: "none",
      supplierId: null,
      status: "active",
      imageUrl: null,
      imageFile: null,
      source: "purchase",
      variants: [
        {
          sku: "",
          barcode: null,
          sellingPrice: 100,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: "",
          purchasePrice: 50,
          quantity: 0,
          expiryDate: null,
        },
      ],
    });
    assert.equal(prod2.status, 201, JSON.stringify(prod2.json));
    const list2 = await api("GET", "/api/products");
    const found2 = (list2.json as { id: number; name: string }[]).find((p) =>
      p.name.startsWith("Rules Empty"),
    )!;
    const detail2 = await api("GET", `/api/product/${found2.id}`);
    noStockVariantId = (detail2.json as { variants: { id: number }[] })
      .variants[0]!.id;

    // Deterministic settings: markup 25% default, no rounding, no floor.
    const settings = await api("PUT", "/api/pricing/settings", {
      defaultMethod: "markup",
      defaultPercentage: 25,
    });
    assert.equal(settings.status, 200);
  });

  // --- CRUD ------------------------------------------------------------------

  it("creates a global rule; a second active global rule conflicts (409)", async () => {
    const create = await api("POST", "/api/pricing/rules", {
      method: "markup",
      percentage: 30,
    });
    assert.equal(create.status, 201, JSON.stringify(create.json));
    const dup = await api("POST", "/api/pricing/rules", {
      method: "margin",
      percentage: 20,
    });
    assert.equal(dup.status, 409);

    const list = await api("GET", "/api/pricing/rules");
    assert.equal(list.status, 200);
    const rows = list.json.data as {
      id: number;
      scope: string;
      scopeLabel: string;
      isActive: boolean;
      percentage: number | null;
    }[];
    const global = rows.find((r) => r.scope === "Global" && r.isActive);
    assert.ok(global);
    assert.equal(global.scopeLabel, "Whole business");
    assert.equal(global.percentage, 30);
  });

  it("validates rule shapes: margin 100, fixed+percentage, multi-scope → 400", async () => {
    const badMargin = await api("POST", "/api/pricing/rules", {
      categoryId: childCategoryId,
      method: "margin",
      percentage: 100,
    });
    assert.equal(badMargin.status, 400);
    const badFixed = await api("POST", "/api/pricing/rules", {
      method: "fixed",
      fixedPrice: 50,
      percentage: 10,
    });
    assert.equal(badFixed.status, 400);
    const badScope = await api("POST", "/api/pricing/rules", {
      categoryId: childCategoryId,
      productId: 999999,
      method: "markup",
      percentage: 10,
    });
    assert.equal(badScope.status, 400);
  });

  // --- precedence ------------------------------------------------------------
  // State at this point: global rule markup 30 (active), settings markup 25.

  it("category rule beats the global rule; settings is the last fallback", async () => {
    const childRule = await api("POST", "/api/pricing/rules", {
      categoryId: childCategoryId,
      method: "margin",
      percentage: 20,
    });
    assert.equal(childRule.status, 201);
    const childRuleId = (childRule.json as { data: { id: number } }).data.id;

    // Cost 50: margin 20% → 62.50 (child rule wins over global 30% → 65).
    const preview = await api("POST", "/api/pricing/preview", {
      variantIds: [variantId],
    });
    const row = (preview.json as { data: { source: { kind: string; ruleId: number | null }; recommendedPrice: number | null }[] }).data[0]!;
    assert.equal(row.source.kind, "category_rule");
    assert.equal(row.source.ruleId, childRuleId);
    assert.equal(row.recommendedPrice, 62.5);

    // Deactivate the child rule → global rule (markup 30 → 65) wins.
    const deact = await api("PATCH", `/api/pricing/rules/${childRuleId}`, {
      isActive: false,
    });
    assert.equal(deact.status, 200);
    const preview2 = await api("POST", "/api/pricing/preview", {
      variantIds: [variantId],
    });
    const row2 = (preview2.json as { data: { source: { kind: string }; recommendedPrice: number | null }[] }).data[0]!;
    assert.equal(row2.source.kind, "global_rule");
    assert.equal(row2.recommendedPrice, 65);

    // Deactivate the global rule → settings default (markup 25 → 62.50).
    const list = await api("GET", "/api/pricing/rules");
    const globalRule = (
      list.json.data as { id: number; scope: string; isActive: boolean }[]
    ).find((r) => r.scope === "Global" && r.isActive)!;
    await api("PATCH", `/api/pricing/rules/${globalRule.id}`, {
      isActive: false,
    });
    const preview3 = await api("POST", "/api/pricing/preview", {
      variantIds: [variantId],
    });
    const row3 = (preview3.json as { data: { source: { kind: string }; recommendedPrice: number | null }[] }).data[0]!;
    assert.equal(row3.source.kind, "settings_default");
    assert.equal(row3.recommendedPrice, 62.5);

    // Re-activate the child rule for the ancestor tests below.
    await api("PATCH", `/api/pricing/rules/${childRuleId}`, { isActive: true });
    // And leave the global rule inactive — ancestor rules will be created next.
  });

  it("nearest category ancestor wins over a farther ancestor", async () => {
    const parentRule = await api("POST", "/api/pricing/rules", {
      categoryId: parentCategoryId,
      method: "markup",
      percentage: 10,
    });
    assert.equal(parentRule.status, 201);
    const parentRuleId = (parentRule.json as { data: { id: number } }).data.id;
    const grandRule = await api("POST", "/api/pricing/rules", {
      categoryId: grandCategoryId,
      method: "markup",
      percentage: 5,
    });
    assert.equal(grandRule.status, 201);
    const grandRuleId = (grandRule.json as { data: { id: number } }).data.id;

    // Child rule (margin 20 → 62.50) still wins over both ancestors.
    const preview = await api("POST", "/api/pricing/preview", {
      variantIds: [variantId],
    });
    const row = (preview.json as { data: { source: { kind: string }; recommendedPrice: number | null }[] }).data[0]!;
    assert.equal(row.source.kind, "category_rule");
    assert.equal(row.recommendedPrice, 62.5);

    // Deactivate child → parent (markup 10 → 55) beats grandparent (5 → 52.50).
    const list = await api("GET", "/api/pricing/rules");
    const rows = list.json.data as { id: number; scope: string; scopeLabel: string; isActive: boolean }[];
    const childRule = rows.find(
      (r) => r.scope === "Category" && r.scopeLabel.startsWith("Child") && r.isActive,
    )!;
    await api("PATCH", `/api/pricing/rules/${childRule.id}`, { isActive: false });
    const preview2 = await api("POST", "/api/pricing/preview", {
      variantIds: [variantId],
    });
    const row2 = (preview2.json as { data: { source: { kind: string }; recommendedPrice: number | null }[] }).data[0]!;
    assert.equal(row2.source.kind, "category_rule");
    assert.equal(row2.recommendedPrice, 55);

    // Deactivate parent → grandparent (5% → 52.50).
    await api("PATCH", `/api/pricing/rules/${parentRuleId}`, { isActive: false });
    const preview3 = await api("POST", "/api/pricing/preview", {
      variantIds: [variantId],
    });
    const row3 = (preview3.json as { data: { source: { kind: string }; recommendedPrice: number | null }[] }).data[0]!;
    assert.equal(row3.recommendedPrice, 52.5);

    // Reactivate parent for the materialization test; keep grandparent active.
    await api("PATCH", `/api/pricing/rules/${parentRuleId}`, { isActive: true });
    void grandRuleId;
  });

  it("re-activating a rule that collides with another active rule → 409", async () => {
    // Parent currently active; creating another parent-scope rule is fine
    // while INACTIVE, but activating it conflicts.
    const draft = await api("POST", "/api/pricing/rules", {
      categoryId: parentCategoryId,
      method: "margin",
      percentage: 40,
      isActive: false,
    });
    assert.equal(draft.status, 201);
    const draftId = (draft.json as { data: { id: number } }).data.id;
    const conflict = await api("PATCH", `/api/pricing/rules/${draftId}`, {
      isActive: true,
    });
    assert.equal(conflict.status, 409);
    await api("DELETE", `/api/pricing/rules/${draftId}`);
  });

  // --- materialization ---------------------------------------------------------

  it("applies the resolved rule price to the selling price with history + audit", async () => {
    // Parent rule markup 10% on cost 50 → 55 (child deactivated, global off).
    const apply = await api("PUT", `/api/pricing/products/${variantId}/price`, {
      reason: "Phase 2 materialization test",
    });
    assert.equal(apply.status, 200, JSON.stringify(apply.json));
    const result = (apply.json as { data: { applied: boolean; oldPrice: number; newPrice: number; source: { kind: string }; ruleId: number | null } }).data;
    assert.equal(result.applied, true);
    assert.equal(result.oldPrice, 100);
    assert.equal(result.newPrice, 55);
    assert.equal(result.source.kind, "category_rule");
    assert.notEqual(result.ruleId, null);

    // Effective price actually moved (the ONE sanctioned write path).
    const view = await api("GET", `/api/pricing/products/${variantId}/price`);
    const viewData = (view.json as { data: { currentSellingPrice: number } }).data;
    assert.equal(viewData.currentSellingPrice, 55);

    // History row exists with old/new/source/rule/cost.
    const history = await api("GET", "/api/pricing/history", undefined, {});
    const historyRow = (
      history.json as {
        rows: {
          variantId: number;
          oldPrice: number | null;
          newPrice: number;
          source: string;
          ruleId: number | null;
          costAtChange: number | null;
          reason: string | null;
        }[];
      }
    ).rows[0]!;
    assert.equal(historyRow.variantId, variantId);
    assert.equal(historyRow.oldPrice, 100);
    assert.equal(historyRow.newPrice, 55);
    assert.equal(historyRow.source, "rule_apply");
    assert.equal(historyRow.ruleId, result.ruleId);
    assert.equal(historyRow.costAtChange, 50);
    assert.equal(historyRow.reason, "Phase 2 materialization test");

    // Audit entry recorded.
    const audit = await pgClient!.query(
      `SELECT 1 FROM audit_log WHERE business_id = $1 AND action = 'pricing.price.applied'
         AND entity_type = 'product_variant' AND entity_id = $2 LIMIT 1`,
      [businessId, variantId],
    );
    assert.equal(audit.rowCount, 1);

    // Idempotent re-apply: price already equals the recommendation.
    const again = await api("PUT", `/api/pricing/products/${variantId}/price`, {});
    assert.equal(again.status, 200);
    assert.equal((again.json as { data: { applied: boolean; unchanged?: boolean } }).data.applied, false);
    assert.equal((again.json as { data: { unchanged?: boolean } }).data.unchanged, true);
  });

  it("blocks materialization below the minimum floor and leaves the price untouched", async () => {
    await pgClient!.query(
      `UPDATE product_variants SET min_selling_price = 70 WHERE id = $1`,
      [variantId],
    );
    // Change the parent rule to margin 20% (50/0.8 = 62.50 < floor 70).
    const list = await api("GET", "/api/pricing/rules");
    const parentRule = (
      list.json.data as { id: number; scope: string; scopeLabel: string; isActive: boolean }[]
    ).find((r) => r.scope === "Category" && r.scopeLabel.startsWith("Parent") && r.isActive)!;
    await api("PATCH", `/api/pricing/rules/${parentRule.id}`, {
      method: "margin",
      percentage: 20,
    });

    const apply = await api("PUT", `/api/pricing/products/${variantId}/price`, {});
    assert.equal(apply.status, 409);

    // The effective price and history are untouched.
    const view = await api("GET", `/api/pricing/products/${variantId}/price`);
    assert.equal((view.json as { data: { currentSellingPrice: number } }).data.currentSellingPrice, 55);
    const history = await api("GET", "/api/pricing/history");
    assert.equal((history.json as { meta: { total: number } }).meta.total, 1);
    await pgClient!.query(
      `UPDATE product_variants SET min_selling_price = NULL WHERE id = $1`,
      [variantId],
    );
  });

  it("materialization without priced cost → explicit conflict, never zero", async () => {
    // Grandparent rule (markup 5%) is the active rule for the no-stock
    // variant (category NULL → walks only the global arm... grandparent does
    // NOT apply to a category-less product; the global rule is inactive, so
    // settings default markup 25% applies → needs cost → unavailable).
    const apply = await api("PUT", `/api/pricing/products/${noStockVariantId}/price`, {});
    assert.equal(apply.status, 409);
    const message = (apply.json as { message?: string }).message ?? "";
    assert.match(message, /priced inventory|cost/i);
  });

  it("materializes a fixed rule without needing any cost", async () => {
    // Deactivate any active category rule; a global FIXED rule prices the
    // no-stock variant with no cost resolution at all.
    const list = await api("GET", "/api/pricing/rules");
    const activeCategoryRule = (
      list.json.data as { id: number; scope: string; isActive: boolean }[]
    ).find((r) => r.scope === "Category" && r.isActive);
    if (activeCategoryRule) {
      await api("PATCH", `/api/pricing/rules/${activeCategoryRule.id}`, {
        isActive: false,
      });
    }
    const globalFixed = await api("POST", "/api/pricing/rules", {
      method: "fixed",
      fixedPrice: 79.99,
    });
    assert.equal(globalFixed.status, 201);

    const apply = await api("PUT", `/api/pricing/products/${noStockVariantId}/price`, {});
    assert.equal(apply.status, 200);
    const result = (apply.json as { data: { applied: boolean; newPrice: number | null; source: { kind: string } } }).data;
    assert.equal(result.applied, true);
    assert.equal(result.newPrice, 79.99);
    assert.equal(result.source.kind, "global_rule");
  });

  it("produces no duplicate history on an unchanged re-apply (per-variant filter + pagination)", async () => {
    const again = await api("PUT", `/api/pricing/products/${noStockVariantId}/price`, {});
    assert.equal(again.status, 200);
    assert.equal((again.json as { data: { applied: boolean } }).data.applied, false);

    const history = await api(
      "GET",
      `/api/pricing/history?variantId=${noStockVariantId}&page=1&pageSize=25`,
    );
    const body = history.json as {
      rows: { newPrice: number }[];
      meta: { total: number; page: number; pageSize: number };
    };
    assert.equal(body.meta.total, 1);
    assert.equal(body.rows[0]!.newPrice, 79.99);
  });

  // --- permissions + isolation -------------------------------------------------

  it("enforces permissions: pricing.view can read, only pricing.manage/pricing.product.manage can write", async () => {
    const roleRes = await api("POST", "/api/roles", {
      name: `Rules Viewer ${Date.now()}`,
      permissionKeys: ["pricing.view"],
    });
    assert.equal(roleRes.status, 201);
    const roleId = (roleRes.json as { data: { id: number } }).data.id;
    const userRes = await api("POST", "/api/users", {
      fullName: "Rules Viewer",
      email: uniqueEmail(),
      password: "strong-password-123",
      roleIds: [roleId],
      locationIds: [locationId],
    });
    const viewerEmail = (userRes.json as { data: { email: string } }).data.email;
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: viewerEmail, password: "strong-password-123" }),
    });
    const viewerToken = ((await login.json()) as { accessToken: string }).accessToken;

    const readRules = await fetch(`${baseUrl}/api/pricing/rules`, {
      headers: { Authorization: `Bearer ${viewerToken}`, "X-Business-Id": String(businessId) },
    });
    assert.equal(readRules.status, 200);
    const writeRule = await fetch(`${baseUrl}/api/pricing/rules`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${viewerToken}`,
        "X-Business-Id": String(businessId),
      },
      body: JSON.stringify({ method: "markup", percentage: 10 }),
    });
    assert.equal(writeRule.status, 403);
    const applyPrice = await fetch(`${baseUrl}/api/pricing/products/${variantId}/price`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${viewerToken}`,
        "X-Business-Id": String(businessId),
      },
      body: JSON.stringify({}),
    });
    assert.equal(applyPrice.status, 403);
    const history = await fetch(`${baseUrl}/api/pricing/history`, {
      headers: { Authorization: `Bearer ${viewerToken}`, "X-Business-Id": String(businessId) },
    });
    assert.equal(history.status, 403); // viewer lacks pricing.history.view
  });

  it("keeps tenants isolated: business B sees no rules and cannot read foreign pricing", async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Rules B", email, password: "strong-password-123" }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    const tokenB = ((await login.json()) as { accessToken: string }).accessToken;
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ name: `Rules Biz B ${Date.now()}` }),
    });
    const businessIdB = ((await biz.json()) as { business: { id: number } }).business.id;
    const locB = await fetch(`${baseUrl}/api/locations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenB}`,
        "X-Business-Id": String(businessIdB),
      },
      body: JSON.stringify({ name: "Main Store" }),
    });
    assert.equal(locB.status, 201);

    const rules = await fetch(`${baseUrl}/api/pricing/rules`, {
      headers: { Authorization: `Bearer ${tokenB}`, "X-Business-Id": String(businessIdB) },
    });
    assert.equal(((await rules.json()) as { data: unknown[] }).data.length, 0);

    const foreign = await fetch(`${baseUrl}/api/pricing/products/${variantId}/price`, {
      headers: { Authorization: `Bearer ${tokenB}`, "X-Business-Id": String(businessIdB) },
    });
    assert.equal(foreign.status, 404);
  });
});
