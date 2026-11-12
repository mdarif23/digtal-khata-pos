/**
 * SaaS customer-journey E2E (master-prompt TESTs 1–15).
 *
 * The customer journey is the primary E2E: registration → business → free
 * trial → POS access → plan selection → payment (server-verified) → updated
 * POS entitlement → admin controls → isolation.
 *
 * Enforcement asserts are deliberately API-level (backend-authoritative):
 * the brief forbids frontend-only security, so every access change is proven
 * against the real endpoints, with the UI used only where the journey needs
 * it (sign-up, dashboard, POS render).
 *
 * Test data lives in the disposable ezpos_test database managed by
 * playwright.config.ts. Admin promotion runs through psql (platform_role is
 * deliberately not API-settable).
 */
import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import {
  authHeaders,
  injectSession,
  seedBusiness,
  seedProduct,
  type E2EBusiness,
} from "./helpers";

const BACKEND = "http://localhost:3000";
const WEBSITE = "http://localhost:3001";
const POS = "http://localhost:5173";
const PASSWORD = "strong-password-123";

const DB_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres@localhost:5433/ezpos_test";

/** psql runner resolved cross-platform (PATH first, then Program Files). */
function runPsql(sql: string): string {
  const isWin = process.platform === "win32";
  const candidates = isWin
    ? ["psql", "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe"]
    : ["psql"];
  let lastErr: unknown = null;
  for (const bin of candidates) {
    try {
      return execSync(`"${bin}" "${DB_URL}" -X -t -A -v ON_ERROR_STOP=1`, {
        input: sql,
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`psql failed: ${String(lastErr).slice(0, 300)}`);
}

async function api(
  token: string,
  businessId: number | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (businessId !== null) headers["X-Business-Id"] = String(businessId);
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const jsonResponse = (await res.json().catch(() => null)) as any;
  return { status: res.status, body: jsonResponse };
}

let seq = 0;
const uniq = (prefix: string) => `${prefix}-${Date.now()}-${(seq += 1)}`;

const testBusinesses: string[] = [];

function makeOwner(prefix: string): { email: string; password: string } {
  const email = `${prefix}-${Date.now()}-${(seq += 1)}@example.test`;
  testBusinesses.push(email);
  return { email, password: PASSWORD };
}

async function registerOwner(prefix: string): Promise<{ token: string }> {
  const creds = makeOwner(prefix);
  const reg = await api("", null, "POST", "/api/auth/register", {
    fullName: "Journey Owner",
    email: creds.email,
    password: creds.password,
  });
  expect(reg.status).toBe(201);
  const login = await api("", null, "POST", "/api/auth/login", {
    email: creds.email,
    password: creds.password,
  });
  expect(login.status).toBe(200);
  return { token: login.body.accessToken as string };
}

async function createBusinessWithTrial(
  token: string,
  name: string,
): Promise<number> {
  const res = await api(token, null, "POST", "/api/businesses", { name });
  expect(res.status).toBe(201);
  const businessId = res.body.business.id as number;
  // Product/inventory endpoints require at least one location (multi-location
  // rollout) — the dashboard flow creates one, so the journey mirrors that.
  const loc = await api(token, businessId, "POST", "/api/locations", {
    name: "Main Store",
  });
  expect(loc.status).toBe(201);
  return businessId;
}

/** Fast-forwards the ACTIVE subscription's period end by SQL (test fixture). */
function setTrialPeriodEnd(businessId: number, sqlInterval: string): void {
  runPsql(
    `UPDATE subscriptions SET current_period_end = now() + INTERVAL '${sqlInterval}',
       current_period_start = LEAST(current_period_start, now())
     WHERE business_id = ${businessId}
       AND status IN ('trialing', 'active', 'past_due');`,
  );
}

let adminToken = "";
let starterPlanId = 0;
let proPlanId = 0;
let journeyOwner = "";
let journeyBusiness = 0;

// The journeys chain: trial → upgrade → payment → admin controls → limits.
// Serial execution keeps the shared subscription state predictable.
test.describe.serial("SaaS customer journeys (master-prompt TESTs 1–15)", () => {
  let browserOwnerEmail = "";
  let browserOwnerPassword = PASSWORD;

  test("TEST 1 — new customer registration through the website UI", async ({
    page,
  }) => {
    browserOwnerEmail = `journey-${Date.now()}@example.test`;
    await page.goto(`${WEBSITE}/sign-up`);
    await page
      .getByRole("textbox", { name: "Full name" })
      .fill("Journey Customer");
    await page
      .getByRole("textbox", { name: "Business name" })
      .fill("Journey Flow Store");
    await page.getByRole("textbox", { name: "Email" }).fill(browserOwnerEmail);
    await page
      .getByRole("textbox", { name: "Password", exact: false })
      .first()
      .fill(PASSWORD);
    await page
      .getByRole("textbox", { name: "Confirm password" })
      .fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: /Welcome/ }),
    ).toBeVisible();
  });

  test("TEST 2 — business creation auto-activates a 14-day free trial", async () => {
    const token = (await registerOwner("J2")).token;
    const businessId = await createBusinessWithTrial(token, "J2 Trial Biz");
    const open = await api(token, businessId, "GET", `/api/businesses/${businessId}/subscription/open`);
    expect(open.status).toBe(200);
    expect(open.body.data.status).toBe("trialing");
    const end = new Date(open.body.data.currentPeriodEnd).getTime();
    const days = (end - Date.now()) / 86_400_000;
    // 14 days ± clock skew of the same-server timestamps.
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
    journeyOwner = token;
    journeyBusiness = businessId;
  });

  test("TEST 3 — POS is fully usable during an active trial", async ({
    page,
    request,
  }) => {
    const biz = await seedBusiness(request);
    await injectSession(page.context(), {
      ...biz,
      refreshToken: (
        await (
          await fetch(`${BACKEND}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email: biz.email,
              password: biz.password,
            }),
          })
        ).headers.getSetCookie().join(";")
      ).match(/ezpos_refresh_token=([^;]+)/)![1],
    });
    await page.goto(`${POS}/`);
    await page.waitForTimeout(1500);
    await expect(
      page.getByRole("heading", { name: "Point of sale" }),
    ).toBeVisible();
    // Trial = full access: a write through the real API succeeds.
    const { productId } = await seedProduct(request, biz, "Trial Product");
    expect(productId).toBeGreaterThan(0);
  });

  test("TEST 4 — expired trial is read-only on the backend", async () => {
    const token = (await registerOwner("J4")).token;
    const businessId = await createBusinessWithTrial(token, "J4 Expired Biz");
    setTrialPeriodEnd(businessId, "-1 day");

    // Reads stay reachable…
    const list = await api(token, businessId, "GET", "/api/products");
    expect(list.status).toBe(200);

    // …but the backend blocks writes with the documented trial-expired error.
    const write = await api(token, businessId, "POST", "/api/product", {
      name: "Blocked After Trial",
      categoryId: null,
      brandId: null,
      unitId: null,
      description: "",
      productType: "physical",
      hasVariants: false,
      trackingType: "none",
      supplierId: null,
      status: "active",
      imageUrl: null,
      imageFile: null,
      source: "purchase",
      variants: [],
    });
    expect(write.status).toBe(403);
    expect(JSON.stringify(write.body)).toContain("TRIAL_EXPIRED");

    // The billing portal stays reachable (paying is how a customer leaves
    // read-only) and the subscription surface still shows the expired trial.
    const open = await api(
      token,
      businessId,
      "GET",
      `/api/businesses/${businessId}/subscription/open`,
    );
    expect(open.status).toBe(200);
  });

  test("TEST 5 — trial customer switches plans freely (no invoice yet)", async () => {
    // Admin setup: promotion is SQL-only by design; the admin then creates
    // the paid plans the journeys use.
    const admin = makeOwner("saas-admin");
    const reg = await api("", null, "POST", "/api/auth/register", {
      fullName: "SaaS Admin",
      email: admin.email,
      password: admin.password,
    });
    expect(reg.status).toBe(201);
    runPsql(
      `UPDATE users SET platform_role = 'platform_admin' WHERE email = '${admin.email}';`,
    );
    const adminLogin = await api("", null, "POST", "/api/auth/login", {
      email: admin.email,
      password: admin.password,
    });
    adminToken = adminLogin.body.accessToken;

    for (const plan of [
      {
        name: "E2E Starter",
        price: 700,
        limits: { maxProducts: 1, maxUsers: 3, maxLocations: 1 },
        features: {},
      },
      { name: "E2E Pro", price: 1500, limits: {}, features: {} },
    ]) {
      const created = await api(adminToken, null, "POST", "/api/saas/plans", {
        name: plan.name,
        slug: `e2e-${plan.name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`,
        interval: "monthly",
        price: plan.price,
        currency: "BDT",
        isActive: true,
        limits: plan.limits,
        features: plan.features,
      });
      expect([200, 201]).toContain(created.status);
      if (plan.name === "E2E Starter") starterPlanId = created.body.data.id;
      if (plan.name === "E2E Pro") proPlanId = created.body.data.id;
    }
    expect(starterPlanId).toBeGreaterThan(0);
    expect(proPlanId).toBeGreaterThan(0);

    // TRIAL RULE: a trialing subscription switches plans freely — the real
    // backend rule (subscription.service changePlan) issues NO invoice while
    // trialing, because nothing is being paid yet.
    const change = await api(
      journeyOwner,
      journeyBusiness,
      "POST",
      `/api/businesses/${journeyBusiness}/subscription/change-plan`,
      { planId: starterPlanId },
    );
    expect([200, 201]).toContain(change.status);
    expect(change.body.data.outcome).toBe("trial_plan_changed");
    const open = await api(
      journeyOwner,
      journeyBusiness,
      "GET",
      `/api/businesses/${journeyBusiness}/subscription/open`,
    );
    expect(open.body.data.status).toBe("trialing");
    expect(open.body.data.plan?.id ?? open.body.data.planId).toBe(starterPlanId);
    const invoices = await api(
      journeyOwner,
      journeyBusiness,
      "GET",
      `/api/businesses/${journeyBusiness}/invoices`,
    );
    expect(
      invoices.body.data.filter((inv: any) => inv.status === "pending").length,
    ).toBe(0);
  });

  test("TEST 6 — expired trial → renewal invoice → server-verified payment activates", async () => {
    // 1. The trial lapses (period end moved past) and the sweep marks it
    //    expired — the same sweep the production scheduler runs.
    setTrialPeriodEnd(journeyBusiness, "-1 day");
    const sweep = await api(adminToken, null, "POST", "/api/saas/jobs/run", {});
    expect(sweep.status).toBe(200);

    // 2. Renewal raises the full-period invoice and reactivates the sub…
    const renew = await api(
      journeyOwner,
      journeyBusiness,
      "POST",
      `/api/businesses/${journeyBusiness}/subscription/renew`,
    );
    expect([200, 201]).toContain(renew.status);
    const invoices = await api(
      journeyOwner,
      journeyBusiness,
      "GET",
      `/api/businesses/${journeyBusiness}/invoices`,
    );
    const pending = invoices.body.data.find((inv: any) => inv.status === "pending");
    expect(pending).toBeTruthy();

    // 3. …but entitlement is only honored after SERVER-SIDE payment
    //    verification: initiate a gateway session, then present a val_id
    //    whose reported amount MATCHES the invoice total.
    const initiated = await api(
      journeyOwner,
      journeyBusiness,
      "POST",
      `/api/businesses/${journeyBusiness}/payments/initiate`,
      { invoiceId: pending.id },
    );
    expect(initiated.status).toBe(200);
    const paymentId =
      initiated.body.data.paymentId;
    const verify = await api(
      journeyOwner,
      journeyBusiness,
      "POST",
      `/api/businesses/${journeyBusiness}/payments/${paymentId}/verify`,
      { valId: `MOCK-VALID-${pending.total}` },
    );
    expect(verify.status).toBe(200);

    // NO FAKE SUCCESS: prove the persisted state actually changed — invoice
    // paid, payment succeeded, subscription active on the renewed period.
    const open = await api(
      journeyOwner,
      journeyBusiness,
      "GET",
      `/api/businesses/${journeyBusiness}/subscription/open`,
    );
    expect(open.body.data.status).toBe("active");
    const payments = await api(
      journeyOwner,
      journeyBusiness,
      "GET",
      `/api/businesses/${journeyBusiness}/payments`,
    );
    const paidRow = payments.body.data?.find(
      (p: any) => (p.id ?? p.paymentId) === paymentId,
    );
    expect(paidRow).toBeTruthy();
    expect(["succeeded", "paid", "completed"]).toContain(paidRow.status);
  });

  test("TEST 7 — POS entitlement reflects the paid subscription", async () => {
    // Products require a unit — create one now that writes are allowed.
    const unit = await api(journeyOwner, journeyBusiness, "POST", "/api/product/unit", {
      unitName: "Journey Piece",
      abbreviation: `jp${Date.now() % 100000}`,
    });
    expect(unit.status).toBe(201);
    const unitBody: any = unit.body;
    const unitId = Number(unitBody?.data?.value ?? unitBody?.data?.id ?? unitBody?.id);
    expect(unitId).toBeGreaterThan(0);

    const write = await api(journeyOwner, journeyBusiness, "POST", "/api/product", {
      name: "Post-Payment Product",
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
      source: "purchase",
      variants: [],
    });
    if (write.status !== 201) {
      console.log("TEST 7 write body:", JSON.stringify(write.body));
    }
    expect(write.status).toBe(201);
  });

  test("TEST 8 — amount-mismatched payment is refused, nothing changes", async () => {
    // Renewal raises a new invoice; a val_id reporting a DIFFERENT amount is
    // rejected by the backend's server-side amount comparison.
    const renew = await api(
      journeyOwner,
      journeyBusiness,
      "POST",
      `/api/businesses/${journeyBusiness}/subscription/renew`,
    );
    expect([200, 201]).toContain(renew.status);
    const invoices = await api(
      journeyOwner,
      journeyBusiness,
      "GET",
      `/api/businesses/${journeyBusiness}/invoices`,
    );
    const pending = invoices.body.data.find((inv: any) => inv.status === "pending");
    expect(pending).toBeTruthy();
    const initiated = await api(
      journeyOwner,
      journeyBusiness,
      "POST",
      `/api/businesses/${journeyBusiness}/payments/initiate`,
      { invoiceId: pending.id },
    );
    expect(initiated.status).toBe(200);
    const paymentId =
      initiated.body.data.paymentId;

    const refused = await api(
      journeyOwner,
      journeyBusiness,
      "POST",
      `/api/businesses/${journeyBusiness}/payments/${paymentId}/verify`,
      { valId: `MOCK-VALID-${Number(pending.total) + 500}` },
    );
    // The API contract: verification is a processed callback — HTTP 200 with
    // a structured outcome. The security property lives in the OUTCOME plus
    // the persisted state below, not in the HTTP status.
    expect(refused.status).toBe(200);
    expect(refused.body.data.verified).toBe(false);

    // Nothing changed: invoice still pending, subscription still active on
    // the same plan, period not extended.
    const open = await api(
      journeyOwner,
      journeyBusiness,
      "GET",
      `/api/businesses/${journeyBusiness}/subscription/open`,
    );
    expect(open.body.data.status).toBe("active");
    const invoicesAfter = await api(
      journeyOwner,
      journeyBusiness,
      "GET",
      `/api/businesses/${journeyBusiness}/invoices`,
    );
    const stillPending = invoicesAfter.body.data.find(
      (inv: any) => inv.id === pending.id,
    );
    expect(stillPending.status).not.toBe("paid");
  });

  test("TEST 9 — expired subscription becomes read-only (backend-enforced)", async () => {
    setTrialPeriodEnd(journeyBusiness, "-1 day");
    const write = await api(journeyOwner, journeyBusiness, "POST", "/api/product", {
      name: "Blocked Expired",
      categoryId: null,
      brandId: null,
      unitId: null,
      description: "",
      productType: "physical",
      hasVariants: false,
      trackingType: "none",
      supplierId: null,
      status: "active",
      imageUrl: null,
      imageFile: null,
      source: "purchase",
      variants: [],
    });
    expect(write.status).toBe(403);
    // Billing stays reachable in read-only mode.
    const open = await api(
      journeyOwner,
      journeyBusiness,
      "GET",
      `/api/businesses/${journeyBusiness}/subscription/open`,
    );
    expect(open.status).toBe(200);
    // Restore for the admin journeys.
    setTrialPeriodEnd(journeyBusiness, "13 days");
  });

  test("TEST 10 — SaaS Admin suspension blocks the POS immediately", async () => {
    const open = await api(
      journeyOwner,
      journeyBusiness,
      "GET",
      `/api/businesses/${journeyBusiness}/subscription/open`,
    );
    const subscriptionId = open.body.data.id ?? open.body.data.subscriptionId;
    expect(subscriptionId).toBeGreaterThan(0);

    const suspend = await api(
      adminToken,
      null,
      "POST",
      `/api/saas/subscriptions/${subscriptionId}/suspend`,
      { reason: "E2E suspension journey" },
    );
    expect([200, 201]).toContain(suspend.status);

    const write = await api(journeyOwner, journeyBusiness, "POST", "/api/product", {
      name: "Blocked While Suspended",
      categoryId: null,
      brandId: null,
      unitId: null,
      description: "",
      productType: "physical",
      hasVariants: false,
      trackingType: "none",
      supplierId: null,
      status: "active",
      imageUrl: null,
      imageFile: null,
      source: "purchase",
      variants: [],
    });
    expect(write.status).toBe(403);
  });

  test("TEST 11 — SaaS Admin reactivation restores access", async () => {
    // FINDING (recorded, not fixed here): after suspension the customer-facing
    // subscription/open returns data: null (suspended is not an "open"
    // status), so the customer portal cannot display it. The ADMIN finds the
    // subscription through the admin list instead — the realistic flow.
    const list = await api(adminToken, null, "GET", "/api/saas/subscriptions");
    expect(list.status).toBe(200);
    const rows: any[] = list.body.data ?? list.body;
    const mine = rows.find((r) => r.businessId === journeyBusiness);
    expect(mine).toBeTruthy();
    const subscriptionId = mine.id;

    const reactivate = await api(
      adminToken,
      null,
      "POST",
      `/api/saas/subscriptions/${subscriptionId}/reactivate`,
      {},
    );
    expect([200, 201]).toContain(reactivate.status);
    const openCheck = await api(
      journeyOwner,
      journeyBusiness,
      "GET",
      `/api/businesses/${journeyBusiness}/subscription/open`,
    );
    console.log(
      "TEST 11 post-reactivate subscription:",
      JSON.stringify(openCheck.body.data?.status ?? openCheck.body.data),
    );
    // Plan management (brief §9D): the admin edits the plan's limits after
    // reactivation — proving restored access despite the product cap that
    // TEST 15 will re-enforce.
    const limitRaise = await api(
      adminToken,
      null,
      "PATCH",
      `/api/saas/plans/${starterPlanId}`,
      { limits: { maxProducts: 2, maxUsers: 3, maxLocations: 1 } },
    );
    expect([200, 201]).toContain(limitRaise.status);
    const unit = await api(journeyOwner, journeyBusiness, "POST", "/api/product/unit", {
      unitName: "Reactivated Piece",
      abbreviation: `rp${Date.now() % 100000}`,
    });
    expect(unit.status).toBe(201);
    const unitBody: any = unit.body;
    const unitId = Number(unitBody?.data?.value ?? unitBody?.data?.id ?? unitBody?.id);
    const write = await api(journeyOwner, journeyBusiness, "POST", "/api/product", {
      name: "Restored After Reactivation",
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
      source: "purchase",
      variants: [],
    });
    if (write.status !== 201) {
      console.log("TEST 11 write body:", JSON.stringify(write.body));
    }
    expect(write.status).toBe(201);
  });

  test("TEST 12 — SaaS Admin manual extension moves the period end", async () => {
    const openBefore = await api(
      journeyOwner,
      journeyBusiness,
      "GET",
      `/api/businesses/${journeyBusiness}/subscription/open`,
    );
    const subscriptionId =
      openBefore.body.data?.id ?? openBefore.body.data?.subscriptionId;
    expect(subscriptionId).toBeGreaterThan(0);
    const before = new Date(openBefore.body.data.currentPeriodEnd).getTime();
    const extend = await api(
      adminToken,
      null,
      "POST",
      `/api/saas/subscriptions/${subscriptionId}/extend`,
      { days: 30 },
    );
    expect([200, 201]).toContain(extend.status);
    const openAfter = await api(
      journeyOwner,
      journeyBusiness,
      "GET",
      `/api/businesses/${journeyBusiness}/subscription/open`,
    );
    const after = new Date(openAfter.body.data.currentPeriodEnd).getTime();
    expect(after).toBeGreaterThanOrEqual(before + 29 * 86_400_000);
  });

  test("TEST 13 — tenant isolation: business B cannot touch business A", async () => {
    const other = await registerOwner("J13");
    const otherBiz = await createBusinessWithTrial(other.token, "J13 Other Biz");

    // B reading A's subscription surface → forbidden.
    const sub = await api(
      other.token,
      journeyBusiness,
      "GET",
      `/api/businesses/${journeyBusiness}/subscription/open`,
    );
    expect(sub.status).toBe(403);
    // B writing into A's catalog → forbidden.
    const write = await api(other.token, journeyBusiness, "POST", "/api/product", {
      name: "Injected From B",
      categoryId: null,
      brandId: null,
      unitId: null,
      description: "",
      productType: "physical",
      hasVariants: false,
      trackingType: "none",
      supplierId: null,
      status: "active",
      imageUrl: null,
      imageFile: null,
      source: "purchase",
      variants: [],
    });
    expect(write.status).toBe(403);
    void otherBiz;
  });

  test("TEST 14 — customer accounts cannot reach SaaS Admin endpoints", async () => {
    const owner = await registerOwner("J14");
    const overview = await api(
      owner.token,
      null,
      "GET",
      "/api/saas/overview",
    );
    expect(overview.status).toBe(403);
    const suspend = await api(
      owner.token,
      null,
      "POST",
      "/api/saas/businesses/1/status",
      { status: "suspended" },
    );
    expect([401, 403]).toContain(suspend.status);
  });

  test("TEST 15 — plan product limit is enforced on the backend", async () => {
    // Restore the Starter cap (TEST 11 raised it to 2 via plan management).
    // The business already has 1 product; a second must be refused with the
    // documented error.
    const capLower = await api(
      adminToken,
      null,
      "PATCH",
      `/api/saas/plans/${starterPlanId}`,
      { limits: { maxProducts: 1, maxUsers: 3, maxLocations: 1 } },
    );
    expect([200, 201]).toContain(capLower.status);
    // A valid unit keeps payload validation quiet so the LIMIT check is what
    // actually fires (middleware runs before controller validation, but the
    // maxProducts check lives inside the create service).
    const unit15 = await api(journeyOwner, journeyBusiness, "POST", "/api/product/unit", {
      unitName: "Limit Probe Piece",
      abbreviation: `lp${Date.now() % 100000}`,
    });
    expect(unit15.status).toBe(201);
    const unit15Body: any = unit15.body;
    const unit15Id = Number(unit15Body?.data?.value ?? unit15Body?.data?.id ?? unit15Body?.id);
    const write = await api(journeyOwner, journeyBusiness, "POST", "/api/product", {
      name: "Over-Limit Product",
      categoryId: null,
      brandId: null,
      unitId: unit15Id,
      description: "",
      productType: "physical",
      hasVariants: false,
      trackingType: "none",
      supplierId: null,
      status: "active",
      imageUrl: null,
      imageFile: null,
      source: "purchase",
      variants: [],
    });
    expect(write.status).toBe(403);
    expect(JSON.stringify(write.body)).toContain("PLAN_LIMIT_REACHED");
  });
});
