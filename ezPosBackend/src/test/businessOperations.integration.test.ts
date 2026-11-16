/**
 * Flexible Business Operating Model — Phase 1 integration tests.
 *
 * Covers the business-operating-capability surface: the operating model
 * captured at business creation, the mode exposed via /auth/me and the
 * business detail, the Settings → Business Operations snapshot
 * (GET /operations), the dedicated PATCH /mode switch (including the
 * read-only-mode allowance and the "Online Store" auto-provision), and the
 * settings.edit permission gate on business profile/mode changes.
 *
 * Double-guarded like the other suites: plain `npm test` NEVER runs this
 * file — it needs INTEGRATION_TESTS=1 and DATABASE_URL pointing at
 * ezpos_test.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";
import { uniqueEmail } from "./helpers/fixtures.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("business operating model (Phase 1)", { skip: !runIntegration }, () => {
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
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await pg?.end();
  });

  async function registerOwner(): Promise<string> {
    const email = uniqueEmail("bizops");
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "BizOps Owner",
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
    const body = (await login.json()) as { accessToken: string };
    return body.accessToken;
  }

  async function createBusiness(
    token: string,
    name: string,
    mode?: "physical_only" | "online_only" | "omnichannel",
  ): Promise<number> {
    const res = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(mode ? { name, mode } : { name }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { business: { id: number } };
    return body.business.id;
  }

  async function getMe(token: string) {
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    return (await res.json()) as {
      businesses: {
        businessId: number;
        mode: "physical_only" | "online_only" | "omnichannel";
      }[];
    };
  }

  it("captures the operating model at business creation and exposes it via /auth/me", async () => {
    const token = await registerOwner();
    const businessId = await createBusiness(token, "Mode Capture Co", "online_only");

    const me = await getMe(token);
    const membership = me.businesses.find((b) => b.businessId === businessId);
    assert.ok(membership, "created business missing from /auth/me");
    assert.equal(membership.mode, "online_only");

    const detail = await fetch(`${baseUrl}/api/businesses/${businessId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(detail.status, 200);
    const detailBody = (await detail.json()) as {
      business: { mode: string };
    };
    assert.equal(detailBody.business.mode, "online_only");
  });

  it("defaults to physical_only when no mode is sent", async () => {
    const token = await registerOwner();
    const businessId = await createBusiness(token, "Default Mode Co");
    const me = await getMe(token);
    const membership = me.businesses.find((b) => b.businessId === businessId);
    assert.equal(membership?.mode, "physical_only");
  });

  it("exposes the operations snapshot and readiness flags", async () => {
    const token = await registerOwner();
    const businessId = await createBusiness(token, "Ops Snapshot Co", "online_only");

    const res = await fetch(`${baseUrl}/api/businesses/${businessId}/operations`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      operations: {
        mode: string;
        counts: { activeLocations: number; activeRegisters: number };
        readiness: { stockSourceReady: boolean; registerReady: boolean };
      };
    };
    assert.equal(body.operations.mode, "online_only");
    // Online-capable signup provisions the single stock source (warehouse)
    // immediately — inventory/orders/purchases work with no physical store.
    assert.equal(body.operations.counts.activeLocations, 1);
    assert.equal(body.operations.readiness.stockSourceReady, true);
    assert.equal(body.operations.readiness.registerReady, false);
  });

  it("provisions the stock source as a warehouse for online-only and a store for omnichannel", async () => {
    const token = await registerOwner();
    const onlineId = await createBusiness(token, "Provision Online Co", "online_only");
    const omniId = await createBusiness(token, "Provision Omni Co", "omnichannel");

    const list = await fetch(`${baseUrl}/api/locations`, {
      headers: { Authorization: `Bearer ${token}`, "X-Business-Id": String(onlineId) },
    });
    assert.equal(list.status, 200);
    const listBody = (await list.json()) as {
      data: { name: string; locationType: string; isDefault: boolean }[];
    };
    const onlineLocation = listBody.data.find((l) => l.isDefault);
    assert.ok(onlineLocation, "online-only business must have a default stock source");
    assert.equal(onlineLocation.name, "Online Store");
    assert.equal(onlineLocation.locationType, "warehouse");

    const omniList = await fetch(`${baseUrl}/api/locations`, {
      headers: { Authorization: `Bearer ${token}`, "X-Business-Id": String(omniId) },
    });
    const omniBody = (await omniList.json()) as {
      data: { name: string; locationType: string; isDefault: boolean }[];
    };
    const omniLocation = omniBody.data.find((l) => l.isDefault);
    assert.ok(omniLocation, "omnichannel business must have a default location");
    assert.equal(omniLocation.name, "Online Store");
    assert.equal(omniLocation.locationType, "store");
  });

  it("keeps the dashboard usable for a business with zero locations", async () => {
    const token = await registerOwner();
    const businessId = await createBusiness(token, "Zero Location Co");

    const res = await fetch(`${baseUrl}/api/dashboard_summary?period=today`, {
      headers: { Authorization: `Bearer ${token}`, "X-Business-Id": String(businessId) },
    });
    // Previously a 400 ("no locations yet") — the dashboard is meaningful
    // without any physical counter.
    assert.equal(res.status, 200);
  });

  it("blocks counter-sale surfaces for an online-only business even via direct API calls", async () => {
    const token = await registerOwner();
    const businessId = await createBusiness(token, "Surface Gate Co", "online_only");

    // POS checkout: 403 SURFACE_NOT_ACTIVE before any validation of the cart.
    const sale = await fetch(`${baseUrl}/api/sales`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Business-Id": String(businessId),
      },
      body: JSON.stringify({ items: [] }),
    });
    assert.equal(sale.status, 403);
    const saleBody = (await sale.json()) as { code?: string };
    assert.equal(saleBody.code, "SURFACE_NOT_ACTIVE");

    // Registers: same gate.
    const registers = await fetch(`${baseUrl}/api/registers`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Business-Id": String(businessId),
      },
    });
    assert.equal(registers.status, 403);
  });

  it("switches modes via PATCH /mode and auto-provisions a stock location for online-capable modes", async () => {
    const token = await registerOwner();
    const businessId = await createBusiness(token, "Mode Switch Co");

    const patch = await fetch(`${baseUrl}/api/businesses/${businessId}/mode`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ mode: "omnichannel" }),
    });
    assert.equal(patch.status, 200);
    const patchBody = (await patch.json()) as {
      business: { mode: string };
    };
    assert.equal(patchBody.business.mode, "omnichannel");

    // Zero locations + online-capable mode ⇒ exactly one stock location.
    const ops = await fetch(`${baseUrl}/api/businesses/${businessId}/operations`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const opsBody = (await ops.json()) as {
      operations: {
        counts: { activeLocations: number };
        readiness: { stockSourceReady: boolean };
      };
    };
    assert.equal(opsBody.operations.counts.activeLocations, 1);
    assert.equal(opsBody.operations.readiness.stockSourceReady, true);
  });

  it("rejects invalid mode payloads on PATCH /mode", async () => {
    const token = await registerOwner();
    const businessId = await createBusiness(token, "Mode Invalid Co");

    const bad = await fetch(`${baseUrl}/api/businesses/${businessId}/mode`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ mode: "retail" }),
    });
    assert.equal(bad.status, 400);

    const missing = await fetch(`${baseUrl}/api/businesses/${businessId}/mode`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);
  });

  it("allows the mode switch while the subscription is read-only but still blocks other writes", async () => {
    const token = await registerOwner();
    const businessId = await createBusiness(token, "ReadOnly Mode Co");

    // Force the subscription into an expired (read-only) state.
    await pg!.query(
      "UPDATE subscriptions SET status = 'expired' WHERE business_id = $1",
      [businessId],
    );

    // Mode switch — configuration, not data — stays available.
    const patch = await fetch(`${baseUrl}/api/businesses/${businessId}/mode`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ mode: "online_only" }),
    });
    assert.equal(patch.status, 200);

    // Any other profile write stays blocked by requireFullAccess.
    const put = await fetch(`${baseUrl}/api/businesses/${businessId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "Should Not Apply" }),
    });
    assert.equal(put.status, 403);
  });

  it("requires settings.edit on business profile and mode changes (staff cannot flip the mode)", async () => {
    const token = await registerOwner();
    const businessId = await createBusiness(token, "Perm Gate Co");

    // Create a manager (no settings.edit in the default manager template).
    const rolesRes = await fetch(`${baseUrl}/api/roles`, {
      headers: { Authorization: `Bearer ${token}`, "X-Business-Id": String(businessId) },
    });
    assert.equal(rolesRes.status, 200);
    const rolesBody = (await rolesRes.json()) as {
      data: { id: number; slug: string }[];
    };
    const managerRole = rolesBody.data.find((role) => role.slug === "manager");
    assert.ok(managerRole, "manager role not seeded");

    const staffEmail = uniqueEmail("bizops-staff");
    const staffRes = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Business-Id": String(businessId),
      },
      body: JSON.stringify({
        fullName: "BizOps Manager",
        email: staffEmail,
        password: "strong-password-123",
        roleIds: [managerRole.id],
      }),
    });
    assert.equal(staffRes.status, 201);

    const staffLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: staffEmail,
        password: "strong-password-123",
      }),
    });
    assert.equal(staffLogin.status, 200);
    const staffToken = ((await staffLogin.json()) as { accessToken: string })
      .accessToken;

    // Profile update: previously membership-only — now settings.edit gated.
    const staffPut = await fetch(`${baseUrl}/api/businesses/${businessId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${staffToken}`,
        "X-Business-Id": String(businessId),
      },
      body: JSON.stringify({ name: "Hijacked Name" }),
    });
    assert.equal(staffPut.status, 403);

    // Mode switch: same gate — a manager cannot flip the operating model.
    const staffPatch = await fetch(
      `${baseUrl}/api/businesses/${businessId}/mode`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${staffToken}`,
          "X-Business-Id": String(businessId),
        },
        body: JSON.stringify({ mode: "online_only" }),
      },
    );
    assert.equal(staffPatch.status, 403);

    // The owner (wildcard) still can.
    const ownerPatch = await fetch(
      `${baseUrl}/api/businesses/${businessId}/mode`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-Business-Id": String(businessId),
        },
        body: JSON.stringify({ mode: "online_only" }),
      },
    );
    assert.equal(ownerPatch.status, 200);
  });
});
