/**
 * Expense module Phase 4 integration tests — attachments:
 * presigned-PUT flow, content-type/size/prefix validation, private downloads,
 * soft delete, tenancy and permissions.
 *
 * The presign path is pure offline HMAC — it runs against any environment.
 * The register/download/delete round-trip additionally needs a REACHABLE
 * object store; when MinIO/R2 is not reachable the suite skips those cases
 * (and asserts the "upload not found" guard instead).
 *
 * Run ONLY when BOTH INTEGRATION_TESTS=1 and DATABASE_URL point at the
 * approved disposable ezpos_test database. Plain `npm test` NEVER runs this.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("expenses phase 4 integration", { skip: !runIntegration }, () => {
  let server: import("node:http").Server | undefined;
  let baseUrl = "";
  let storageReachable = false;
  let application: import("express").Express | undefined;

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

    // Enable media storage (presigning is offline HMAC — no server needed).
    process.env.S3_ACCESS_KEY_ID ||= "test-access-key";
    process.env.S3_SECRET_ACCESS_KEY ||= "test-secret-key";
    process.env.S3_ENDPOINT ||= "http://localhost:9000";
    process.env.S3_BUCKET ||= "ezpos-media";
    process.env.S3_REGION ||= "us-east-1";

    // Probe whether an object store actually answers at the endpoint —
    // the register/download round-trip needs real bytes in a bucket.
    const { presignObjectUrl } = await import("../services/objectStorage.js");
    try {
      const probe = await fetch(presignObjectUrl("HEAD", "probe.txt"), {
        signal: AbortSignal.timeout(2000),
      });
      storageReachable = true;
      void probe;
    } catch {
      storageReachable = false;
    }

    const { ensureRbacSeed } = await import("../rbac/seed.js");
    await ensureRbacSeed();
    const appModule = await import("../app.js");
    application = appModule.buildApp();

    server = application.listen(0);
    const address = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(() => {
    server?.close();
  });

  const uniqueEmail = () =>
    `expatt-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

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
    locationId?: number | null,
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.token}`,
      "X-Business-Id": String(ctx.businessId),
    };
    if (locationId !== undefined && locationId !== null) {
      headers["X-Location-Id"] = String(locationId);
    }
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
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

  async function registerAndCreateBusiness(
    email: string,
    businessName: string,
  ): Promise<Ctx> {
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Expense Att Test",
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
    const token = ((await login.json()) as { accessToken: string }).accessToken;
    const biz = await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: businessName }),
    });
    assert.equal(biz.status, 201);
    const bizBody = (await biz.json()) as { business?: { id?: number } };
    const businessId = bizBody.business?.id;
    assert.ok(businessId);
    return { token, businessId, userId: 0, email };
  }

  const today = () => new Date().toISOString().slice(0, 10);
  const stamp = Date.now();

  let owner: Ctx;
  let other: Ctx;
  let locationA = 0;
  let expenseId = 0;

  before(async () => {
    owner = await registerAndCreateBusiness(
      `expatt-owner-${stamp}@example.test`,
      "Expense Att Co",
    );
    other = await registerAndCreateBusiness(
      `expatt-other-${stamp}@example.test`,
      "Expense Att Other Co",
    );
    for (const ctx of [owner, other]) {
      const loc = await api(ctx, "POST", "/api/locations", {
        name: ctx === owner ? "Att Main" : "Other Att Main",
        isDefault: true,
      });
      assert.equal(loc.status, 201);
      if (ctx === owner) {
        locationA = (loc.body as { data?: { id?: number } }).data?.id ?? 0;
      }
    }
    const expense = await api(
      owner,
      "POST",
      "/api/expenses",
      {
        title: "Attachment host",
        expense_date: today(),
        amount: 250,
        category_id: null,
        payment_method: "Cash",
      },
      locationA,
    );
    assert.equal(expense.status, 201);
    expenseId = (expense.body as { id?: number }).id ?? 0;
    assert.ok(expenseId);
  });

  it("presigns PDF uploads under the business's private prefix", async () => {
    const res = await api(
      owner,
      "POST",
      `/api/expenses/${String(expenseId)}/attachments/presign`,
      {
        fileName: "receipt.pdf",
        contentType: "application/pdf",
        sizeBytes: 1024,
      },
      locationA,
    );
    assert.equal(res.status, 200);
    const body = res.body as {
      data?: { objectKey?: string; uploadUrl?: string; expiresIn?: number };
    };
    assert.ok(body.data?.objectKey?.startsWith(`businesses/${String(owner.businessId)}/expenses/`));
    assert.ok(body.data?.objectKey?.endsWith(".pdf"));
    assert.ok(body.data?.uploadUrl?.includes("X-Amz-Algorithm=AWS4-HMAC-SHA256"));
    assert.equal(body.data?.expiresIn, 600);
  });

  it("rejects unsupported types and oversized files", async () => {
    const badType = await api(
      owner,
      "POST",
      `/api/expenses/${String(expenseId)}/attachments/presign`,
      {
        fileName: "notes.docx",
        contentType: "application/msword",
        sizeBytes: 1024,
      },
      locationA,
    );
    assert.equal(badType.status, 400);

    const tooBig = await api(
      owner,
      "POST",
      `/api/expenses/${String(expenseId)}/attachments/presign`,
      {
        fileName: "huge.pdf",
        contentType: "application/pdf",
        sizeBytes: 11 * 1024 * 1024,
      },
      locationA,
    );
    assert.equal(tooBig.status, 400);
    assert.match(
      String((tooBig.body as { message?: string }).message),
      /up to 10 MB/i,
    );
  });

  it("rejects registration with a foreign object key prefix", async () => {
    const res = await api(
      owner,
      "POST",
      `/api/expenses/${String(expenseId)}/attachments`,
      {
        objectKey: `businesses/${String(other.businessId)}/expenses/steal.pdf`,
        fileName: "steal.pdf",
        contentType: "application/pdf",
        bytes: 1024,
      },
      locationA,
    );
    assert.equal(res.status, 400);
    assert.match(
      String((res.body as { message?: string }).message),
      /invalid object key/i,
    );
  });

  it("guards registration behind a storage existence check", async () => {
    const presign = await api(
      owner,
      "POST",
      `/api/expenses/${String(expenseId)}/attachments/presign`,
      {
        fileName: "never-uploaded.pdf",
        contentType: "application/pdf",
        sizeBytes: 512,
      },
      locationA,
    );
    assert.equal(presign.status, 200);
    const objectKey = (presign.body as { data?: { objectKey?: string } }).data
      ?.objectKey as string;

    const res = await api(
      owner,
      "POST",
      `/api/expenses/${String(expenseId)}/attachments`,
      {
        objectKey,
        fileName: "never-uploaded.pdf",
        contentType: "application/pdf",
        bytes: 512,
      },
      locationA,
    );
    if (storageReachable) {
      // A live store answers the HEAD with 404 → the guard still rejects.
      assert.equal(res.status, 400);
    } else {
      assert.equal(res.status, 400);
    }
    assert.match(
      String((res.body as { message?: string }).message),
      /upload not found/i,
    );
  });

  it("downloads and soft-deletes attachments (round-trip, needs live storage)", async (t) => {
    if (!storageReachable) {
      t.skip("no reachable object store in this environment");
      return;
    }
    const presign = await api(
      owner,
      "POST",
      `/api/expenses/${String(expenseId)}/attachments/presign`,
      {
        fileName: `receipt-${String(stamp)}.pdf`,
        contentType: "application/pdf",
        sizeBytes: 128,
      },
      locationA,
    );
    const { objectKey, uploadUrl } = (
      presign.body as {
        data: { objectKey: string; uploadUrl: string };
      }
    ).data;

    const put = await fetch(uploadUrl, {
      method: "PUT",
      body: "%PDF-1.4 test",
      headers: { "Content-Type": "application/pdf" },
    });
    assert.ok(put.ok, `presigned PUT failed: ${String(put.status)}`);

    const register = await api(
      owner,
      "POST",
      `/api/expenses/${String(expenseId)}/attachments`,
      {
        objectKey,
        fileName: `receipt-${String(stamp)}.pdf`,
        contentType: "application/pdf",
        bytes: 128,
      },
      locationA,
    );
    assert.equal(register.status, 201);
    const attachmentId = (register.body as { data?: { id?: number } }).data?.id;
    assert.ok(attachmentId);

    // Detail now carries the attachment.
    const detail = await api(
      owner,
      "GET",
      `/api/expenses/${String(expenseId)}`,
      undefined,
      locationA,
    );
    const attachments = (detail.body as { data?: { attachments?: unknown[] } })
      .data?.attachments;
    assert.equal(attachments?.length, 1);

    // Private download URL (ownership-checked, short-lived).
    const url = await api(
      owner,
      "GET",
      `/api/attachments/${String(attachmentId)}/url`,
      undefined,
      locationA,
    );
    assert.equal(url.status, 200);
    const downloadUrl = (url.body as { data?: { downloadUrl?: string } }).data
      ?.downloadUrl as string;
    const get = await fetch(downloadUrl);
    assert.equal(get.status, 200);
    assert.equal(await get.text(), "%PDF-1.4 test");

    // Tenancy: the other business cannot resolve the attachment.
    const foreign = await api(
      other,
      "GET",
      `/api/attachments/${String(attachmentId)}/url`,
    );
    assert.equal(foreign.status, 404);

    // Soft delete revokes further access.
    const del = await api(
      owner,
      "DELETE",
      `/api/attachments/${String(attachmentId)}`,
      undefined,
      locationA,
    );
    assert.equal(del.status, 200);
    const afterDelete = await api(
      owner,
      "GET",
      `/api/attachments/${String(attachmentId)}/url`,
      undefined,
      locationA,
    );
    assert.equal(afterDelete.status, 404);
  });

  it("presigning is denied for voided expenses", async () => {
    const expense = await api(
      owner,
      "POST",
      "/api/expenses",
      {
        title: "Voided host",
        expense_date: today(),
        amount: 10,
        category_id: null,
        payment_method: "Cash",
      },
      locationA,
    );
    const id = (expense.body as { id?: number }).id as number;
    await api(
      owner,
      "DELETE",
      `/api/expenses/${String(id)}`,
      undefined,
      locationA,
    );
    const res = await api(
      owner,
      "POST",
      `/api/expenses/${String(id)}/attachments/presign`,
      { fileName: "x.pdf", contentType: "application/pdf", sizeBytes: 100 },
      locationA,
    );
    assert.equal(res.status, 404);
  });
});
