import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { unlink, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { connectTestDb } from "./helpers/db.js";
import { startTestServer } from "./helpers/server.js";
import {
  authHeaders,
  createOwnerCtx,
  getJson,
  postJson,
  type OwnerCtx,
} from "./helpers/fixtures.js";

/**
 * Backup & Restore integration suite. Exercises the full pipeline through
 * the real HTTP API: manual backup → verify → download → mutate → full
 * restore (with pre-restore safety backup) → selective restore → tenant
 * isolation → tamper rejection.
 *
 * Object storage is NOT configured in tests, so packages take the
 * documented server-local fallback path — which also lets us tamper with
 * the stored bytes to prove integrity checking.
 */

const canRun =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

let baseUrl: string;
let close: () => Promise<void>;
let owner: OwnerCtx;
let other: OwnerCtx;

async function pollBackup(id: number): Promise<any> {
  for (let i = 0; i < 120; i++) {
    const res = await getJson(baseUrl, owner, `/api/backups/${id}`);
    if (res.status === 200 && !["pending", "running"].includes(res.body.data?.status)) {
      return res.body.data;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Backup ${id} did not finish in time`);
}

async function pollRestore(id: number): Promise<any> {
  for (let i = 0; i < 240; i++) {
    const res = await getJson(baseUrl, owner, `/api/backups/restore/${id}`);
    if (res.status === 200 && !["pending", "validating", "running", "verifying"].includes(res.body.data?.status)) {
      return res.body.data;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Restore ${id} did not finish in time`);
}

async function createCustomer(name: string): Promise<number> {
  const res = await postJson<{ id: number }>(baseUrl, owner, "/api/customers", {
    name,
    phone: "+8801700000001",
  });
  assert.equal(res.status, 201, `customer create failed: ${JSON.stringify(res.body)}`);
  return (res.body as { id: number }).id;
}

async function listCustomers(): Promise<Array<{ id: number; name: string }>> {
  const res = await getJson<{ data: Array<{ id: number; name: string }> }>(
    baseUrl,
    owner,
    "/api/customers?page=1&pageSize=100",
  );
  assert.equal(res.status, 200);
  return (res.body as unknown as Array<{ id: number; name: string }>) ?? [];
}

test("backups pipeline", { skip: !canRun }, async (t) => {
  const client = await connectTestDb();

  before(async () => {
    // Same seed convention as the other suites: trials need the plan row,
    // and role templates validate against the seeded permission catalog.
    await client.query(
      `INSERT INTO subscription_plans (name, slug, interval, price, currency, is_active)
       VALUES ('Free trial', 'free-trial', 'monthly', 0, 'BDT', true)
       ON CONFLICT (slug) DO UPDATE
       SET limits = NULL, is_active = true`,
    );
    const { ensureRbacSeed } = await import("../rbac/seed.js");
    await ensureRbacSeed();
    const server = startTestServer();
    baseUrl = server.baseUrl;
    close = server.close;
    owner = await createOwnerCtx(baseUrl, `Backup Biz ${Date.now()}`);
    other = await createOwnerCtx(baseUrl, `Other Biz ${Date.now()}`);
    await createCustomer("Original Customer");
  });

  after(async () => {
    await client.end();
    await close();
  });

  await t.test("modules metadata endpoint lists groups", async () => {
    const res = await getJson(baseUrl, owner, "/api/backups/modules");
    assert.equal(res.status, 200);
    assert.ok(res.body.data.groups.length >= 10);
    assert.equal(res.body.data.storageEnabled, false); // no S3 in tests
  });

  let backupId: number;
  let storageKey: string;

  await t.test("manual backup completes with verified manifest", async () => {
    const started = await postJson(baseUrl, owner, "/api/backups", {});
    assert.equal(started.status, 202, JSON.stringify(started.body));
    backupId = started.body.data.id;

    const row = await pollBackup(backupId);
    assert.equal(row.status, "completed");
    assert.equal(row.error, null);
    assert.ok(row.verifiedAt);
    assert.ok(row.sha256);
    storageKey = row.storageKey;
    assert.ok(storageKey.startsWith("local:"));
    const manifest = row.manifest;
    assert.equal(manifest.businessId, owner.businessId);
    assert.equal(manifest.completion, "complete");
    assert.ok(manifest.recordCounts["customers"] >= 1);
    assert.ok(manifest.recordCounts["_profile"] === 1);
    assert.equal(manifest.encryption.alg, "AES-256-GCM");
  });

  await t.test("concurrent duplicate backup is rejected with 409", async () => {
    const [{ rows }] = [await client.query(
      `INSERT INTO business_backups (business_id, type, status)
       VALUES ($1, 'manual', 'running') RETURNING id`,
      [owner.businessId],
    )];
    const fakeRunning = (rows[0] as { id: number }).id;
    const dup = await postJson(baseUrl, owner, "/api/backups", {});
    assert.equal(dup.status, 409);
    await client.query("DELETE FROM business_backups WHERE id = $1", [fakeRunning]);
  });

  await t.test("verify endpoint re-checks integrity", async () => {
    const res = await postJson(baseUrl, owner, `/api/backups/${backupId}/verify`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.data.verified, true);
  });

  await t.test("download streams the encrypted package (EZBACKUP1 magic)", async () => {
    const res = await fetch(`${baseUrl}/api/backups/${backupId}/download`, {
      headers: authHeaders(owner),
    });
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.subarray(0, 9).toString("ascii") === "EZBACKUP1");
  });

  await t.test("download-url refuses local-fallback storage", async () => {
    const res = await getJson(baseUrl, owner, `/api/backups/${backupId}/download-url`);
    assert.equal(res.status, 409);
  });

  await t.test("tampering with the stored package fails verification", async () => {
    const filePath = path.join(tmpdir(), "ezpos-backups", storageKey.slice("local:".length));
    const original = await readFile(filePath);
    const tampered = Buffer.from(original);
    tampered.set([original[tampered.length - 10]! ^ 0xff], tampered.length - 10);
    await writeFile(filePath, tampered);
    try {
      const res = await postJson(baseUrl, owner, `/api/backups/${backupId}/verify`, {});
      assert.equal(res.status, 200);
      assert.equal(res.body.data.verified, false);
      assert.match(res.body.data.error, /integrity|corrupt|tamper|checksum/i);
    } finally {
      await writeFile(filePath, original); // restore for the restore tests
    }
  });

  await t.test("tenant isolation: another business sees nothing", async () => {
    const get = await getJson(baseUrl, other, `/api/backups/${backupId}`);
    assert.equal(get.status, 404);
    const verify = await postJson(baseUrl, other, `/api/backups/${backupId}/verify`, {});
    assert.equal(verify.status, 404);
    const dl = await fetch(
      `${baseUrl}/api/backups/${backupId}/download-url`,
      { headers: authHeaders(other) },
    );
    assert.equal(dl.status, 404);
    const del = await fetch(`${baseUrl}/api/backups/${backupId}`, {
      method: "DELETE",
      headers: authHeaders(other),
    });
    assert.equal(del.status, 404);
  });

  await t.test("restore refuses without the typed confirmation", async () => {
    const res = await postJson(baseUrl, owner, "/api/backups/restore", {
      backupId,
      mode: "full",
    });
    assert.equal(res.status, 400);
    assert.match(String(res.body.message ?? ""), /confirm|Invalid|required/i);
  });

  await t.test("preview reports ready-for-restore", async () => {
    const res = await postJson(baseUrl, owner, "/api/backups/restore/preview", {
      backupId,
      mode: "full",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.readyForRestore, true);
    assert.equal(res.body.data.manifest.businessId, owner.businessId);
  });

  await t.test("full restore reverts later mutations (with safety backup)", async () => {
    // Mutate AFTER the backup: an extra customer and a rename.
    await createCustomer("Second Customer");
    const customersBefore = await listCustomers();
    assert.equal(customersBefore.length, 2);

    const preview = await postJson(baseUrl, owner, "/api/backups/restore/preview", {
      backupId,
      mode: "full",
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.data.readyForRestore, true);

    const started = await postJson(baseUrl, owner, "/api/backups/restore", {
      backupId,
      mode: "full",
      confirm: "RESTORE",
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const job = await pollRestore(started.body.data.id);
    assert.equal(job.status, "completed", JSON.stringify(job.error ?? job));
    assert.ok(job.preRestoreBackupId, "safety backup was taken");
    const result = job.result;
    const customerCount = result.counts.find((c: any) => c.table === "customers");
    assert.equal(customerCount.actual, 1);
    assert.equal(customerCount.match, true);
    assert.equal(
      result.countMismatches.length,
      0,
      JSON.stringify(result.countMismatches),
    );

    const customersAfter = await listCustomers();
    assert.equal(customersAfter.length, 1, "row absent from the package was deleted");
    assert.equal(customersAfter[0]!.name, "Original Customer");
  });

  await t.test("selective restore upserts without deleting newer rows", async () => {
    // Selective contacts-only package.
    const started = await postJson(baseUrl, owner, "/api/backups", {
      modules: ["contacts"],
    });
    assert.equal(started.status, 202);
    const selective = await pollBackup(started.body.data.id);
    assert.equal(selective.status, "completed");
    assert.deepEqual(selective.manifest.modules, ["contacts"]);

    await createCustomer("Extra Customer");
    const restore = await postJson(baseUrl, owner, "/api/backups/restore", {
      backupId: selective.id,
      mode: "selective",
      confirm: "RESTORE",
    });
    assert.equal(restore.status, 202, JSON.stringify(restore.body));
    const job = await pollRestore(restore.body.data.id);
    assert.equal(job.status, "completed", JSON.stringify(job.error ?? job));
    const customers = await listCustomers();
    // The original customer is upserted; "Second Customer" (created after
    // the selective package) must NOT be deleted in selective mode.
    assert.equal(customers.length, 2);
    assert.ok(customers.some((c) => c.name === "Extra Customer"));
  });

  await t.test("cross-business restore is blocked by identity check", async () => {
    const preview = await postJson(baseUrl, other, "/api/backups/restore/preview", {
      backupId,
      mode: "full",
    });
    assert.equal(preview.status, 404, "other business cannot even preview");
  });

  await t.test("last known-good backup cannot be deleted", async () => {
    // Delete the selective backup (a second completed backup exists).
    const del = await fetch(`${baseUrl}/api/backups/${backupId}`, {
      method: "DELETE",
      headers: authHeaders(owner),
    });
    assert.equal(del.status, 200);
    // Delete completed backups until only one remains; that one is the
    // last known-good and must be refused (pre-restore safety copies from
    // the restore test may also be present).
    let guard = 0;
    for (;;) {
      const list = await getJson(baseUrl, owner, "/api/backups?status=completed");
      const remaining = list.body.data.items as Array<{ id: number }>;
      if (remaining.length <= 1) {
        const delLast = await fetch(`${baseUrl}/api/backups/${remaining[0]!.id}`, {
          method: "DELETE",
          headers: authHeaders(owner),
        });
        assert.equal(delLast.status, 409);
        const delBody = (await delLast.json().catch(() => null)) as { message?: string } | null;
        assert.match(delBody?.message ?? "", /last known-good/i);
        break;
      }
      const del = await fetch(`${baseUrl}/api/backups/${remaining[0]!.id}`, {
        method: "DELETE",
        headers: authHeaders(owner),
      });
      assert.equal(del.status, 200);
      if (++guard > 10) throw new Error("too many completed backups to clean");
    }
  });

  await t.test("schedule save/load round-trips", async () => {
    const put = await fetch(`${baseUrl}/api/backups/schedule`, {
      method: "PUT",
      headers: authHeaders(owner),
      body: JSON.stringify({
        enabled: true,
        frequency: "daily",
        hour: 2,
        retentionDays: 30,
      }),
    });
    assert.equal(put.status, 200, JSON.stringify(await put.json()));
    const got = await getJson(baseUrl, owner, "/api/backups/schedule");
    assert.equal(got.body.data.schedule.enabled, true);
    assert.equal(got.body.data.schedule.hour, 2);
    assert.ok(got.body.data.schedule.nextRunAt);

    const weekly = await fetch(`${baseUrl}/api/backups/schedule`, {
      method: "PUT",
      headers: authHeaders(owner),
      body: JSON.stringify({
        enabled: true,
        frequency: "weekly",
        hour: 3,
        dayOfWeek: 0,
        retentionDays: 14,
      }),
    });
    assert.equal(weekly.status, 200);
    const gotWeekly = await getJson(baseUrl, owner, "/api/backups/schedule");
    assert.equal(gotWeekly.body.data.schedule.frequency, "weekly");

    // Disable at the end so the sweep never starts backups for this biz.
    await fetch(`${baseUrl}/api/backups/schedule`, {
      method: "PUT",
      headers: authHeaders(owner),
      body: JSON.stringify({
        enabled: false,
        frequency: "daily",
        hour: 2,
        retentionDays: 30,
      }),
    });
  });

  await t.test("sweep is a no-op without object storage (documented fallback)", async () => {
    const { runBackupSweeps } = await import(
      "../modules/backups/backups.service.js"
    );
    const result = await runBackupSweeps();
    assert.deepEqual(result, {
      backupsStarted: 0,
      schedulesSkipped: 0,
      expiredDeleted: 0,
    });
  });

  await t.test("cashiers cannot see backups", async () => {
    // Create a cashier via the users API.
    const roles = await getJson<{ data: Array<{ id: number; slug: string }> }>(
      baseUrl,
      owner,
      "/api/roles",
    );
    const cashierRole = roles.body.data.find((r) => r.slug === "cashier");
    assert.ok(cashierRole, "cashier role exists");
    const email = `cashier-bk-${Date.now()}@example.test`;
    const created = await postJson(baseUrl, owner, "/api/users", {
      fullName: "Backup Cashier",
      email,
      password: "strong-password-123",
      roleIds: [cashierRole.id],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    const loginBody = (await login.json()) as { accessToken: string };
    const res = await fetch(`${baseUrl}/api/backups`, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${loginBody.accessToken}`,
        "X-Business-Id": String(owner.businessId),
      },
    });
    assert.equal(res.status, 403);
  });

  void unlink;
  void appendFile;
});
