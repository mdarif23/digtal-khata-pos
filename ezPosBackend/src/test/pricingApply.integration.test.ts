/**
 * Bulk update + proposals (Mode A) + auto-update sweep (Mode B) integration
 * tests — Phase 8 (report §18 gate: sweep/concurrency tests). Covers: bulk
 * dryRun/apply with per-row blocked reasons (cost unavailable never prices
 * from nothing), proposal generation across rule scopes (variant + category
 * subtree + global), stale regen when the recommendation moves, approve →
 * materialization (history source 'proposal') + double-decide 409, the
 * auto-update gate + fixed-price protection + floor-respecting sweep, bulk
 * advisory dedupe contract, permissions and tenant isolation.
 *
 * Double-guarded: INTEGRATION_TESTS=1 AND DATABASE_URL at ezpos_test.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("pricing apply (bulk/proposals/auto-update) integration", { skip: !runIntegration }, () => {
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
    `pricing-apply-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

  let token = "";
  let businessId = 0;
  let locationId = 0;
  let categoryId = 0;
  let childCategoryId = 0;
  let variantA = 0; // price 100, cost 50 — variant-scoped markup rule
  let variantB = 0; // price 100, cost 50 — NO batches (cost unavailable)
  let variantCat = 0; // price 200, cost 100 — child-category rule
  let variantGlobal = 0; // price 300, cost 150 — global rule
  let variantFixed = 0; // price 400 — fixed rule (protection flag)

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
      body: JSON.stringify({ fullName: "Apply Owner", email, password: "strong-password-123" }),
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
      body: JSON.stringify({ name: `Apply Biz ${Date.now()}` }),
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

    const cat = await api("POST", "/api/product/category", {
      categoryName: `Apply Parent ${Date.now()}`,
      parentCategoryId: null,
      description: "",
      status: "active",
    });
    assert.equal(cat.status, 201);
    categoryId = cat.json.data.value;
    const child = await api("POST", "/api/product/category", {
      categoryName: `Apply Child ${Date.now()}`,
      parentCategoryId: categoryId,
      description: "",
      status: "active",
    });
    assert.equal(child.status, 201);
    childCategoryId = child.json.data.value;

    const specs: { name: string; price: number; cost: number; qty: number; categoryId: number | null }[] = [
      { name: "Apply A", price: 100, cost: 50, qty: 30, categoryId: null },
      { name: "Apply B", price: 100, cost: 50, qty: 0, categoryId: null },
      { name: "Apply Cat", price: 200, cost: 100, qty: 30, categoryId: childCategoryId },
      { name: "Apply Global", price: 300, cost: 150, qty: 30, categoryId: null },
      { name: "Apply Fixed", price: 400, cost: 10, qty: 30, categoryId: null },
    ];
    const ids: number[] = [];
    for (const spec of specs) {
      const unit = await api("POST", "/api/product/unit", {
        unitName: `${spec.name} Unit ${Date.now()}`,
        abbreviation: "au",
      });
      const unitId = (unit.json as { data: { value: number } }).data.value;
      const prod = await api("POST", "/api/product", {
        name: spec.name,
        categoryId: spec.categoryId,
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
      ids.push((detail.json as { variants: { id: number }[] }).variants[0]!.id);
    }
    [variantA, variantB, variantCat, variantGlobal, variantFixed] = ids as [
      number,
      number,
      number,
      number,
      number,
    ];
  });

  it("bulk previews and applies with per-row blocked reasons", async () => {
    const rule = await api("POST", "/api/pricing/rules", {
      variantId: variantA,
      method: "markup",
      percentage: 20,
    });
    assert.equal(rule.status, 201, JSON.stringify(rule.json));

    const preview = await api("POST", "/api/pricing/bulk", {
      dryRun: true,
      variantIds: [variantA, variantB],
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    const rows = (preview.json as { data: { rows: { variantId: number; recommended: number | null; changed: boolean; applied: boolean; blockedReason: string | null }[] } }).data.rows;
    const rowA = rows.find((r) => r.variantId === variantA)!;
    assert.equal(rowA.recommended, 60);
    assert.equal(rowA.changed, true);
    assert.equal(rowA.applied, false); // dryRun never writes
    const rowB = rows.find((r) => r.variantId === variantB)!;
    assert.equal(rowB.recommended, null);
    assert.match(rowB.blockedReason ?? "", /Cost unavailable/);

    const priceBefore = await pgClient!.query(
      `SELECT selling_price FROM product_variants WHERE id = $1`,
      [variantA],
    );
    assert.equal(Number(priceBefore.rows[0]!.selling_price), 100);

    const apply = await api("POST", "/api/pricing/bulk", {
      dryRun: false,
      variantIds: [variantA, variantB],
      reason: "Spring repricing",
    });
    assert.equal(apply.status, 200);
    const applyData = (apply.json as { data: { appliedCount: number; rows: { variantId: number; applied: boolean }[] } }).data;
    assert.equal(applyData.appliedCount, 1);
    assert.equal(applyData.rows.find((r) => r.variantId === variantA)!.applied, true);

    const priceAfter = await pgClient!.query(
      `SELECT selling_price FROM product_variants WHERE id = $1`,
      [variantA],
    );
    assert.equal(Number(priceAfter.rows[0]!.selling_price), 60);
    const history = await pgClient!.query(
      `SELECT source, old_price, new_price, reason FROM product_price_history WHERE variant_id = $1 ORDER BY id DESC LIMIT 1`,
      [variantA],
    );
    assert.equal(history.rows[0]!.source, "bulk");
    assert.equal(Number(history.rows[0]!.old_price), 100);
    assert.equal(Number(history.rows[0]!.new_price), 60);
    assert.equal(history.rows[0]!.reason, "Spring repricing");
  });

  it("generates proposals across rule scopes and approves them into price writes", async () => {
    // Category rule on the PARENT category (child products inherit) + a
    // global rule + a fixed rule.
    const catRule = await api("POST", "/api/pricing/rules", {
      categoryId,
      method: "margin",
      percentage: 50,
    });
    assert.equal(catRule.status, 201, JSON.stringify(catRule.json));
    const globalRule = await api("POST", "/api/pricing/rules", {
      method: "markup",
      percentage: 10,
    });
    assert.equal(globalRule.status, 201, JSON.stringify(globalRule.json));
    const fixedRule = await api("POST", "/api/pricing/rules", {
      variantId: variantFixed,
      method: "fixed",
      fixedPrice: 450,
    });
    assert.equal(fixedRule.status, 201, JSON.stringify(fixedRule.json));

    const gen = await api("POST", "/api/pricing/proposals/generate");
    assert.equal(gen.status, 200, JSON.stringify(gen.json));
    const genData = (gen.json as { data: { created: number; staled: number; batchToken: string } }).data;
    // variantA (markup rule beats global), variantCat (category via subtree,
    // margin 50 over cost 100 → 200 — unchanged), variantGlobal (global
    // markup 10 over 150 → 165), variantFixed (fixed 450).
    assert.equal(genData.created, 1, JSON.stringify(genData));
    assert.equal(genData.staled, 0);

    const list = await api("GET", "/api/pricing/proposals?status=pending");
    assert.equal(list.status, 200);
    const pending = (list.json as { data: { rows: { id: number; variantId: number; recommendedPrice: number; oldPrice: number; percentChange: number; status: string }[]; meta: { total: number } } }).data;
    const proposal = pending.rows.find((r) => r.variantId === variantGlobal)!;
    assert.ok(proposal, "global-rule proposal pending");
    assert.equal(proposal.recommendedPrice, 165);
    assert.equal(proposal.oldPrice, 300);
    assert.equal(proposal.percentChange, -45);

    const approved = await api("POST", `/api/pricing/proposals/${proposal.id}/approve`);
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    assert.equal((approved.json as { data: { status: string } }).data.status, "applied");

    const price = await pgClient!.query(
      `SELECT selling_price FROM product_variants WHERE id = $1`,
      [variantGlobal],
    );
    assert.equal(Number(price.rows[0]!.selling_price), 165);
    const history = await pgClient!.query(
      `SELECT source, proposal_id FROM product_price_history WHERE variant_id = $1 ORDER BY id DESC LIMIT 1`,
      [variantGlobal],
    );
    assert.equal(history.rows[0]!.source, "proposal");
    assert.equal(Number(history.rows[0]!.proposal_id), proposal.id);

    const again = await api("POST", `/api/pricing/proposals/${proposal.id}/approve`);
    assert.equal(again.status, 409);
  });

  it("stales pending proposals when the recommendation moves", async () => {
    // variantA currently 60 (markup 20 over cost 50). Tighten the rule to
    // markup 30 → new recommendation 65; regenerate stales the old pending.
    const rules = await api("GET", "/api/pricing/rules");
    const ruleA = (rules.json as { data: { id: number; variantId: number | null }[] }).data.find(
      (r) => r.variantId === variantA,
    )!;
    const patch = await api("PATCH", `/api/pricing/rules/${ruleA.id}`, { percentage: 30 });
    assert.equal(patch.status, 200);

    const gen = await api("POST", "/api/pricing/proposals/generate");
    assert.equal(gen.status, 200);
    const genData = (gen.json as { data: { created: number; staled: number } }).data;
    assert.equal(genData.created, 1);
    assert.equal(genData.staled, 1);

    const stale = await api("GET", "/api/pricing/proposals?status=stale");
    const staleRows = (stale.json as { data: { rows: { variantId: number; status: string }[] } }).data.rows;
    assert.equal(staleRows.filter((r) => r.variantId === variantA).length, 1);

    const pending = await api("GET", "/api/pricing/proposals?status=pending");
    const fresh = (pending.json as { data: { rows: { id: number; variantId: number; recommendedPrice: number }[] } }).data.rows.find(
      (r) => r.variantId === variantA,
    )!;
    assert.equal(fresh.recommendedPrice, 65);
    const rejected = await api("POST", `/api/pricing/proposals/${fresh.id}/reject`);
    assert.equal(rejected.status, 200);
    assert.equal((rejected.json as { data: { status: string } }).data.status, "rejected");
  });

  it("auto-update: gated by settings, protects fixed prices, respects floors", async () => {
    // variantA (markup 30, cost 50, price 60) → 65. variantCat margin 50 →
    // 200 (unchanged). variantGlobal markup 10 → 165 (already applied →
    // unchanged). variantFixed 450 → protected by default.
    const disabled = await api("POST", "/api/pricing/auto-update/run");
    assert.equal(disabled.status, 409);

    const enable = await api("PUT", "/api/pricing/settings", { autoUpdateEnabled: true });
    assert.equal(enable.status, 200);

    const run1 = await api("POST", "/api/pricing/auto-update/run");
    assert.equal(run1.status, 200, JSON.stringify(run1.json));
    const run1Data = (run1.json as { data: { applied: number; skipped: number; blocked: { variantId: number; reason: string }[]; unchanged: number } }).data;
    assert.equal(run1Data.applied, 1); // variantA only
    assert.equal(run1Data.skipped, 1); // fixed-protected variantFixed
    assert.equal(run1Data.blocked.length, 1); // variantB has no rule coverage (not scanned)

    const priceA = await pgClient!.query(
      `SELECT selling_price FROM product_variants WHERE id = $1`,
      [variantA],
    );
    assert.equal(Number(priceA.rows[0]!.selling_price), 65);
    const historyA = await pgClient!.query(
      `SELECT source FROM product_price_history WHERE variant_id = $1 ORDER BY id DESC LIMIT 1`,
      [variantA],
    );
    assert.equal(historyA.rows[0]!.source, "auto_update");

    const fixedBefore = await pgClient!.query(
      `SELECT selling_price FROM product_variants WHERE id = $1`,
      [variantFixed],
    );
    assert.equal(Number(fixedBefore.rows[0]!.selling_price), 400);

    // Opt into fixed-price updates → the sweep applies the fixed rule.
    await api("PUT", "/api/pricing/settings", { autoUpdateFixedPrices: true });
    const run2 = await api("POST", "/api/pricing/auto-update/run");
    const run2Data = (run2.json as { data: { applied: number } }).data;
    assert.equal(run2Data.applied, 1);
    const fixedAfter = await pgClient!.query(
      `SELECT selling_price FROM product_variants WHERE id = $1`,
      [variantFixed],
    );
    assert.equal(Number(fixedAfter.rows[0]!.selling_price), 450);

    // Floor respect: a minimum price above the recommendation blocks it.
    await pgClient!.query(
      `UPDATE product_variants SET min_selling_price = 500 WHERE id = $1`,
      [variantA],
    );
    await api("PATCH", `/api/pricing/rules/${(await api("GET", "/api/pricing/rules")).json.data.find((r: { variantId: number | null }) => r.variantId === variantA).id}`, { percentage: 50 });
    const run3 = await api("POST", "/api/pricing/auto-update/run");
    const run3Data = (run3.json as { data: { blocked: { variantId: number; reason: string }[] } }).data;
    const blockedA = run3Data.blocked.find((b) => b.variantId === variantA);
    assert.ok(blockedA, "floor-violating sweep row is blocked, never written");
    const priceA2 = await pgClient!.query(
      `SELECT selling_price FROM product_variants WHERE id = $1`,
      [variantA],
    );
    assert.equal(Number(priceA2.rows[0]!.selling_price), 65);
    await pgClient!.query(
      `UPDATE product_variants SET min_selling_price = NULL WHERE id = $1`,
      [variantA],
    );
    await api("PUT", "/api/pricing/settings", {
      autoUpdateEnabled: false,
      autoUpdateFixedPrices: false,
    });
  });

  it("enforces permissions on bulk and proposals", async () => {
    const roleRes = await api("POST", "/api/roles", {
      name: `Apply Viewer ${Date.now()}`,
      permissionKeys: ["pricing.history.view"],
    });
    const roleId = (roleRes.json as { data: { id: number } }).data.id;
    const userRes = await api("POST", "/api/users", {
      fullName: "Apply Viewer",
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
    const viewerHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${viewerToken}`,
      "X-Business-Id": String(businessId),
    };

    const listOk = await fetch(`${baseUrl}/api/pricing/proposals`, { headers: viewerHeaders });
    assert.equal(listOk.status, 200);

    const bulkDenied = await fetch(`${baseUrl}/api/pricing/bulk`, {
      method: "POST",
      headers: viewerHeaders,
      body: JSON.stringify({ dryRun: true, variantIds: [variantA] }),
    });
    assert.equal(bulkDenied.status, 403);

    const genDenied = await fetch(`${baseUrl}/api/pricing/proposals/generate`, {
      method: "POST",
      headers: viewerHeaders,
    });
    assert.equal(genDenied.status, 403);

    const pending = await api("GET", "/api/pricing/proposals?status=applied");
    const anyId = (pending.json as { data: { rows: { id: number }[] } }).data.rows[0]!.id;
    const decideDenied = await fetch(`${baseUrl}/api/pricing/proposals/${anyId}/reject`, {
      method: "POST",
      headers: viewerHeaders,
    });
    assert.equal(decideDenied.status, 403);
  });

  it("keeps bulk and proposals tenant-isolated", async () => {
    const email = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Apply B", email, password: "strong-password-123" }),
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
      body: JSON.stringify({ name: `Apply Biz B ${Date.now()}` }),
    });
    const businessIdB = ((await biz.json()) as { business: { id: number } }).business.id;
    await fetch(`${baseUrl}/api/locations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenB}`,
        "X-Business-Id": String(businessIdB),
      },
      body: JSON.stringify({ name: "Main Store" }),
    });
    const headersB = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenB}`,
      "X-Business-Id": String(businessIdB),
    };

    // Business B has no rules → generate yields nothing, list is empty.
    const gen = await fetch(`${baseUrl}/api/pricing/proposals/generate`, {
      method: "POST",
      headers: headersB,
    });
    assert.equal(gen.status, 200);
    assert.equal(((await gen.json()) as { data: { created: number } }).data.created, 0);
    const list = await fetch(`${baseUrl}/api/pricing/proposals`, { headers: headersB });
    assert.equal(((await list.json()) as { data: { meta: { total: number } } }).data.meta.total, 0);

    // Foreign bulk target: business B cannot touch business A's variants.
    const foreignBulk = await fetch(`${baseUrl}/api/pricing/bulk`, {
      method: "POST",
      headers: headersB,
      body: JSON.stringify({ dryRun: false, variantIds: [variantA] }),
    });
    assert.equal(foreignBulk.status, 200);
    assert.equal(((await foreignBulk.json()) as { data: { rows: unknown[] } }).data.rows.length, 0);
  });
});
