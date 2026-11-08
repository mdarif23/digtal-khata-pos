/**
 * Finance & Growth posting-hook integration tests (Stage 3).
 *
 * Verifies the operational flows post balanced entries to the double-entry
 * ledger through the real API surface, and that the books stay balanced:
 *   purchase receive + supplier payment → 1050/1045/2010/cash
 *   cash sale → 1010/4010/5010/1050
 *   partial due sale + collection → 1040
 *   refund with restock → 4020 + COGS/inventory reversal
 *   expense (paid) → mapped expense account / cash
 *   trial balance balances; A = L + E holds after every scenario
 *
 * Double-guarded like the other suites: runs ONLY with INTEGRATION_TESTS=1
 * AND DATABASE_URL pointing at ezpos_test (fail-closed).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe("finance posting hooks integration", { skip: !runIntegration }, () => {
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

  let owner: Ctx;
  let variantId = 0;
  let supplierId = 0;
  let customerId = 0;

  /** GL balances by account code (posted entries only, all time). */
  async function balances(): Promise<Map<string, number>> {
    const res = await api(owner, "GET", "/api/finance/accounts/balances");
    assert.equal(res.status, 200);
    return new Map(
      (res.body.rows as { code: string; balance: string }[]).map((r) => [
        r.code,
        Number(r.balance),
      ]),
    );
  }

  async function assertBooksBalanced(): Promise<void> {
    const tb = await api(owner, "GET", "/api/finance/trial-balance");
    assert.equal(tb.status, 200);
    assert.equal(
      tb.body.balanced,
      true,
      `trial balance must balance (DR ${tb.body.totalDebit} vs CR ${tb.body.totalCredit})`,
    );
  }

  before(async () => {
    const email = `finhooks-owner-${stamp}@example.test`;
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Hooks Owner", email, password: "strong-password-123" }),
    });
    assert.equal(reg.status, 201);
    const login = await (await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    })).json() as { accessToken: string; user: { id: number } };
    const biz = await (await fetch(`${baseUrl}/api/businesses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.accessToken}` },
      body: JSON.stringify({ name: `Hook Biz ${stamp}` }),
    })).json() as { business: { id: number } };
    owner = {
      token: login.accessToken,
      businessId: biz.business.id,
      userId: login.user.id,
      email,
    };
    const loc = await api(owner, "POST", "/api/locations", { name: "Main Store" });
    assert.equal(loc.status, 201);

    // Product with opening stock: 500 units @ cost 40, sells at 100.
    const unit = await api(owner, "POST", "/api/product/unit", {
      unitName: `Pcs ${stamp}`,
      abbreviation: "Pcs",
    });
    const unitId = unit.body.data.value as number;
    const product = await api(owner, "POST", "/api/product", {
      name: `Hook Cola ${stamp}`,
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
          sku: `HOOK-${stamp}`,
          barcode: null,
          sellingPrice: 100,
          alertQuantity: 5,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `HB-${stamp}`,
          purchasePrice: 40,
          quantity: 500,
          expiryDate: null,
        },
      ],
    });
    assert.equal(product.status, 201);
    const list = await api(owner, "GET", "/api/products");
    const created = (list.body as { name: string; variants: { id: number }[] }[]).find(
      (p) => p.name === `Hook Cola ${stamp}`,
    );
    assert.ok(created);
    variantId = created.variants[0]!.id;

    const supplier = await api(owner, "POST", "/api/contacts/supplier", {
      supplierName: `Hook Supplier ${stamp}`,
      phone: "+8801710000001",
      email: null,
      address: null,
    });
    assert.equal(supplier.status, 201, JSON.stringify(supplier.body));
    supplierId = (supplier.body.data as { supplierId: number }).supplierId;

    const customer = await api(owner, "POST", "/api/customers", {
      name: "Hook Customer",
      phone: "1710000002",
    });
    assert.equal(customer.status, 201);
    customerId = customer.body.id ?? customer.body.data?.id;

    // Activate the ledger: cash 10000, inventory at opening value 20000,
    // owner capital 10000 → retained-earnings plug 12000.
    const activation = await api(owner, "POST", "/api/finance/activation", {
      accounts: [{ name: "Cash Drawer", type: "cash", openingBalance: 10000 }],
      inventoryValue: 20000,
      ownerCapital: 10000,
    });
    assert.equal(activation.status, 201, JSON.stringify(activation.body));
  });

  let firstSaleId = 0;

  it("posts a cash sale with revenue and COGS", async () => {
    const before = await balances();
    const sale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 300, tendered: 300 }],
      discount: null,
      vatPercent: null,
      items: [{ variantId, quantity: 3, unitPrice: 100, discount: null }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    firstSaleId = sale.body.data.sale.id;

    const after = await balances();
    assert.equal((after.get("1010") ?? 0) - (before.get("1010") ?? 0), 300);
    // Revenue is credit-normal: its (debits − credits) balance goes negative.
    assert.equal((after.get("4010") ?? 0) - (before.get("4010") ?? 0), -300);
    // COGS at the blended batch cost (40/unit).
    assert.equal((after.get("5010") ?? 0) - (before.get("5010") ?? 0), 120);
    assert.equal((after.get("1050") ?? 0) - (before.get("1050") ?? 0), -120);
    await assertBooksBalanced();
  });

  it("nets a restocked refund against revenue, cash and COGS", async () => {
    const before = await balances();
    assert.ok(firstSaleId);
    const refund = await api(
      owner,
      "POST",
      `/api/sold_products/refunds_all/${firstSaleId}`,
      { reason: "customer_request", disposition: "restock" },
    );
    assert.equal(refund.status, 200, JSON.stringify(refund.body));

    const after = await balances();
    assert.equal((after.get("1010") ?? 0) - (before.get("1010") ?? 0), -300);
    assert.equal((after.get("4020") ?? 0) - (before.get("4020") ?? 0), 300);
    // Restock returns the goods at cost: inventory up, COGS reversed.
    assert.equal((after.get("1050") ?? 0) - (before.get("1050") ?? 0), 120);
    assert.equal((after.get("5010") ?? 0) - (before.get("5010") ?? 0), -120);
    await assertBooksBalanced();
  });

  it("posts a partial due sale and its collection", async () => {
    const before = await balances();
    const sale = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId,
      payments: [
        { method: "cash", amount: 100, tendered: 100 },
        { method: "due", amount: 100 },
      ],
      discount: null,
      vatPercent: null,
      items: [{ variantId, quantity: 2, unitPrice: 100, discount: null }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    let after = await balances();
    assert.equal((after.get("1040") ?? 0) - (before.get("1040") ?? 0), 100);
    assert.equal((after.get("5010") ?? 0) - (before.get("5010") ?? 0), 80);

    // Collect the due at the counter.
    const saleId = sale.body.data?.sale?.id;
    assert.ok(saleId);
    const payment = await api(owner, "POST", "/api/due-management/customer-payment", {
      saleId,
      amount: 100,
      paymentMethod: "cash",
    });
    assert.equal(payment.status, 201, JSON.stringify(payment.body));
    after = await balances();
    assert.equal((after.get("1040") ?? 0) - (before.get("1040") ?? 0), 0);
    assert.equal((after.get("1010") ?? 0) - (before.get("1010") ?? 0), 200);
    await assertBooksBalanced();
  });

  it("posts purchase receive and supplier payment", async () => {
    const before = await balances();
    const purchase = await api(owner, "POST", "/api/purchases", {
      items: [{ variantId, quantity: 3, purchasePrice: 40, discount: 0, tax: 0 }],
      supplierId,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      tax: 0,
      shippingCost: 0,
    });
    assert.equal(purchase.status, 201, JSON.stringify(purchase.body));

    const itemsRes = await api(owner, "GET", "/api/purchases/items");
    assert.equal(itemsRes.status, 200);
    const purchaseItems = itemsRes.body as Array<{
      id: number;
      purchaseId: number;
      trackingType: string;
    }>;
    const purchaseRow = (await api(owner, "GET", "/api/due-management/suppliers"))
      .body as Array<{ purchaseId: number }>;
    const purchaseId = purchaseRow[0]!.purchaseId;
    const receiveItems = purchaseItems
      .filter((item) => item.purchaseId === purchaseId)
      .map((item) => ({
        itemId: item.id,
        trackingType: item.trackingType,
        receiveNow: 3,
        unitCost: 40,
        sellingPrice: 100,
        batches: [],
        serialNumbers: [],
      }));
    const receive = await api(owner, "POST", "/api/purchases/receive", {
      purchaseId,
      items: receiveItems,
      paymentAmount: 0,
      paymentMethod: "cash",
    });
    assert.equal(receive.status, 201, JSON.stringify(receive.body));

    let after = await balances();
    assert.equal((after.get("1050") ?? 0) - (before.get("1050") ?? 0), 120);
    // Payable is credit-normal: the balance goes negative while owed.
    assert.equal((after.get("2010") ?? 0) - (before.get("2010") ?? 0), -120);

    const payment = await api(owner, "POST", "/api/due-management/supplier-payment", {
      purchaseId,
      amount: 120,
      method: "cash",
    });
    assert.equal(payment.status, 201, JSON.stringify(payment.body));
    after = await balances();
    assert.equal((after.get("2010") ?? 0) - (before.get("2010") ?? 0), 0);
    assert.equal((after.get("1010") ?? 0) - (before.get("1010") ?? 0), -120);
    await assertBooksBalanced();
  });

  it("posts an expense with its initial settlement", async () => {
    const before = await balances();
    const expense = await api(owner, "POST", "/api/expenses", {
      title: `Utilities ${stamp}`,
      amount: 80,
      category_id: null,
      payment_method: "Cash",
      expense_date: new Date().toISOString().slice(0, 10),
    });
    assert.equal(expense.status, 201, JSON.stringify(expense.body));

    const after = await balances();
    assert.equal((after.get("5900") ?? 0) - (before.get("5900") ?? 0), 80);
    assert.equal((after.get("1010") ?? 0) - (before.get("1010") ?? 0), -80);
    await assertBooksBalanced();
  });

  it("keeps assets = liabilities + equity after every scenario", async () => {
    const tb = await api(owner, "GET", "/api/finance/trial-balance");
    const byType = new Map(
      (tb.body.sections as { type: string; totalDebit: string; totalCredit: string }[]).map(
        (s) => [s.type, { debit: Number(s.totalDebit), credit: Number(s.totalCredit) }],
      ),
    );
    // Fully-settled account types drop out of the sections — default to zero.
    const zero = { debit: 0, credit: 0 };
    const assets = byType.get("asset") ?? zero;
    const liabilities = byType.get("liability") ?? zero;
    const equity = byType.get("equity") ?? zero;
    const revenue = byType.get("revenue") ?? zero;
    const expenses = byType.get("expense") ?? zero;
    // Assets = Liabilities + (Equity + Revenue − Expenses)
    const lhs = assets.debit - assets.credit;
    const rhs =
      (liabilities.credit - liabilities.debit) +
      (equity.credit - equity.debit) +
      (revenue.credit - revenue.debit) -
      (expenses.debit - expenses.credit);
    assert.equal(lhs, rhs, `A=${lhs} must equal L+E+R−X=${rhs}`);
  });
});
