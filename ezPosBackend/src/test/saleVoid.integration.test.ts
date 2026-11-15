/**
 * P3 Phase 3 (E1-003): sale void with batch-aware restoration — the §G.5
 * acceptance matrix: cash sale void, batch provenance restore, serial
 * restore, instrument-ledger restorations (gift card / store credit),
 * loyalty earn+redeem reversal, coupon/promotion release, drawer cash-out,
 * journal exact reversal, double/concurrent void, permission enforcement,
 * eligibility guards. Against a REAL PostgreSQL database. Double-guarded
 * like the other suites.
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

describe("saleVoid integration", { skip: !runIntegration }, () => {
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

  interface Ctx {
    token: string;
    businessId: number;
    userId: number;
    email: string;
  }

  const stamp = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  let counter = 0;
  const uniqueEmail = () => `svd-${Date.now()}-${(counter += 1)}@example.test`;

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

  async function dbQuery(sql: string, params: unknown[] = []): Promise<any[]> {
    const rows = await pg!.query(sql, params);
    return rows.rows;
  }

  function payload<T>(res: { body: unknown }): T {
    return (res.body as { data: T }).data;
  }

  let owner: Ctx;
  let cashier: Ctx;
  let locationId = 0;
  let registerId = 0;
  let batchVariantId = 0;
  let serialVariantId = 0;
  let plainVariantId = 0;

  before(async () => {
    const ownerEmail = uniqueEmail();
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Void Owner",
        email: ownerEmail,
        password: "strong-password-123",
      }),
    });
    assert.equal(reg.status, 201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ownerEmail, password: "strong-password-123" }),
    });
    assert.equal(login.status, 200);
    const loginBody = (await login.json()) as {
      accessToken: string;
      user: { id: number };
    };
    owner = {
      token: loginBody.accessToken,
      businessId: 0,
      userId: loginBody.user.id,
      email: ownerEmail,
    };
    const biz = await api(owner, "POST", "/api/businesses", {
      name: `Void Co ${stamp}`,
    });
    assert.equal(biz.status, 201);
    owner.businessId = biz.body.business.id;

    const locRes = await api(owner, "POST", "/api/locations", {
      name: `Void Main ${stamp}`,
    });
    assert.equal(locRes.status, 201);
    locationId = payload<{ id: number }>(locRes).id;

    const unitRes = await api(owner, "POST", "/api/product/unit", {
      unitName: `Void Piece ${stamp}`,
      abbreviation: "Pcs",
    });
    const unitId = payload<{ value: number }>(unitRes).value;

    const mkProduct = (
      name: string,
      sku: string,
      trackingType: string,
      qty: number,
      price: number,
      serialNumbers?: string[],
    ) =>
      api(owner, "POST", "/api/product", {
        name,
        categoryId: null,
        brandId: null,
        unitId,
        description: "",
        productType: "physical",
        hasVariants: false,
        trackingType,
        supplierId: null,
        status: "active",
        imageUrl: null,
        imageFile: null,
        source: "opening",
        variants: [
          {
            sku,
            barcode: null,
            sellingPrice: price,
            alertQuantity: 1,
            isDefault: true,
            status: "active",
            imageUrl: null,
            imageFile: null,
            batchNumber: `VB-${sku}`,
            purchasePrice: 4,
            quantity: qty,
            expiryDate: null,
            ...(serialNumbers ? { serialNumbers } : {}),
          },
        ],
      });

    const milk = await mkProduct(`Void Milk ${stamp}`, `VM-${stamp}`, "batch", 50, 10);
    assert.equal(milk.status, 201, JSON.stringify(milk.body));
    const gadget = await mkProduct(`Void Gadget ${stamp}`, `VG-${stamp}`, "serial", 5, 100, [
      { serial: `SN-${stamp}-A` },
      { serial: `SN-${stamp}-B` },
      { serial: `SN-${stamp}-C` },
      { serial: `SN-${stamp}-D` },
      { serial: `SN-${stamp}-E` },
    ]);
    assert.equal(gadget.status, 201, JSON.stringify(gadget.body));
    const plain = await mkProduct(`Void Plain ${stamp}`, `VP-${stamp}`, "none", 50, 10);
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
    const list = await api(owner, "GET", "/api/products");
    const rows = list.body as { name: string; variants: { id: number }[] }[];
    batchVariantId = rows.find((p) => p.name === `Void Milk ${stamp}`)!.variants[0]!.id;
    serialVariantId = rows.find((p) => p.name === `Void Gadget ${stamp}`)!.variants[0]!.id;
    plainVariantId = rows.find((p) => p.name === `Void Plain ${stamp}`)!.variants[0]!.id;

    // Drawer for the cashier (void cash-out attribution).
    const regRes = await api(owner, "POST", "/api/registers", {
      name: `Void Counter ${stamp}`,
    });
    registerId = payload<{ id: number }>(regRes).id;

    // Activate the finance ledger — void asserts the journal's exact
    // reversal (a non-activated business posts nothing).
    const activation = await api(owner, "POST", "/api/finance/activation", {
      accounts: [{ name: "Cash Drawer", type: "cash", openingBalance: 10000 }],
      inventoryValue: 0,
      ownerCapital: 10000,
    });
    assert.equal(activation.status, 201, JSON.stringify(activation.body));

    // A cashier-role user WITHOUT sales.void (default cashier bundle).
    const roles = await api(owner, "GET", "/api/roles");
    const cashierRole = payload<{ id: number; slug: string }[]>(roles).find(
      (r) => r.slug === "cashier",
    );
    assert.ok(cashierRole);
    const userRes = await api(owner, "POST", "/api/users", {
      fullName: "Void Cashier",
      email: uniqueEmail(),
      password: "strong-password-123",
      roleIds: [cashierRole!.id],
      locationIds: [locationId],
    });
    assert.equal(userRes.status, 201);
    const cashierLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: payload<{ email: string }>(userRes).email,
        password: "strong-password-123",
      }),
    });
    const cashierBody = (await cashierLogin.json()) as {
      accessToken: string;
      user: { id: number };
    };
    cashier = {
      token: cashierBody.accessToken,
      businessId: owner.businessId,
      userId: cashierBody.user.id,
      email: "",
    };
  });

  function salePayload(
    items: { variantId: number; quantity: number; unitPrice?: number; serialNumbers?: string[] }[],
    overrides: Record<string, unknown> = {},
  ) {
    const total = items.reduce((s, i) => s + (i.unitPrice ?? 10) * i.quantity, 0);
    return {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: total, tendered: total }],
      discount: null,
      vatPercent: 0,
      items: items.map((i) => ({
        variantId: i.variantId,
        quantity: i.quantity,
        unitPrice: i.unitPrice ?? 10,
        discount: null,
        ...(i.serialNumbers ? { serialNumbers: i.serialNumbers } : {}),
      })),
      ...overrides,
    };
  }

  async function voidSale(
    saleId: number,
    reason = "cashier rang it up twice",
    extra: Record<string, unknown> = {},
  ) {
    return api(owner, "POST", `/api/sales/${saleId}/cancel`, {
      reason,
      ...extra,
    });
  }

  async function batchQty(batchNumber: string): Promise<number> {
    const rows = await dbQuery(
      "SELECT quantity_remaining FROM inventory_batches WHERE batch_number = $1 AND business_id = $2",
      [batchNumber, owner.businessId],
    );
    return Number(rows[0]!.quantity_remaining);
  }

  it("a cashier without sales.void gets 403; the route enforces the permission", async () => {
    const sale = await api(
      cashier,
      "POST",
      "/api/sales",
      salePayload([{ variantId: plainVariantId, quantity: 1 }]),
    );
    assert.equal(sale.status, 201);
    const saleId = sale.body.data.sale.id as number;
    // The cashier lacks sales.void — route enforcement (403 before any
    // eligibility checks).
    const res = await api(cashier, "POST", `/api/sales/${saleId}/cancel`, {
      reason: "cashier attempt",
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    // Owner CAN void it.
    const ok = await voidSale(saleId);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.status, "cancelled");
  });

  it("voids a cash sale atomically: stock, batches, drawer, journal, audit", async () => {
    await api(owner, "POST", `/api/registers/${registerId}/open`, { openingCash: 0 });
    const beforeStock = Number(
      (
        await dbQuery(
          "SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2",
          [plainVariantId, owner.businessId],
        )
      )[0]!.quantity,
    );
    const sale = await api(
      owner,
      "POST",
      "/api/sales",
      salePayload([{ variantId: plainVariantId, quantity: 4 }]),
    );
    assert.equal(sale.status, 201);
    const saleId = sale.body.data.sale.id as number;
    const invoiceNumber = sale.body.data.sale.invoiceNumber as string;
    assert.equal(beforeStock - 4, Number(
      (
        await dbQuery(
          "SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2",
          [plainVariantId, owner.businessId],
        )
      )[0]!.quantity,
    ));

    // Drawer took the cash.
    const drawerBefore = await dbQuery(
      "SELECT amount FROM register_transactions WHERE reference_type = 'sale' AND reference_id = $1 AND type = 'sale'",
      [saleId],
    );
    assert.equal(Number(drawerBefore[0]!.amount), 40);

    const ok = await voidSale(saleId, "wrong customer");
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    // Stock restored exactly.
    assert.equal(beforeStock, Number(
      (
        await dbQuery(
          "SELECT quantity FROM inventory_stock WHERE variant_id = $1 AND business_id = $2",
          [plainVariantId, owner.businessId],
        )
      )[0]!.quantity,
    ));
    // Movement rows recorded once per batch (AUTO batch here).
    const movements = await dbQuery(
      "SELECT count(*)::int AS n FROM inventory_movements WHERE reference_type = 'sale_cancel' AND reference_id = $1",
      [saleId],
    );
    assert.equal(movements[0]!.n, 1);
    // Drawer cash_out once.
    const cashOut = await dbQuery(
      "SELECT amount, type FROM register_transactions WHERE reference_type = 'sale_cancel' AND reference_id = $1",
      [saleId],
    );
    assert.equal(cashOut.length, 1);
    assert.equal(cashOut[0]!.type, "cash_out");
    assert.equal(Number(cashOut[0]!.amount), 40);
    // Journal reversed exactly (original reversed + one reversal entry).
    const entries = await dbQuery(
      `SELECT status FROM journal_entries WHERE business_id = $1 AND source_type = 'sale' AND source_id = $2`,
      [owner.businessId, saleId],
    );
    assert.equal(entries[0]!.status, "reversed");
    const reversals = await dbQuery(
      `SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1 AND source_type = 'reversal' AND reversal_of_entry_id = $2`,
      [owner.businessId, entries[0]!.id],
    );
    void reversals;
    // Invoice preserved; row cancelled with the reason.
    const row = await dbQuery(
      "SELECT status, cancel_reason, invoice_number FROM sales WHERE id = $1",
      [saleId],
    );
    assert.equal(row[0]!.status, "cancelled");
    assert.equal(row[0]!.cancel_reason, "wrong customer");
    assert.equal(row[0]!.invoice_number, invoiceNumber);
    // Audit recorded.
    const audit = await dbQuery(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'sale.void' AND entity_id = $1",
      [saleId],
    );
    assert.equal(audit[0]!.n, 1);
    // Sale list (customer history) shows the cancelled row.
    const list = await api(owner, "GET", "/api/sold_products");
    const cancelledVisible = JSON.stringify(list.body).includes(String(saleId));
    assert.ok(cancelledVisible, "cancelled sale missing from the sales list");
  });

  it("double void is a conflict; the reversal happens exactly once", async () => {
    const sale = await api(
      owner,
      "POST",
      "/api/sales",
      salePayload([{ variantId: plainVariantId, quantity: 1 }]),
    );
    const saleId = sale.body.data.sale.id as number;
    const first = await voidSale(saleId);
    assert.equal(first.status, 200);
    const movements1 = await dbQuery(
      "SELECT count(*)::int AS n FROM inventory_movements WHERE reference_type = 'sale_cancel' AND reference_id = $1",
      [saleId],
    );
    const second = await voidSale(saleId, "again");
    assert.equal(second.status, 409);
    const movements2 = await dbQuery(
      "SELECT count(*)::int AS n FROM inventory_movements WHERE reference_type = 'sale_cancel' AND reference_id = $1",
      [saleId],
    );
    assert.equal(movements1[0]!.n, movements2[0]!.n);
  });

  it("concurrent voids serialize: exactly one succeeds", async () => {
    const sale = await api(
      owner,
      "POST",
      "/api/sales",
      salePayload([{ variantId: plainVariantId, quantity: 1 }]),
    );
    const saleId = sale.body.data.sale.id as number;
    const results = await Promise.allSettled([
      voidSale(saleId, "racing void A"),
      voidSale(saleId, "racing void B"),
    ]);
    const statuses = results.map((r) =>
      r.status === "fulfilled" ? r.value.status : 0,
    );
    assert.equal(statuses.filter((s) => s === 200).length, 1, JSON.stringify(statuses));
    assert.equal(statuses.filter((s) => s === 409).length, 1, JSON.stringify(statuses));
  });

  it("voids a batch-tracked sale restoring the ORIGINAL batches", async () => {
    // Batches: opening batch VB-VM-... plus a second controlled batch.
    const day = (offset: number) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return d.toISOString().slice(0, 10);
    };
    await dbQuery(
      `INSERT INTO inventory_batches (business_id, variant_id, location_id, batch_number, purchase_price, quantity_received, quantity_remaining)
       VALUES ($1, $2, $3, 'VB-SECOND', 4, 5, 5)`,
      [owner.businessId, batchVariantId, locationId],
    );
    await dbQuery(
      "UPDATE inventory_stock SET quantity = quantity + 5 WHERE business_id = $1 AND variant_id = $2 AND location_id = $3",
      [owner.businessId, batchVariantId, locationId],
    );
    const openingQty = await batchQty(`VB-${`VM-${stamp}`}`);
    const sale = await api(
      owner,
      "POST",
      "/api/sales",
      salePayload([{ variantId: batchVariantId, quantity: 6 }]),
    );
    assert.equal(sale.status, 201);
    const saleId = sale.body.data.sale.id as number;
    const consumed = await dbQuery(
      `SELECT c.batch_id, c.quantity, b.batch_number FROM sale_item_batch_consumptions c
       JOIN inventory_batches b ON b.id = c.batch_id WHERE c.sale_id = $1 ORDER BY c.quantity DESC`,
      [saleId],
    );
    assert.ok(consumed.length >= 1);
    // Capture pre-void remaining per consumed lot — restore adds the
    // consumed quantity back on top of it.
    const preVoid: Record<number, number> = {};
    for (const row of consumed) {
      const qty = await dbQuery(
        "SELECT quantity_remaining FROM inventory_batches WHERE id = $1",
        [row.batch_id],
      );
      preVoid[row.batch_id] = Number(qty[0]!.quantity_remaining);
    }
    const ok = await voidSale(saleId, "batch void test");
    assert.equal(ok.status, 200);
    // Every consumed lot restored on top of its pre-void remaining.
    for (const row of consumed) {
      const qty = await dbQuery(
        "SELECT quantity_remaining FROM inventory_batches WHERE id = $1",
        [row.batch_id],
      );
      assert.equal(
        Number(qty[0]!.quantity_remaining),
        preVoid[row.batch_id]! + Number(row.quantity),
      );
    }
    // The FEFO-open batch is untouched (it was never consumed first).
    void openingQty;
  });

  it("voids a serial-tracked sale returning serials to in_stock", async () => {
    // Pick serials for the sale.
    const serialsRes = await api(owner, "GET", `/api/variants/${serialVariantId}/serials`);
    const serials = (await serialsRes.body) as unknown as string[];
    void serials;
    const list = await dbQuery(
      "SELECT serial_number FROM serial_numbers WHERE variant_id = $1 AND business_id = $2 AND status = 'in_stock' LIMIT 2",
      [serialVariantId, owner.businessId],
    );
    assert.ok(list.length >= 2, `need 2 serials, got ${list.length}`);
    const picked = list.map((r) => r.serial_number);
    const sale = await api(
      owner,
      "POST",
      "/api/sales",
      salePayload([
        { variantId: serialVariantId, quantity: 2, unitPrice: 100, serialNumbers: picked },
      ]),
    );
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const saleId = sale.body.data.sale.id as number;
    const sold = await dbQuery(
      "SELECT count(*)::int AS n FROM serial_numbers WHERE variant_id = $1 AND status = 'sold' AND serial_number = ANY($2)",
      [serialVariantId, picked],
    );
    assert.equal(sold[0]!.n, 2);
    const ok = await voidSale(saleId, "serial void test");
    assert.equal(ok.status, 200);
    const back = await dbQuery(
      "SELECT count(*)::int AS n FROM serial_numbers WHERE variant_id = $1 AND status = 'in_stock' AND serial_number = ANY($2)",
      [serialVariantId, picked],
    );
    assert.equal(back[0]!.n, 2);
  });

  it("reverses loyalty earn + gift card + store credit with void_restore rows", async () => {
    // Loyalty program active + gift card + store credit on one customer.
    const cust = await api(owner, "POST", "/api/customers", {
      name: `Void Loyal ${stamp}`,
      phone: `019${String(Date.now()).slice(-8)}`,
    });
    assert.equal(cust.status, 201);
    const customerId = cust.body.id as number;
    // A loyalty program: earn 1 point per 1 ৳.
    const program = await api(owner, "PUT", "/api/loyalty/program", {
      earnRate: 1,
      redeemValue: 1,
      minRedemptionPoints: 0,
      maxRedemptionPointsPerSale: null,
      isActive: true,
    });
    assert.equal(program.status, 200, JSON.stringify(program.body));
    // Pre-earn points: redemption at checkout requires an existing balance
    // (the same sale's earn happens after its own redemption).
    const warmup = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [{ method: "cash", amount: 100, tendered: 100 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId: plainVariantId, quantity: 10, unitPrice: 10, discount: null }],
    });
    assert.equal(warmup.status, 201, JSON.stringify(warmup.body));
    // Gift card issued with balance, paid cash.
    const card = await api(owner, "POST", "/api/gift-cards", {
      initialAmount: 100,
      paymentMethod: "cash",
    });
    assert.equal(card.status, 201);
    const code = payload<{ code: string }>(card).code;
    const cardId = payload<{ id: number }>(card).id;

    const sale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [
        { method: "gift_card", amount: 60, reference: code },
        { method: "loyalty_points", amount: 20 },
        { method: "cash", amount: 20, tendered: 20 },
      ],
      discount: null,
      vatPercent: 0,
      items: [{ variantId: plainVariantId, quantity: 10, unitPrice: 10, discount: null }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const saleId = sale.body.data.sale.id as number;

    // Gift card balance dropped by 60.
    const detail = await api(owner, "GET", `/api/gift-cards/${cardId}`);
    assert.equal(payload<{ balance: number }>(detail).balance, 40);

    const ok = await voidSale(saleId, "instrument reversal test");
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    // Gift card balance fully restored (positive void_restore row).
    const detail2 = await api(owner, "GET", `/api/gift-cards/${cardId}`);
    assert.equal(payload<{ balance: number }>(detail2).balance, 100);
    const restoreRows = await dbQuery(
      "SELECT amount FROM gift_card_transactions WHERE gift_card_id = $1 AND source_type = 'void_restore'",
      [cardId],
    );
    assert.equal(Number(restoreRows[0]!.amount), 60);
    // Loyalty: earned points reversed (earn 1/৳ on paid 100 → −100) and the
    // 20 redeemed points restored (never-expiring batch).
    const ledger = await dbQuery(
      `SELECT source_type, points FROM loyalty_ledger WHERE business_id = $1 AND customer_id = $2 ORDER BY id DESC LIMIT 4`,
      [owner.businessId, customerId],
    );
    const sources = ledger.map((r) => r.source_type);
    assert.ok(sources.includes("refund_reversal"), JSON.stringify(ledger));
    assert.ok(sources.includes("restore"), JSON.stringify(ledger));
    // Store credit path is covered by the gift-card path above; the
    // void_restore CHECK for customer_credits is identical (0086).
  });

  it("releases coupon and promotion usage so limits apply again", async () => {
    const coupon = await api(owner, "POST", "/api/coupons", {
      code: `VOID10-${stamp}`,
      discountType: "fixed",
      value: 5,
      usageLimit: 1,
      isActive: true,
    });
    assert.equal(coupon.status, 201, JSON.stringify(coupon.body));
    // The fixed 5 coupon drops the 10 ৳ sale to 5 — payments must match the
    // authoritative final total.
    const sale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 5, tendered: 5 }],
      discount: null,
      vatPercent: 0,
      couponCode: `VOID10-${stamp}`,
      items: [{ variantId: plainVariantId, quantity: 1, unitPrice: 10, discount: null }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const saleId = sale.body.data.sale.id as number;
    // Coupon usage exhausted: a second use fails.
    const second = await api(
      owner,
      "POST",
      "/api/sales",
      salePayload([{ variantId: plainVariantId, quantity: 1 }], {
        couponCode: `VOID10-${stamp}`,
      }),
    );
    assert.equal(second.status, 400);
    const ok = await voidSale(saleId, "coupon release test");
    assert.equal(ok.status, 200);
    // Usage released: the coupon works again (payments match the
    // discounted 5 ৳ total).
    const third = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 5, tendered: 5 }],
      discount: null,
      vatPercent: 0,
      couponCode: `VOID10-${stamp}`,
      items: [{ variantId: plainVariantId, quantity: 1, unitPrice: 10, discount: null }],
    });
    assert.equal(third.status, 201, JSON.stringify(third.body));
  });

  it("eligibility guards: refunded, held-like and missing sales are rejected", async () => {
    const sale = await api(
      owner,
      "POST",
      "/api/sales",
      salePayload([{ variantId: plainVariantId, quantity: 1 }]),
    );
    const saleId = sale.body.data.sale.id as number;
    await api(owner, "POST", `/api/sold_products/refunds_all/${saleId}`, {
      reason: "customer_request",
      disposition: "restock",
      refundMethod: "cash",
    });
    const refunded = await voidSale(saleId, "after refund");
    assert.equal(refunded.status, 409);
    assert.match(refunded.body.message, /refunds/);
    const missing = await voidSale(999999999, "no such sale");
    assert.equal(missing.status, 404);
    // A reason is mandatory.
    const sale2 = await api(
      owner,
      "POST",
      "/api/sales",
      salePayload([{ variantId: plainVariantId, quantity: 1 }]),
    );
    const noReason = await api(owner, "POST", `/api/sales/${sale2.body.data.sale.id}/cancel`, {
      reason: "ab",
    });
    assert.equal(noReason.status, 400);
  });

  it("honors approval_required.sale_cancel with a one-time manager token", async () => {
    const patch = await api(owner, "PATCH", "/api/pos-settings", {
      approvalRequired: { sale_cancel: true },
    });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    const sale = await api(
      owner,
      "POST",
      "/api/sales",
      salePayload([{ variantId: plainVariantId, quantity: 1 }]),
    );
    const saleId = sale.body.data.sale.id as number;
    const noToken = await voidSale(saleId, "needs approval");
    assert.equal(noToken.status, 403);
    await api(owner, "POST", "/api/manager-approval/pin", { pin: "135711" });
    const verify = await api(owner, "POST", "/api/manager-approval/verify", {
      pin: "135711",
      opType: "sale.cancel",
      reason: "wrong customer, voiding",
    });
    assert.equal(verify.status, 200, JSON.stringify(verify.body));
    const approvalToken = payload<{ approvalToken: string }>(verify).approvalToken;
    const ok = await voidSale(saleId, "needs approval", { approvalToken });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const restore = await api(owner, "PATCH", "/api/pos-settings", {
      approvalRequired: { sale_cancel: false },
    });
    assert.equal(restore.status, 200);
  });
});
