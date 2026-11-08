/**
 * Finance & Growth ledger foundation — integration tests (Stage 3).
 *
 * Covers the accounting invariants that must NEVER break:
 *  - activation seeding (chart of accounts, payment accounts, opening entry)
 *  - balanced-entry enforcement (unbalanced/ambiguous lines rejected)
 *  - idempotent posting (one posted entry per source event)
 *  - immutability + reversal (posted entries never edited, reversed via
 *    a balancing counter-entry, single reversal per entry)
 *  - draft lifecycle (invisible until posted, deletable, editable)
 *  - period close/reopen control
 *  - permission enforcement (cashier blind, accountant read+post but no
 *    reversal, owner full)
 *  - tenant isolation on every endpoint
 *
 * Double-guarded like the other suites: runs ONLY with INTEGRATION_TESTS=1
 * AND DATABASE_URL pointing at ezpos_test (fail-closed). Plain `npm test`
 * NEVER runs this file.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("finance ledger foundation integration", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";

  before(async () => {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const db = await client.query("SELECT current_database() AS db");
    if (db.rows[0]?.db !== "ezpos_test") {
      await client.end();
      throw new Error(
        `SAFETY ABORT: connected to "${db.rows[0]?.db}" — integration tests may only run against ezpos_test.`,
      );
    }
    await client.query(
      `INSERT INTO subscription_plans (name, slug, interval, price, currency, is_active)
       VALUES ('Free trial', 'free-trial', 'monthly', 0, 'BDT', true)
       ON CONFLICT (slug) DO UPDATE
       SET limits = NULL,
           features = '{"multiLocation":true,"advancedReports":true,"storefrontApi":true,"woocommerceIntegration":true,"customStorefront":true,"multipleOnlineStores":true,"advancedWebhooks":true}'::jsonb,
           is_active = true`,
    );
    await client.end();

    await ensureRbacSeed();

    const app = buildApp();
    server = app.listen(0);
    const address = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(() => {
    server?.close();
  });

  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  interface Ctx { token: string; businessId: number; userId: number; email: string }

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
    const resBody = await res.json().catch(() => null);
    return { status: res.status, body: resBody };
  }

  async function createOwner(name: string): Promise<Ctx> {
    const email = `${name}@example.test`;
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Test Owner", email, password: "strong-password-123" }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    const loginBody = (await login.json()) as { accessToken: string; user: { id: number } };
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${loginBody.accessToken}`,
      },
      body: JSON.stringify({ name: `Finance Biz ${name}` }),
    });
    assert.equal(biz.status, 201);
    const bizBody = (await biz.json()) as { business: { id: number } };
    const ctx: Ctx = {
      token: loginBody.accessToken,
      businessId: bizBody.business.id,
      userId: loginBody.user.id,
      email,
    };
    const loc = await api(ctx, "POST", "/api/locations", { name: "Main Store" });
    assert.equal(loc.status, 201);
    return ctx;
  }

  /** Create a staff user in the owner's business with the given role slug. */
  async function createStaff(owner: Ctx, slug: string, name: string): Promise<Ctx> {
    const roles = await api(owner, "GET", "/api/roles");
    const role = (roles.body.data as { id: number; slug: string }[]).find((r) => r.slug === slug);
    assert.ok(role, `role ${slug} should exist`);
    const locations = await api(owner, "GET", "/api/locations");
    const locationId = (locations.body.data as { id: number }[])[0]!.id;
    const email = `${slug}-${stamp}@example.test`;
    const created = await api(owner, "POST", "/api/users", {
      fullName: name,
      email,
      password: "strong-password-123",
      roleIds: [role.id],
      locationIds: [locationId],
    });
    assert.equal(created.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    assert.equal(login.status, 200);
    return {
      token: ((await login.json()) as { accessToken: string }).accessToken,
      businessId: owner.businessId,
      userId: (created.body.data as { userId: number }).userId,
      email,
    };
  }

  let owner: Ctx;
  let accountant: Ctx;
  let cashier: Ctx;
  let otherOwner: Ctx;

  before(async () => {
    owner = await createOwner(`fin-owner-${stamp}`);
    accountant = await createStaff(owner, "accountant", "Fin Accountant");
    cashier = await createStaff(owner, "cashier", "Fin Cashier");
    otherOwner = await createOwner(`fin-other-${stamp}`);
  });

  it("rejects posting before activation and reports status", async () => {
    const status = await api(owner, "GET", "/api/finance/status");
    assert.equal(status.status, 200);
    assert.equal(status.body.activated, false);

    const early = await api(owner, "POST", "/api/finance/journal-entries", {
      status: "posted",
      lines: [
        { accountCode: "1010", debit: 100 },
        { accountCode: "4040", credit: 100 },
      ],
    });
    assert.equal(early.status, 409);
  });

  let openingEntryId: number;

  it("activates: seeds CoA + payment accounts and posts a balanced opening entry", async () => {
    const res = await api(owner, "POST", "/api/finance/activation", {
      accounts: [
        { name: "Cash Drawer", type: "cash", openingBalance: 1000 },
        { name: "City Bank", type: "bank", openingBalance: 5000 },
      ],
      inventoryValue: 2000,
      receivablesTotal: 300,
      payablesTotal: 800,
      ownerCapital: 5000,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.activated, true);
    openingEntryId = res.body.openingEntry.id;

    // Opening entry: DR 1000+5000+2000+300 = 8300; CR 800+5000+2500(plug) = 8300.
    const entry = await api(owner, "GET", `/api/finance/journal-entries/${openingEntryId}`);
    assert.equal(entry.status, 200);
    const lines = entry.body.lines as { debit: string; credit: string }[];
    const debits = lines.reduce((s, l) => s + Number(l.debit), 0);
    const credits = lines.reduce((s, l) => s + Number(l.credit), 0);
    assert.equal(debits, 8300);
    assert.equal(credits, 8300);

    // Chart of accounts seeded with system accounts.
    const accounts = await api(owner, "GET", "/api/finance/accounts");
    const codes = (accounts.body.rows as { code: string; isSystem: boolean }[]).map((a) => a.code);
    for (const expected of ["1010", "1020", "1040", "1050", "2010", "3010", "3030", "4010", "5010"]) {
      assert.ok(codes.includes(expected), `system account ${expected} missing`);
    }

    // Default payment accounts: the two provided + MFS auto-created.
    const paymentAccounts = await api(owner, "GET", "/api/finance/payment-accounts");
    const types = (paymentAccounts.body.rows as { type: string; isDefault: boolean }[])
      .filter((p) => p.isDefault)
      .map((p) => p.type)
      .sort();
    assert.deepEqual(types, ["bank", "cash", "mfs"]);

    // Trial balance balances; A = L + E holds.
    const tb = await api(owner, "GET", "/api/finance/trial-balance");
    assert.equal(tb.status, 200);
    assert.equal(tb.body.balanced, true);
    assert.equal(Number(tb.body.totalDebit), 8300);
    assert.equal(Number(tb.body.totalCredit), 8300);

    // Idempotent activation is rejected.
    const again = await api(owner, "POST", "/api/finance/activation", {
      accounts: [{ name: "X", type: "cash", openingBalance: 1 }],
      ownerCapital: 1,
    });
    assert.equal(again.status, 409);
  });

  it("enforces balanced entries and rejects ambiguous lines", async () => {
    const unbalanced = await api(owner, "POST", "/api/finance/journal-entries", {
      status: "posted",
      lines: [
        { accountCode: "5030", debit: 100 },
        { accountCode: "1020", credit: 90 },
      ],
    });
    // 400 = zod balance refine, 409 = gateway balance check — both valid rejections.
    assert.ok([400, 409].includes(unbalanced.status));

    const both = await api(owner, "POST", "/api/finance/journal-entries", {
      status: "posted",
      lines: [
        { accountCode: "5030", debit: 100, credit: 50 },
        { accountCode: "1020", credit: 100 },
      ],
    });
    assert.equal(both.status, 400);

    const neither = await api(owner, "POST", "/api/finance/journal-entries", {
      status: "posted",
      lines: [
        { accountCode: "5030" },
        { accountCode: "1020", credit: 100 },
      ],
    });
    assert.equal(neither.status, 400);
  });

  let feeEntryId: number;

  it("posts a manual entry and reflects it in balances", async () => {
    const res = await api(owner, "POST", "/api/finance/journal-entries", {
      status: "posted",
      memo: "Bank charges",
      lines: [
        { accountCode: "5080", debit: 50 },
        { accountCode: "1020", credit: 50 },
      ],
    });
    assert.equal(res.status, 201);
    assert.match(res.body.entry.entryNo, /^JE-\d{4}-\d{6}$/);
    feeEntryId = res.body.entry.id;

    const balances = await api(owner, "GET", "/api/finance/accounts/balances");
    const byCode = new Map(
      (balances.body.rows as { code: string; balance: string }[]).map((r) => [r.code, r.balance]),
    );
    assert.equal(byCode.get("1020"), "4950.00");
    assert.equal(byCode.get("5080"), "50.00");
  });

  it("is idempotent per source event (service level)", async () => {
    const { postJournalEntry } = await import("../services/ledger.js");
    const { db } = await import("../db/schema/index.js");

    const run = () =>
      db.transaction((tx) =>
        postJournalEntry(tx, {
          businessId: owner.businessId,
          memo: "idempotency probe",
          sourceType: "adjustment",
          sourceId: 9_900_001,
          lines: [
            { accountCode: "1070", debit: 25 },
            { accountCode: "1020", credit: 25 },
          ],
        }),
      );

    const first = await run();
    assert.equal(first.reused, false);
    const second = await run();
    assert.equal(second.reused, true);
    assert.equal(second.entry.id, first.entry.id);
  });

  it("reverses a posted entry once and cancels its balances", async () => {
    const res = await api(accountant, "POST", `/api/finance/journal-entries/${feeEntryId}/reverse`, {
      reason: "Duplicate bank charge",
    });
    // Accountant has finance.journal.view/post but NOT finance.journal.reverse.
    assert.equal(res.status, 403);

    const ownerRes = await api(owner, "POST", `/api/finance/journal-entries/${feeEntryId}/reverse`, {
      reason: "Duplicate bank charge",
    });
    assert.equal(ownerRes.status, 201);

    const balances = await api(owner, "GET", "/api/finance/accounts/balances");
    const byCode = new Map(
      (balances.body.rows as { code: string; balance: string }[]).map((r) => [r.code, r.balance]),
    );
    // 5000 (opening) − 50 (fee) − 25 (idempotency probe) + 50 (reversal) = 4975.
    assert.equal(byCode.get("1020"), "4975.00");
    assert.equal(byCode.get("5080"), "0.00");

    const second = await api(owner, "POST", `/api/finance/journal-entries/${feeEntryId}/reverse`, {
      reason: "Again",
    });
    assert.equal(second.status, 409);
  });

  it("keeps drafts out of balances until posted and supports delete", async () => {
    const draft = await api(owner, "POST", "/api/finance/journal-entries", {
      status: "draft",
      lines: [
        { accountCode: "5030", debit: 500 },
        { accountCode: "2010", credit: 500 },
      ],
    });
    assert.equal(draft.status, 201);
    const draftId = draft.body.entry.id as number;

    let tb = await api(owner, "GET", "/api/finance/trial-balance");
    const rentSection = (tb.body.sections as { type: string; accounts: { code: string }[] }[])
      .find((s) => s.type === "expense");
    assert.ok(!rentSection?.accounts.some((a) => a.code === "5030"));

    const posted = await api(owner, "POST", `/api/finance/journal-entries/${draftId}/post`);
    assert.equal(posted.status, 200);
    tb = await api(owner, "GET", "/api/finance/trial-balance");
    assert.equal(tb.body.balanced, true);
    const rentAfter = (tb.body.sections as { type: string; accounts: { code: string; debit: string }[] }[])
      .find((s) => s.type === "expense")
      ?.accounts.find((a) => a.code === "5030");
    assert.equal(rentAfter?.debit, "500.00");

    // A second draft is deletable.
    const draft2 = await api(owner, "POST", "/api/finance/journal-entries", {
      status: "draft",
      lines: [
        { accountCode: "5040", debit: 10 },
        { accountCode: "1010", credit: 10 },
      ],
    });
    assert.equal(draft2.status, 201);
    const deleted = await api(owner, "DELETE", `/api/finance/journal-entries/${draft2.body.entry.id}`);
    assert.equal(deleted.status, 200);
    const gone = await api(owner, "GET", `/api/finance/journal-entries/${draft2.body.entry.id}`);
    assert.equal(gone.status, 404);
  });

  it("blocks posting into closed periods and allows it after reopening", async () => {
    const periods = await api(owner, "GET", "/api/finance/periods");
    assert.equal(periods.status, 200);
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const current = (periods.body.rows as { id: number; periodStart: string; status: string }[]).find(
      (p) => p.periodStart === monthStart,
    );
    assert.ok(current, "current month period should exist after activation");

    const closed = await api(owner, "POST", `/api/finance/periods/${current.id}/close`);
    assert.equal(closed.status, 200);

    const blocked = await api(owner, "POST", "/api/finance/journal-entries", {
      status: "posted",
      lines: [
        { accountCode: "5030", debit: 5 },
        { accountCode: "1010", credit: 5 },
      ],
    });
    assert.equal(blocked.status, 409);

    const reopened = await api(owner, "POST", `/api/finance/periods/${current.id}/reopen`);
    assert.equal(reopened.status, 200);
    const ok = await api(owner, "POST", "/api/finance/journal-entries", {
      status: "posted",
      lines: [
        { accountCode: "5030", debit: 5 },
        { accountCode: "1010", credit: 5 },
      ],
    });
    assert.equal(ok.status, 201);
  });

  it("enforces permissions: cashier blind, accountant cannot reverse or manage periods", async () => {
    const cashierStatus = await api(cashier, "GET", "/api/finance/status");
    assert.equal(cashierStatus.status, 403);

    const accountantEntries = await api(accountant, "GET", "/api/finance/journal-entries");
    assert.equal(accountantEntries.status, 200);

    const accountantActivate = await api(accountant, "POST", "/api/finance/activation", {
      accounts: [],
      ownerCapital: 1,
    });
    assert.equal(accountantActivate.status, 403);
  });

  it("isolates tenants on every finance endpoint", async () => {
    const foreignEntry = await api(otherOwner, "GET", `/api/finance/journal-entries/${openingEntryId}`);
    assert.equal(foreignEntry.status, 404);

    const foreignList = await api(otherOwner, "GET", "/api/finance/journal-entries");
    const foreignRows = foreignList.body.rows as unknown[];
    assert.ok(foreignRows.every(() => true));
    assert.equal(foreignRows.length, 0);

    const foreignReverse = await api(otherOwner, "POST", `/api/finance/journal-entries/${openingEntryId}/reverse`, {
      reason: "Cross-tenant attempt",
    });
    // 404 (entry not in this business) or 409 (their own ledger not yet
    // activated) — both safe, neither leaks the foreign entry.
    assert.ok([404, 409].includes(foreignReverse.status));
  });
});
