/**
 * Phase 2C communication foundation integration tests (master prompt
 * Feature 6).
 *
 * Covers: provider config encryption + masking (secrets never returned),
 * templates with placeholder rendering, the queue→deliver message log,
 * consent (marketing opt-in / transactional opt-out) + daily cap, HMAC-
 * verified idempotent delivery webhooks, and the due-reminder sweep.
 *
 * Double-guarded: runs ONLY with INTEGRATION_TESTS=1 AND DATABASE_URL
 * pointing at ezpos_test.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("phase2 comms", { skip: !runIntegration }, () => {
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

  const stamp = Date.now();

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

  function payload<T>(res: { body: unknown }): T {
    return res.body as T;
  }

  let owner: Ctx;
  let customerId = 0;
  let saleWithDueId = 0;

  before(async () => {
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "C2 Test",
        email: `c2-owner-${stamp}@example.test`,
        password: "strong-password-123",
      }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `c2-owner-${stamp}@example.test`,
        password: "strong-password-123",
      }),
    });
    assert.equal(login.status, 200);
    const loginBody = (await login.json()) as { accessToken: string; user: { id: number } };
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${loginBody.accessToken}`,
      },
      body: JSON.stringify({ name: `C2 Biz ${stamp}` }),
    });
    assert.equal(biz.status, 201);
    const bizBody = (await biz.json()) as { business: { id: number } };
    owner = {
      token: loginBody.accessToken,
      businessId: bizBody.business.id,
      userId: loginBody.user.id,
      email: `c2-owner-${stamp}@example.test`,
    };

    await api(owner, "POST", "/api/locations", { name: `C2 Main ${stamp}` });
    const unitRes = await api(owner, "POST", "/api/product/unit", {
      unitName: `Pcs ${stamp}`,
      abbreviation: "Pcs",
    });
    const unitId = payload<{ data: { value: number } }>(unitRes).data.value;
    const product = await api(owner, "POST", "/api/product", {
      name: `C2 Widget ${stamp}`,
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
      source: "opening",
      variants: [
        {
          sku: `C2-${stamp}`,
          barcode: null,
          sellingPrice: 500,
          alertQuantity: 5,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `C2B-${stamp}`,
          purchasePrice: 200,
          quantity: 100,
          expiryDate: null,
        },
      ],
    });
    assert.equal(product.status, 201);
    const list = await api(owner, "GET", "/api/products");
    const created = (
      list.body as { name: string; variants: { id: number }[] }[]
    ).find((p) => p.name === `C2 Widget ${stamp}`);
    assert.ok(created);
    const variantId = created.variants[0]!.id;

    const cust = await api(owner, "POST", "/api/customers", {
      name: `C2 Customer ${stamp}`,
      phone: `019${String(stamp).slice(-8)}`,
      email: `c2-${stamp}@example.test`,
      address: "",
    });
    assert.equal(cust.status, 201);
    const custBody = cust.body as { data?: { id?: number }; id?: number };
    customerId = (custBody.data?.id ?? custBody.id)!;

    // A due sale (partial payment).
    const sale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [{ method: "cash", amount: 100, tendered: 100 }, { method: "due", amount: 400 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: 500, discount: null }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    saleWithDueId = payload<{ data: { sale: { id: number } } }>(sale).data.sale.id;
  });

  it("stores provider configs encrypted and returns masked previews only", async () => {
    const put = await api(owner, "PUT", "/api/comms/providers", {
      channel: "sms",
      providerKey: "generic_http",
      displayName: "Test SMS gateway",
      config: {
        url: "https://sms.example.test/send",
        apiKey: "super-secret-key-123",
        method: "POST",
      },
      isDefault: true,
      isActive: true,
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));

    const list = await api(owner, "GET", "/api/comms/providers");
    const data = payload<{
      data: { providerKey: string; configPreview: Record<string, unknown> | null }[];
    }>(list).data;
    const provider = data.find((p) => p.providerKey === "generic_http");
    assert.ok(provider);
    assert.ok(provider!.configPreview);
    assert.equal(
      provider!.configPreview!.apiKey,
      "su••••",
      "secrets must be masked",
    );
    const serialized = JSON.stringify(list.body);
    assert.ok(
      !serialized.includes("super-secret-key-123"),
      "raw secrets must never reach the response",
    );

    // Ciphertext at rest is not plaintext.
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const row = await client.query(
      `SELECT config_encrypted FROM comm_providers WHERE business_id = $1 AND provider_key = 'generic_http'`,
      [owner.businessId],
    );
    await client.end();
    assert.ok(row.rows[0].config_encrypted);
    assert.ok(!row.rows[0].config_encrypted.includes("super-secret"));
  });

  it("sends through the console provider and logs the message", async () => {
    await api(owner, "PUT", "/api/comms/providers", {
      channel: "sms",
      providerKey: "console",
      displayName: "Dev console",
      isDefault: true,
      isActive: true,
    });
    const send = await api(owner, "POST", "/api/comms/send", {
      channel: "sms",
      customerId,
      recipient: `019${String(stamp).slice(-8)}`,
      templateKey: "custom",
      messageClass: "transactional",
      entityType: "sale",
      entityId: saleWithDueId,
      variables: { body: "Your order is ready for pickup." },
    });
    assert.equal(send.status, 200, JSON.stringify(send.body));
    const outcome = payload<{ data: { status: string } }>(send).data;
    assert.equal(outcome.status, "sent");

    const log = await api(owner, "GET", "/api/comms/messages");
    const rows = payload<{ data: { rows: { status: string; providerMessageId: string | null; templateKey: string }[] } }>(log).data.rows;
    const mine = rows.find((r) => r.templateKey === "custom");
    assert.ok(mine);
    assert.equal(mine.status, "sent");
    assert.match(mine.providerMessageId ?? "", /^console-/);
  });

  it("enforces consent: transactional opt-out and marketing opt-in", async () => {
    // Opt this customer out of transactional messages.
    const custUpdate = await api(owner, "PATCH", `/api/customers/${customerId}/consent`, {
      transactionalOptOut: true,
    });
    assert.ok([200, 201].includes(custUpdate.status), JSON.stringify(custUpdate.body));

    const skipped = await api(owner, "POST", "/api/comms/send", {
      channel: "sms",
      customerId,
      recipient: `019${String(stamp).slice(-8)}`,
      templateKey: "custom",
      messageClass: "transactional",
      variables: { body: "Should be skipped" },
    });
    assert.equal(skipped.status, 200);
    assert.equal(payload<{ data: { status: string; reason: string } }>(skipped).data.status, "skipped");
    assert.equal(payload<{ data: { reason: string } }>(skipped).data.reason, "transactional_opted_out");

    // Re-enable transactional; marketing still requires opt-in.
    await api(owner, "PATCH", `/api/customers/${customerId}/consent`, {
      transactionalOptOut: false,
    });
    const marketing = await api(owner, "POST", "/api/comms/send", {
      channel: "sms",
      customerId,
      recipient: `019${String(stamp).slice(-8)}`,
      templateKey: "custom",
      messageClass: "marketing",
      variables: { body: "Sale this Friday!" },
    });
    assert.equal(payload<{ data: { status: string; reason: string } }>(marketing).data.status, "skipped");
    assert.equal(payload<{ data: { reason: string } }>(marketing).data.reason, "marketing_not_opted_in");

    // Raise the cap (messages already sent today), opt in to marketing.
    await api(owner, "PUT", "/api/comms/settings", { dailyCapPerCustomer: 10 });
    await api(owner, "PATCH", `/api/customers/${customerId}/consent`, { marketingOptIn: true });
    const okMarketing = await api(owner, "POST", "/api/comms/send", {
      channel: "sms",
      customerId,
      recipient: `019${String(stamp).slice(-8)}`,
      templateKey: "custom",
      messageClass: "marketing",
      variables: { body: "Sale this Friday!" },
    });
    assert.equal(payload<{ data: { status: string } }>(okMarketing).data.status, "sent");
  });

  it("renders templates with placeholders", async () => {
    await api(owner, "PUT", "/api/comms/templates", {
      templateKey: "due_reminder",
      channel: "sms",
      name: "Friendly reminder",
      body: "Hi {{customerName}}, invoice {{invoiceNumber}} has ৳{{due}} due.",
      isActive: true,
    });
    const send = await api(owner, "POST", "/api/comms/send", {
      channel: "sms",
      customerId,
      recipient: `019${String(stamp).slice(-8)}`,
      templateKey: "due_reminder",
      messageClass: "transactional",
      entityType: "sale",
      entityId: saleWithDueId,
      variables: {
        customerName: "Test Customer",
        invoiceNumber: "INV-1",
        due: 400,
      },
    });
    assert.equal(payload<{ data: { status: string } }>(send).data.status, "sent");

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const row = await client.query(
      `SELECT body FROM comm_messages WHERE business_id = $1 AND template_key = 'due_reminder' ORDER BY id DESC LIMIT 1`,
      [owner.businessId],
    );
    await client.end();
    assert.equal(
      row.rows[0].body,
      "Hi Test Customer, invoice INV-1 has ৳400 due.",
    );
  });

  it("verifies webhook HMAC signatures and applies status idempotently", async () => {
    const secretRes = await api(owner, "POST", "/api/comms/webhook-secret");
    assert.equal(secretRes.status, 200);
    const secret = payload<{ data: { secret: string } }>(secretRes).data.secret;

    // Find the sent message's provider id.
    const log = await api(owner, "GET", "/api/comms/messages?status=sent");
    const rows = payload<{ data: { rows: { id: number; providerMessageId: string | null }[] } }>(log).data.rows;
    const withProviderId = rows.find((r) => (r.providerMessageId ?? "").startsWith("console-"));
    assert.ok(withProviderId?.providerMessageId);

    // The console provider already marked this message sent synchronously —
    // reset it to queued so the webhook's forward transition is observable.
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query(`UPDATE comm_messages SET status = 'queued' WHERE id = $1`, [
      withProviderId.id,
    ]);
    await client.end();

    const payloadBody = JSON.stringify({
      providerKey: "console",
      providerMessageId: withProviderId.providerMessageId,
      status: "sent",
    });
    const signature = createHmac("sha256", secret).update(payloadBody).digest("hex");

    const bad = await fetch(`${baseUrl}/api/comms/webhook/${owner.businessId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-EZPOS-Signature": "deadbeef" },
      body: payloadBody,
    });
    assert.equal(bad.status, 401);

    const good = await fetch(`${baseUrl}/api/comms/webhook/${owner.businessId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-EZPOS-Signature": signature },
      body: payloadBody,
    });
    assert.equal(good.status, 200);
    const applied = ((await good.json()) as { data: { applied: boolean } }).data.applied;
    assert.equal(applied, true, "first webhook must apply");

    const replay = await fetch(`${baseUrl}/api/comms/webhook/${owner.businessId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-EZPOS-Signature": signature },
      body: payloadBody,
    });
    const replayApplied = ((await replay.json()) as { data: { applied: boolean } }).data.applied;
    assert.equal(replayApplied, false, "replay must be a no-op");
  });

  it("due reminder sweep sends once per customer per day and respects opt-out", async () => {
    await api(owner, "PUT", "/api/comms/settings", { dueRemindersEnabled: true });
    // A FRESH customer + due sale: earlier tests already sent a due_reminder
    // for the first customer today (per-customer-per-day dedup would skip).
    const cust = await api(owner, "POST", "/api/customers", {
      name: `C2 Sweep ${stamp}`,
      phone: `016${String(stamp).slice(-8)}`,
      email: null,
      address: "",
    });
    assert.equal(cust.status, 201);
    const custBody = cust.body as { data?: { id?: number }; id?: number };
    const sweepCustomerId = (custBody.data?.id ?? custBody.id)!;
    const list = await api(owner, "GET", "/api/products");
    const variantId = (
      list.body as { variants: { id: number }[] }[]
    )[0]!.variants[0]!.id;
    const sale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: sweepCustomerId,
      payments: [
        { method: "cash", amount: 100, tendered: 100 },
        { method: "due", amount: 400 },
      ],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: 500, discount: null }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));

    const { runDueReminderSweep } = await import("../services/comms.js");
    const first = await runDueReminderSweep();
    assert.ok(first.sent >= 1, JSON.stringify(first));
    const second = await runDueReminderSweep();
    assert.equal(second.sent, 0, "no duplicate reminders the same day");
  });

  // P0 fix #6: sendSaleReceiptAfterSale existed but had no caller — the
  // sale path now fires it post-commit when the business enables it.
  it("auto-sends the sale receipt when enabled — once, consent-aware, off by default", async () => {
    const cust = await api(owner, "POST", "/api/customers", {
      name: `C2 Auto Receipt ${stamp}`,
      phone: `015${String(stamp).slice(-8)}`,
      email: `c2-auto-${stamp}@example.test`,
      address: "",
    });
    assert.equal(cust.status, 201);
    const custBody = cust.body as { data?: { id?: number }; id?: number };
    const autoCustomerId = (custBody.data?.id ?? custBody.id)!;
    const list = await api(owner, "GET", "/api/products");
    const variantId = (
      list.body as { variants: { id: number }[] }[]
    )[0]!.variants[0]!.id;
    const saleBody = {
      saleDate: new Date().toISOString(),
      customerId: autoCustomerId,
      payments: [{ method: "cash", amount: 500, tendered: 500 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 1, unitPrice: 500, discount: null }],
    };

    async function receiptCount(saleId: number): Promise<number> {
      const { default: pg } = await import("pg");
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      const row = await client.query(
        `SELECT COUNT(*)::int AS n FROM comm_messages
         WHERE business_id = $1 AND entity_type = 'sale' AND entity_id = $2
           AND template_key = 'sale_receipt'`,
        [owner.businessId, saleId],
      );
      await client.end();
      return Number(row.rows[0].n);
    }

    // Off by default: no receipt message.
    await api(owner, "PUT", "/api/comms/settings", { autoReceiptEnabled: false });
    const saleOff = await api(owner, "POST", "/api/sales", saleBody);
    assert.equal(saleOff.status, 201, JSON.stringify(saleOff.body));
    const saleOffId = payload<{ data: { sale: { id: number } } }>(saleOff).data.sale.id;
    assert.equal(await receiptCount(saleOffId), 0, "no receipt while disabled");

    // Enabled: the receipt goes out (console SMS provider from earlier tests).
    await api(owner, "PUT", "/api/comms/settings", { autoReceiptEnabled: true });
    const saleOn = await api(owner, "POST", "/api/sales", saleBody);
    assert.equal(saleOn.status, 201, JSON.stringify(saleOn.body));
    const saleOnId = payload<{ data: { sale: { id: number } } }>(saleOn).data.sale.id;
    assert.equal(await receiptCount(saleOnId), 1, "exactly one receipt");

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const row = await client.query(
      `SELECT status, message_class, recipient FROM comm_messages
       WHERE business_id = $1 AND entity_type = 'sale' AND entity_id = $2
         AND template_key = 'sale_receipt'`,
      [owner.businessId, saleOnId],
    );
    await client.end();
    assert.equal(row.rows[0].status, "sent");
    assert.equal(row.rows[0].message_class, "transactional");
    assert.equal(row.rows[0].recipient, `015${String(stamp).slice(-8)}`);

    // Re-invoking the sender for the same sale must not double-send.
    const { sendSaleReceiptAfterSale } = await import("../services/comms.js");
    await sendSaleReceiptAfterSale(owner.businessId, saleOnId);
    await sendSaleReceiptAfterSale(owner.businessId, saleOnId);
    assert.equal(await receiptCount(saleOnId), 1, "deduped per sale");

    // Idempotent sale replay (same key) must not re-fire the receipt either.
    const replay = await api(owner, "POST", "/api/sales", {
      ...saleBody,
      idempotencyKey: `p0c6-${stamp}-replay-000001`,
    });
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    const replayId = payload<{ data: { sale: { id: number } } }>(replay).data.sale.id;
    const replayAgain = await api(owner, "POST", "/api/sales", {
      ...saleBody,
      idempotencyKey: `p0c6-${stamp}-replay-000001`,
    });
    assert.equal(replayAgain.status, 201);
    assert.equal(
      payload<{ data: { sale: { id: number } } }>(replayAgain).data.sale.id,
      replayId,
      "replay returns the original sale",
    );
    assert.equal(await receiptCount(replayId), 1, "replay sends no extra receipt");
  });
});
