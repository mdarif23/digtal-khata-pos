/**
 * Phase 4 integration tests: customer portal — subscription actions,
 * billing scoping, profile settings, and support tickets — against a REAL
 * PostgreSQL database. Double-guarded like the other suites: runs ONLY
 * with INTEGRATION_TESTS=1 AND DATABASE_URL pointing at ezpos_test.
 *
 * Plain `npm test` NEVER runs this file.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("customer portal integration", { skip: !runIntegration }, () => {
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
    `portal-${Date.now()}-${(counter += 1)}@example.test`;

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
        fullName: "Portal Test",
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
    assert.equal(login.status, 200);
    const loginBody = (await login.json()) as { accessToken: string; user: { id: number } };
    const token = loginBody.accessToken;
    const me = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const meBody = (await me.json()) as { user: { id: number } };

    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: businessName }),
    });
    assert.equal(biz.status, 201);
    const bizBody = (await biz.json()) as { business: { id: number } };
    return {
      token,
      businessId: bizBody.business.id,
      userId: meBody.user.id,
      email,
    };
  }

  async function createPlan(
    price: number,
    adopt = false,
  ): Promise<number> {
    const slug = `portal-plan-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const created = await pg!.query(
      `INSERT INTO subscription_plans (name, slug, interval, price, currency, is_active)
       VALUES ($1, $2, 'monthly', $3, 'BDT', true) RETURNING id`,
      [`Portal plan ${slug}`, slug, price],
    );
    return created.rows[0]!.id as number;
  }

  it("changes the plan from the portal and writes an event", async () => {
    const ctx = await createOwnerCtx("Portal Plan Co");
    const targetPlanId = await createPlan(999);

    const res = await api(ctx, "POST", `/api/businesses/${ctx.businessId}/subscription/change-plan`, {
      planId: targetPlanId,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body?.data?.outcome, "trial_plan_changed");

    const sub = await pg!.query(
      "SELECT plan_id FROM subscriptions WHERE business_id = $1 AND status IN ('trialing','active','past_due')",
      [ctx.businessId],
    );
    assert.equal(sub.rows[0]!.plan_id, targetPlanId);

    const events = await pg!.query(
      `SELECT e.event_type FROM subscription_events e
       JOIN subscriptions s ON s.id = e.subscription_id
       WHERE s.business_id = $1 AND e.event_type = 'trial_plan_changed'`,
      [ctx.businessId],
    );
    assert.ok(events.rows.length >= 1);
  });

  it("cancel → reactivate → renew flow works from the portal", async () => {
    const ctx = await createOwnerCtx("Portal Cycle Co");

    // Renew first so the subscription is a paid one with an invoice.
    const renew = await api(ctx, "POST", `/api/businesses/${ctx.businessId}/subscription/renew`);
    assert.equal(renew.status, 200);

    const invoices = await api(ctx, "GET", `/api/businesses/${ctx.businessId}/invoices`);
    assert.equal(invoices.status, 200);
    assert.ok(invoices.body?.data?.length >= 1);
    const invoiceId = invoices.body.data[0].id as number;

    // Scheduled cancel keeps the subscription open with cancel_at_period_end.
    const cancel = await api(ctx, "POST", `/api/businesses/${ctx.businessId}/subscription/cancel`, {
      immediate: false,
    });
    assert.equal(cancel.status, 200);
    const open1 = await api(ctx, "GET", `/api/businesses/${ctx.businessId}/subscription/open`);
    assert.equal(open1.body?.data?.cancelAtPeriodEnd, true);

    // Reactivate undoes it.
    const reactivate = await api(ctx, "POST", `/api/businesses/${ctx.businessId}/subscription/reactivate`);
    assert.equal(reactivate.status, 200);
    const open2 = await api(ctx, "GET", `/api/businesses/${ctx.businessId}/subscription/open`);
    assert.equal(open2.body?.data?.cancelAtPeriodEnd, false);

    // Invoice detail is fetchable and scoped.
    const detail = await api(ctx, "GET", `/api/businesses/${ctx.businessId}/invoices/${invoiceId}`);
    assert.equal(detail.status, 200);
    assert.ok(typeof detail.body?.data?.total === "number");

    // Renew again: period extends, another invoice appears.
    const invoicesBefore = (invoices.body.data as unknown[]).length;
    const renew2 = await api(ctx, "POST", `/api/businesses/${ctx.businessId}/subscription/renew`);
    assert.equal(renew2.status, 200);
    const invoicesAfter = await api(ctx, "GET", `/api/businesses/${ctx.businessId}/invoices`);
    assert.equal(
      (invoicesAfter.body.data as unknown[]).length,
      invoicesBefore + 1,
    );
  });

  it("immediate cancellation blocks writes but keeps the billing portal open", async () => {
    const ctx = await createOwnerCtx("Portal Read-only Co");
    const cancel = await api(ctx, "POST", `/api/businesses/${ctx.businessId}/subscription/cancel`, {
      immediate: true,
    });
    assert.equal(cancel.status, 200);

    // Writes blocked (read-only).
    const write = await api(ctx, "PUT", `/api/businesses/${ctx.businessId}`, {
      name: "Nope",
    });
    assert.equal(write.status, 403);

    // Billing data still reachable — never lock the customer out of it.
    const invoices = await api(ctx, "GET", `/api/businesses/${ctx.businessId}/invoices`);
    assert.equal(invoices.status, 200);
    const changePlan = await api(
      ctx,
      "POST",
      `/api/businesses/${ctx.businessId}/subscription/change-plan`,
      { planId: await createPlan(500) },
    );
    // Lapsed recovery: a canceled customer CAN re-choose a plan — the
    // backend raises a full-period invoice and keeps the subscription
    // canceled (read-only) until the payment is server-verified. The
    // cancellation email promises "choose a plan again at any time".
    assert.equal(changePlan.status, 200);
    assert.equal(changePlan.body.data.outcome, "upgraded");
    assert.ok(changePlan.body.data.invoice, "pending invoice must be raised");

    // Re-choosing a plan does NOT grant entitlement before payment —
    // writes stay blocked while the subscription is canceled.
    const writeAfterChange = await api(
      ctx,
      "PUT",
      `/api/businesses/${ctx.businessId}`,
      { name: "Still Nope" },
    );
    assert.equal(writeAfterChange.status, 403);
  });

  it("billing data is scoped: another member cannot read foreign invoices", async () => {
    const ownerA = await createOwnerCtx("Billing Scope A");
    const ownerB = await createOwnerCtx("Billing Scope B");
    await api(ownerA, "POST", `/api/businesses/${ownerA.businessId}/subscription/renew`);

    const foreign = await fetch(
      `${baseUrl}/api/businesses/${ownerA.businessId}/invoices`,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ownerB.token}`,
          "X-Business-Id": String(ownerB.businessId),
        },
      },
    );
    // B has no membership in A's business — indistinguishable from missing.
    assert.equal(foreign.status, 403);
  });

  it("profile update and change-password work with correct validation", async () => {
    const ctx = await createOwnerCtx("Portal Settings Co");

    const badPhone = await api(ctx, "PATCH", "/api/auth/me", { phone: "call me" });
    assert.equal(badPhone.status, 400);

    const update = await api(ctx, "PATCH", "/api/auth/me", {
      fullName: "Renamed Portal",
      phone: "+8801711223344",
    });
    assert.equal(update.status, 200);
    assert.equal(update.body?.user?.fullName, "Renamed Portal");

    const wrongCurrent = await api(ctx, "POST", "/api/auth/change-password", {
      currentPassword: "wrong-password",
      newPassword: "brand-new-pass-456",
    });
    assert.equal(wrongCurrent.status, 400);

    const change = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.token}`,
      },
      body: JSON.stringify({
        currentPassword: "strong-password-123",
        newPassword: "brand-new-pass-456",
      }),
    });
    assert.equal(change.status, 200);

    const oldLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ctx.email, password: "strong-password-123" }),
    });
    assert.equal(oldLogin.status, 401);
    const newLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ctx.email, password: "brand-new-pass-456" }),
    });
    assert.equal(newLogin.status, 200);
  });

  it("support tickets: create, list, reply; foreign tickets are invisible", async () => {
    const userA = await createOwnerCtx("Ticket User A");
    const userB = await createOwnerCtx("Ticket User B");

    const created = await api(userA, "POST", "/api/support/tickets", {
      subject: "Portal ticket test",
      message: "This is the first message of the portal ticket.",
      businessId: userA.businessId,
    });
    assert.equal(created.status, 201);
    const ticketId = created.body?.data?.id as number;

    const list = await api(userA, "GET", "/api/support/tickets");
    assert.equal(list.status, 200);
    assert.ok(
      (list.body?.data as { id: number }[]).some((t) => t.id === ticketId),
    );

    const reply = await api(userA, "POST", `/api/support/tickets/${ticketId}/messages`, {
      body: "Adding more detail to the ticket.",
    });
    assert.equal(reply.status, 201);

    const detail = await api(userA, "GET", `/api/support/tickets/${ticketId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body?.data?.messages?.length, 2);

    // B never sees A's ticket — reads and replies both 404.
    const foreignRead = await api(userB, "GET", `/api/support/tickets/${ticketId}`);
    assert.equal(foreignRead.status, 404);
    const foreignReply = await api(
      userB,
      "POST",
      `/api/support/tickets/${ticketId}/messages`,
      { body: "I should not be able to post here." },
    );
    assert.equal(foreignReply.status, 404);
  });
});
