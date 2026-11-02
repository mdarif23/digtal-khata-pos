/**
 * Hosted storefront platform (website platform stage 1) — integration tests:
 * storefront lifecycle (create → draft → publish → versions → restore),
 * subdomain rules, entitlement/limit gates, custom-domain flow, TLS-ask
 * policy, tenant isolation, pages, product visibility, zones, payment
 * methods and media upload policy — against a REAL PostgreSQL database.
 * Double-guarded like the other suites.
 *
 * Plain `npm test` NEVER runs this file.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

// Object storage env must be set BEFORE env.ts is evaluated (this suite is
// the only process importing it), so the presign path is exercised. The
// suite registers many owners in one run — lift the auth rate limit too.
process.env.AUTH_RATE_LIMIT_MAX = "10000";
process.env.REFRESH_RATE_LIMIT_MAX = "10000";
process.env.S3_ACCESS_KEY_ID = "it-access-key";
process.env.S3_SECRET_ACCESS_KEY = "it-secret-key";
process.env.S3_ENDPOINT = "http://127.0.0.1:9"; // nothing listens here
process.env.S3_BUCKET = "ezpos-media-test";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("storefront platform integration", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";
  let pg: import("pg").Client | null = null;
  let internalToken = "";

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

    // Persistent test DB: clear leftovers from earlier runs so the suite is
    // idempotent (subdomains/domains are globally unique). Businesses from
    // earlier runs stay (RESTRICT FKs) — only platform rows are removed.
    await client.query("DELETE FROM subscriptions WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'SFP %')");
    await client.query("DELETE FROM subscription_plans WHERE slug LIKE 'sfp-plan-%'");
    await client.query("DELETE FROM storefronts WHERE subdomain LIKE 'sfp-%'");
    await client.query(
      "DELETE FROM storefront_domains WHERE domain LIKE '%.example.test' OR domain LIKE 'sfp-%'",
    );
    await client.query("DELETE FROM storefront_media");

    const { ensureRbacSeed } = await import("../rbac/seed.js");
    await ensureRbacSeed();
    const { env } = await import("../config/env.js");
    internalToken = env.internalApiToken;

    const { buildApp } = await import("../app.js");
    const app = buildApp();
    server = app.listen(0);
    const address = server.address() as import("node:net").AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    server?.close();
    await pg?.end();
    pg = null;
  });

  let counter = 0;
  const uniqueEmail = () =>
    `sfp-${Date.now()}-${(counter += 1)}@example.test`;

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
        fullName: "Storefront Platform Test",
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
    return {
      token: loginBody.accessToken,
      businessId: bizBody.business.id,
      userId: loginBody.user.id,
      email,
    };
  }

  /** Dedicated plan with exact features/limits for the business's subscription. */
  async function setBusinessPlan(
    businessId: number,
    plan: {
      limits?: Record<string, number> | null;
      features?: Record<string, boolean> | null;
    },
  ): Promise<void> {
    counter += 1;
    const slug = `sfp-plan-${Date.now()}-${counter}`;
    const created = await pg!.query(
      `INSERT INTO subscription_plans (name, slug, interval, price, currency, limits, features, is_active)
       VALUES ($1, $2, 'monthly', 500, 'BDT', $3::jsonb, $4::jsonb, true) RETURNING id`,
      [
        `SFP plan ${counter}`,
        slug,
        plan.limits ? JSON.stringify(plan.limits) : null,
        plan.features ? JSON.stringify(plan.features) : null,
      ],
    );
    await pg!.query(
      `UPDATE subscriptions SET plan_id = $1, status = 'active', current_period_end = now() + interval '30 days'
       WHERE business_id = $2 AND status IN ('trialing','active','past_due')`,
      [created.rows[0]!.id, businessId],
    );
  }

  function internalApi(
    method: string,
    path: string,
    token?: string,
  ): Promise<{ status: number; body: any; text: string }> {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: token ? { "x-internal-token": token } : {},
    }).then(async (res) => {
      const text = await res.text();
      return {
        status: res.status,
        text,
        body: text ? JSON.parse(text) : null,
      };
    });
  }

  async function seedProduct(businessId: number): Promise<number> {
    counter += 1;
    const product = await pg!.query(
      `INSERT INTO products (business_id, name, description, product_type, tracking_type, status)
       VALUES ($1, $2, 'Platform test product', 'physical', 'none', 'active') RETURNING id`,
      [businessId, `SFP Product ${counter}`],
    );
    return product.rows[0]!.id as number;
  }

  // -----------------------------------------------------------------------
  // Storefront lifecycle
  // -----------------------------------------------------------------------

  it("requires authentication and plan feature", async () => {
    const res = await fetch(`${baseUrl}/api/businesses/1/storefronts`);
    assert.equal(res.status, 401);

    const owner = await createOwnerCtx("SFP No Feature Co");
    await setBusinessPlan(owner.businessId, { features: { multiLocation: true } });
    const denied = await api(owner, "POST", `/api/businesses/${owner.businessId}/storefronts`, {
      name: "No feature store",
      themeId: "aura-fashion",
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body?.code, "FEATURE_NOT_IN_PLAN");
  });

  it("creates a storefront with theme defaults, auto subdomain and a verified subdomain row", async () => {
    const owner = await createOwnerCtx("SFP Create Co");
    await setBusinessPlan(owner.businessId, {
      features: { hostedStorefront: true },
    });

    const res = await api(owner, "POST", `/api/businesses/${owner.businessId}/storefronts`, {
      name: "Main Shop",
      themeId: "aura-fashion",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.status, "draft");
    assert.match(res.body.data.subdomain, /^sfp-create-co(-\d+)?$/);
    assert.equal(res.body.data.themeId, "aura-fashion");
    // Theme defaults must parse (announced sections exist).
    const config = res.body.data.draftConfig;
    assert.ok(Array.isArray(config.sections) && config.sections.length >= 3);

    const detail = await api(
      owner,
      "GET",
      `/api/businesses/${owner.businessId}/storefronts/${res.body.data.id}`,
    );
    assert.equal(detail.status, 200);
    const subdomainRow = detail.body.data.domains.find(
      (d: any) => d.kind === "subdomain",
    );
    assert.ok(subdomainRow);
    assert.equal(subdomainRow.status, "verified");
    assert.equal(subdomainRow.isPrimary, true);

    // Storefront URL is exposed as subdomain + base domain shape.
    assert.match(`${res.body.data.subdomain}.ezpos.store`, /\.ezpos\.store$/);
  });

  it("rejects reserved/duplicate subdomains and enforces maxStorefronts", async () => {
    const owner = await createOwnerCtx("SFP Subdomain Co");
    await setBusinessPlan(owner.businessId, {
      features: { hostedStorefront: true },
      limits: { maxStorefronts: 1 },
    });

    const reserved = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts`,
      { name: "Bad", themeId: "aura-fashion", subdomain: "www" },
    );
    assert.equal(reserved.status, 400);

    const first = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts`,
      { name: "First", themeId: "cornerstone-general", subdomain: "sfp-unique-shop" },
    );
    assert.equal(first.status, 201);

    const duplicate = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts`,
      { name: "Dup", themeId: "aura-fashion", subdomain: "sfp-unique-shop" },
    );
    assert.equal(duplicate.status, 409);

    const overLimit = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts`,
      { name: "Second", themeId: "aura-fashion", subdomain: "sfp-second-shop" },
    );
    assert.equal(overLimit.status, 403);
    assert.equal(overLimit.body?.code, "PLAN_LIMIT_REACHED");
  });

  it("publishes versioned snapshots, keeps drafts off the live config, restores old versions", async () => {
    const owner = await createOwnerCtx("SFP Publish Co");
    await setBusinessPlan(owner.businessId, { features: { hostedStorefront: true } });
    const created = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts`,
      { name: "Publish Shop", themeId: "volt-electronics" },
    );
    const sfId = created.body.data.id as number;

    // Draft edit before publish.
    const draftPatch = await api(
      owner,
      "PATCH",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/draft-config`,
      {
        draftConfig: {
          tokens: { primaryColor: "#123456" },
          sections: [
            {
              id: "hero-1",
              type: "hero",
              props: { heading: "Draft heading", align: "left", overlayOpacity: 0 },
            },
          ],
        },
      },
    );
    assert.equal(draftPatch.status, 200);

    // Invalid config is rejected with a field message.
    const invalid = await api(
      owner,
      "PATCH",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/draft-config`,
      { draftConfig: { tokens: { primaryColor: "not-a-color" } } },
    );
    assert.equal(invalid.status, 400);

    const publish1 = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/publish`,
    );
    assert.equal(publish1.status, 200);
    assert.equal(publish1.body.data.versionNumber, 1);

    const publish2 = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/publish`,
    );
    assert.equal(publish2.body.data.versionNumber, 2);

    const versions = await api(
      owner,
      "GET",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/versions`,
    );
    assert.equal(versions.status, 200);
    assert.equal(versions.body.data.length, 2);

    const restore = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/versions/${versions.body.data[1].id}/restore`,
    );
    assert.equal(restore.status, 200);
    assert.equal(restore.body.data.versionNumber, 3);

    // Publish-time validation: corrupt the draft via SQL, expect 400.
    await pg!.query(
      `UPDATE storefronts SET draft_config = '{"tokens":{"primaryColor":"nope"}}'::jsonb WHERE id = $1`,
      [sfId],
    );
    const badPublish = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/publish`,
    );
    assert.equal(badPublish.status, 400);
  });

  it("unpublishes and archives", async () => {
    const owner = await createOwnerCtx("SFP Lifecycle Co");
    await setBusinessPlan(owner.businessId, { features: { hostedStorefront: true } });
    const created = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts`,
      { name: "Cycle Shop", themeId: "cornerstone-general" },
    );
    const sfId = created.body.data.id as number;
    await api(owner, "POST", `/api/businesses/${owner.businessId}/storefronts/${sfId}/publish`);

    const unpublish = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/unpublish`,
    );
    assert.equal(unpublish.status, 200);
    const detail = await api(
      owner,
      "GET",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}`,
    );
    assert.equal(detail.body.data.status, "draft");

    const archive = await api(
      owner,
      "DELETE",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}`,
    );
    assert.equal(archive.status, 200);
    const gone = await api(
      owner,
      "GET",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}`,
    );
    assert.equal(gone.status, 404);
  });

  // -----------------------------------------------------------------------
  // Cross-tenant isolation
  // -----------------------------------------------------------------------

  it("isolates storefronts across businesses", async () => {
    const ownerA = await createOwnerCtx("SFP Iso A");
    const ownerB = await createOwnerCtx("SFP Iso B");
    await setBusinessPlan(ownerA.businessId, { features: { hostedStorefront: true } });
    await setBusinessPlan(ownerB.businessId, { features: { hostedStorefront: true } });

    const created = await api(
      ownerA,
      "POST",
      `/api/businesses/${ownerA.businessId}/storefronts`,
      { name: "A shop", themeId: "aura-fashion", subdomain: "sfp-iso-a-shop" },
    );
    const sfId = created.body.data.id as number;

    const crossGet = await api(
      ownerB,
      "GET",
      `/api/businesses/${ownerA.businessId}/storefronts/${sfId}`,
    );
    // B is not a member of A's business — indistinguishable from missing.
    assert.ok([403, 404].includes(crossGet.status));

    // B cannot mutate or publish A's storefront through B's own route path.
    const crossPublish = await api(
      ownerB,
      "POST",
      `/api/businesses/${ownerB.businessId}/storefronts/${sfId}/publish`,
    );
    assert.ok([403, 404].includes(crossPublish.status));

    const crossDomain = await api(
      ownerB,
      "POST",
      `/api/businesses/${ownerB.businessId}/storefronts/${sfId}/domains`,
      { domain: "hijack.example.test" },
    );
    assert.ok([403, 404].includes(crossDomain.status));

    const crossVisibility = await api(
      ownerB,
      "PUT",
      `/api/businesses/${ownerB.businessId}/storefronts/${sfId}/products/1`,
      { published: true },
    );
    assert.ok([403, 404].includes(crossVisibility.status));
  });

  // -----------------------------------------------------------------------
  // Domains + TLS ask
  // -----------------------------------------------------------------------

  it("custom domains: feature gate, pending + token, verification failure recorded, primary rules, removal", async () => {
    const owner = await createOwnerCtx("SFP Domains Co");
    await setBusinessPlan(owner.businessId, { features: { hostedStorefront: true } });
    const created = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts`,
      { name: "Domain Shop", themeId: "cornerstone-general", subdomain: "sfp-domain-shop" },
    );
    const sfId = created.body.data.id as number;

    // No storefrontCustomDomains feature yet.
    await setBusinessPlan(owner.businessId, { features: { hostedStorefront: true } });
    const denied = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/domains`,
      { domain: "shop.example.test" },
    );
    assert.equal(denied.status, 403);

    await setBusinessPlan(owner.businessId, {
      features: { hostedStorefront: true, storefrontCustomDomains: true },
      limits: { maxCustomDomains: 2 },
    });

    // Platform subdomains can never be attached as custom domains.
    const baseDomainAttempt = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/domains`,
      { domain: "sfp-hijack.ezpos.store" },
    );
    assert.equal(baseDomainAttempt.status, 400);

    const added = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/domains`,
      { domain: "shop.example.test" },
    );
    assert.equal(added.status, 201);
    assert.equal(added.body.data.status, "pending");
    assert.ok(added.body.data.verificationToken);

    // Duplicate (same tenant) → conflict.
    const duplicate = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/domains`,
      { domain: "shop.example.test" },
    );
    assert.equal(duplicate.status, 409);

    // Verification without real DNS → still pending, error recorded.
    const verify = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/domains/${added.body.data.id}/verify`,
    );
    assert.equal(verify.status, 200);
    assert.equal(verify.body.data.status, "pending");
    assert.ok(verify.body.data.lastError);

    // Pending domain cannot be primary.
    const primary = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/domains/${added.body.data.id}/make-primary`,
    );
    assert.equal(primary.status, 403);

    // TLS ask refuses the unverified domain.
    const askPending = await internalApi(
      "GET",
      `/api/internal/tls/ask?domain=shop.example.test`,
      internalToken,
    );
    assert.equal(askPending.status, 403);

    // Mark verified via SQL (simulating successful DNS proof).
    await pg!.query(
      `UPDATE storefront_domains SET status = 'verified', verified_at = now() WHERE id = $1`,
      [added.body.data.id],
    );
    const askVerified = await internalApi(
      "GET",
      `/api/internal/tls/ask?domain=shop.example.test`,
      internalToken,
    );
    assert.equal(askVerified.status, 200);

    const makePrimary = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/domains/${added.body.data.id}/make-primary`,
    );
    assert.equal(makePrimary.status, 200);

    // Quota: 1 custom domain (maxCustomDomains=2, subdomain row doesn't count).
    const second = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/domains`,
      { domain: "second.example.test" },
    );
    assert.equal(second.status, 201);
    const third = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/domains`,
      { domain: "third.example.test" },
    );
    assert.equal(third.status, 403);
    assert.equal(third.body?.code, "PLAN_LIMIT_REACHED");

    const remove = await api(
      owner,
      "DELETE",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/domains/${added.body.data.id}`,
    );
    assert.equal(remove.status, 200);
  });

  // -----------------------------------------------------------------------
  // Internal resolution
  // -----------------------------------------------------------------------

  it("internal resolve: unknown host unresolved; published host serves snapshot; preview serves draft; token required", async () => {
    const owner = await createOwnerCtx("SFP Resolve Co");
    await setBusinessPlan(owner.businessId, { features: { hostedStorefront: true } });
    const created = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts`,
      { name: "Resolve Shop", themeId: "freshmart-grocery", subdomain: "sfp-resolve-shop" },
    );
    const sfId = created.body.data.id as number;

    // Token enforced.
    const noToken = await internalApi("GET", `/api/internal/storefront/resolve?host=sfp-resolve-shop.ezpos.store`);
    assert.equal(noToken.status, 401);
    const badToken = await internalApi("GET", `/api/internal/storefront/resolve?host=sfp-resolve-shop.ezpos.store`, "wrong-token");
    assert.equal(badToken.status, 401);

    const unresolved = await internalApi(
      "GET",
      `/api/internal/storefront/resolve?host=unknown.ezpos.store`,
      internalToken,
    );
    assert.equal(unresolved.status, 200);
    assert.equal(unresolved.body.data.resolved, false);

    // Publish v1 → resolve returns snapshot config.
    const published = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/publish`,
    );
    assert.equal(published.status, 200);

    const resolved = await internalApi(
      "GET",
      `/api/internal/storefront/resolve?host=sfp-resolve-shop.ezpos.store`,
      internalToken,
    );
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.data.resolved, true);
    assert.equal(resolved.body.data.storefront.storefrontId, sfId);
    assert.equal(resolved.body.data.storefront.source, "published");
    assert.equal(resolved.body.data.storefront.publishedVersion, 1);

    // Draft edit must NOT leak into the published payload.
    await api(
      owner,
      "PATCH",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/draft-config`,
      {
        draftConfig: {
          tokens: { primaryColor: "#abcdef" },
          sections: [],
        },
      },
    );
    const afterDraft = await internalApi(
      "GET",
      `/api/internal/storefront/resolve?host=sfp-resolve-shop.ezpos.store`,
      internalToken,
    );
    assert.equal(afterDraft.body.data.storefront.source, "published");
    assert.notDeepEqual(afterDraft.body.data.storefront.config, {
      tokens: { primaryColor: "#abcdef" },
      sections: [],
    });

    // Preview token serves the DRAFT config.
    const preview = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/preview-token`,
    );
    assert.equal(preview.status, 200);
    const previewResolve = await internalApi(
      "GET",
      `/api/internal/storefront/resolve?host=sfp-resolve-shop.ezpos.store&preview=${preview.body.data.token}`,
      internalToken,
    );
    assert.equal(previewResolve.status, 200);
    assert.equal(previewResolve.body.data.storefront.source, "preview");
    assert.equal(previewResolve.body.data.storefront.config.tokens.primaryColor, "#abcdef");

    // Unpublish → live resolution stops.
    await api(owner, "POST", `/api/businesses/${owner.businessId}/storefronts/${sfId}/unpublish`);
    const afterUnpublish = await internalApi(
      "GET",
      `/api/internal/storefront/resolve?host=sfp-resolve-shop.ezpos.store`,
      internalToken,
    );
    assert.equal(afterUnpublish.body.data.resolved, false);
  });

  it("subdomain change validates and detects conflicts", async () => {
    const owner = await createOwnerCtx("SFP Rebase Co");
    await setBusinessPlan(owner.businessId, { features: { hostedStorefront: true } });
    const created = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts`,
      { name: "Rebase Shop", themeId: "cornerstone-general", subdomain: "sfp-rebase-shop" },
    );
    const sfId = created.body.data.id as number;

    const reserved = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/subdomain`,
      { subdomain: "api" },
    );
    assert.equal(reserved.status, 400);

    const conflict = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/subdomain`,
      { subdomain: "sfp-domain-shop" },
    );
    assert.equal(conflict.status, 409);

    const ok = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/${sfId}/subdomain`,
      { subdomain: "sfp-rebase-shop-2" },
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.subdomain, "sfp-rebase-shop-2");
  });

  // -----------------------------------------------------------------------
  // Pages, product visibility, zones, payment methods
  // -----------------------------------------------------------------------

  it("pages: create with structured blocks, duplicate slug conflict, update, delete", async () => {
    const owner = await createOwnerCtx("SFP Pages Co");
    await setBusinessPlan(owner.businessId, { features: { hostedStorefront: true } });
    const created = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts`,
      { name: "Pages Shop", themeId: "cornerstone-general" },
    );
    const sfId = created.body.data.id as number;
    const base = `/api/businesses/${owner.businessId}/storefronts/${sfId}/pages`;

    const createdPage = await api(owner, "POST", base, {
      slug: "about-us",
      title: "About Us",
      blocks: [
        { type: "heading", text: "Our story", level: 2 },
        { type: "paragraph", text: "We sell things." },
      ],
    });
    assert.equal(createdPage.status, 201);

    const duplicate = await api(owner, "POST", base, {
      slug: "about-us",
      title: "Duplicate",
    });
    assert.equal(duplicate.status, 409);

    // Raw blocks with script tags in text are fine — rendering escapes; but
    // unknown block TYPES must be rejected.
    const badBlock = await api(owner, "POST", base, {
      slug: "bad",
      title: "Bad",
      blocks: [{ type: "raw-html", html: "<script>x</script>" }],
    });
    assert.equal(badBlock.status, 400);

    const updated = await api(owner, "PATCH", `${base}/${createdPage.body.data.id}`, {
      title: "About Us v2",
      isPublished: false,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.isPublished, false);

    const deleted = await api(owner, "DELETE", `${base}/${createdPage.body.data.id}`);
    assert.equal(deleted.status, 200);
  });

  it("product visibility: upsert per storefront, cost fields never exposed, cross-business product rejected", async () => {
    const ownerA = await createOwnerCtx("SFP Vis A");
    const ownerB = await createOwnerCtx("SFP Vis B");
    await setBusinessPlan(ownerA.businessId, { features: { hostedStorefront: true } });
    const created = await api(
      ownerA,
      "POST",
      `/api/businesses/${ownerA.businessId}/storefronts`,
      { name: "Vis Shop", themeId: "cornerstone-general" },
    );
    const sfId = created.body.data.id as number;
    const productId = await seedProduct(ownerA.businessId);
    const foreignProductId = await seedProduct(ownerB.businessId);

    const upsert = await api(
      ownerA,
      "PUT",
      `/api/businesses/${ownerA.businessId}/storefronts/${sfId}/products/${productId}`,
      { published: true, featured: true, seoTitle: "Buy this" },
    );
    assert.equal(upsert.status, 200);
    assert.equal(upsert.body.data.published, true);

    const foreign = await api(
      ownerA,
      "PUT",
      `/api/businesses/${ownerA.businessId}/storefronts/${sfId}/products/${foreignProductId}`,
      { published: true },
    );
    assert.equal(foreign.status, 404);

    const list = await api(
      ownerA,
      "GET",
      `/api/businesses/${ownerA.businessId}/storefronts/${sfId}/products`,
    );
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 1);
    const raw = JSON.stringify(list.body);
    assert.ok(!raw.includes("cost"), "cost fields must never be exposed");
    assert.ok(!raw.includes("supplier"), "supplier fields must never be exposed");

    const remove = await api(
      ownerA,
      "DELETE",
      `/api/businesses/${ownerA.businessId}/storefronts/${sfId}/products/${productId}`,
    );
    assert.equal(remove.status, 200);
  });

  it("delivery zones and payment methods CRUD", async () => {
    const owner = await createOwnerCtx("SFP Settings Co");
    await setBusinessPlan(owner.businessId, { features: { hostedStorefront: true } });
    const created = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts`,
      { name: "Settings Shop", themeId: "freshmart-grocery" },
    );
    const sfId = created.body.data.id as number;
    const zonesBase = `/api/businesses/${owner.businessId}/storefronts/${sfId}/delivery-zones`;

    const zone = await api(owner, "POST", zonesBase, {
      name: "Dhaka city",
      areas: ["Dhanmondi", "Gulshan"],
      rate: 60,
      freeThreshold: 2000,
    });
    assert.equal(zone.status, 201);

    const zoneUpdated = await api(
      owner,
      "PATCH",
      `${zonesBase}/${zone.body.data.id}`,
      { rate: 80 },
    );
    assert.equal(zoneUpdated.status, 200);
    assert.equal(Number(zoneUpdated.body.data.rate), 80);

    const invalidZone = await api(owner, "POST", zonesBase, {
      name: "No areas",
      areas: [],
      rate: 10,
    });
    assert.equal(invalidZone.status, 400);

    const pmBase = `/api/businesses/${owner.businessId}/storefronts/${sfId}/payment-methods`;
    const pm = await api(owner, "PUT", pmBase, {
      methods: [
        { method: "cod", enabled: true, label: "Cash on delivery" },
        { method: "sslcommerz", enabled: false },
      ],
    });
    assert.equal(pm.status, 200);
    assert.equal(pm.body.data.length, 2);

    const pmGet = await api(owner, "GET", pmBase);
    assert.equal(pmGet.status, 200);
    assert.equal(pmGet.body.data.length, 2);
  });

  // -----------------------------------------------------------------------
  // Media
  // -----------------------------------------------------------------------

  it("media: presign issues scoped SigV4 URLs, quota enforced, register requires a real upload", async () => {
    const owner = await createOwnerCtx("SFP Media Co");
    await setBusinessPlan(owner.businessId, {
      features: { hostedStorefront: true },
      limits: { maxMediaStorageMb: 1 },
    });

    // Disallowed content type.
    const badType = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/media/presign`,
      { fileName: "x.svg", contentType: "image/svg+xml", sizeBytes: 100 },
    );
    assert.equal(badType.status, 400);

    // Over quota.
    const overQuota = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/media/presign`,
      { fileName: "big.png", contentType: "image/png", sizeBytes: 2 * 1024 * 1024 },
    );
    assert.equal(overQuota.status, 403);
    assert.equal(overQuota.body?.code, "PLAN_LIMIT_REACHED");

    // Valid presign — scoped key + signature.
    const presign = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/media/presign`,
      { fileName: "logo.png", contentType: "image/png", sizeBytes: 1024 },
    );
    assert.equal(presign.status, 200);
    assert.match(
      presign.body.data.objectKey,
      new RegExp(`^businesses/${owner.businessId}/storefront/[0-9a-f-]+\\.png$`),
    );
    assert.ok(presign.body.data.uploadUrl.includes("X-Amz-Signature="));
    assert.ok(presign.body.data.publicUrl.endsWith(presign.body.data.objectKey));

    // Registering without completing the upload fails (HEAD to a dead endpoint).
    const register = await api(
      owner,
      "POST",
      `/api/businesses/${owner.businessId}/storefronts/media/register`,
      {
        objectKey: presign.body.data.objectKey,
        fileName: "logo.png",
        contentType: "image/png",
        bytes: 1024,
      },
    );
    assert.equal(register.status, 400);

    // Another business's object key is rejected outright.
    const ownerB = await createOwnerCtx("SFP Media B");
    await setBusinessPlan(ownerB.businessId, { features: { hostedStorefront: true } });
    const crossKey = await api(
      ownerB,
      "POST",
      `/api/businesses/${ownerB.businessId}/storefronts/media/register`,
      {
        objectKey: presign.body.data.objectKey,
        fileName: "logo.png",
        contentType: "image/png",
        bytes: 1024,
      },
    );
    assert.equal(crossKey.status, 400);
  });
});
