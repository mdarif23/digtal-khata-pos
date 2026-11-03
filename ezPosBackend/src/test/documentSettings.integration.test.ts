/**
 * Document settings (receipt & invoice customization) integration tests.
 *
 * Covers: default templates, updating receipt/invoice configs, invalid
 * config rejection, business isolation, permission enforcement, logo
 * upload validation/removal, and the branding/documentSettings blocks
 * embedded in the sale receipt payload (with financial values still
 * sourced from the sale).
 *
 * Double-guarded like every integration suite: runs ONLY with
 * INTEGRATION_TESTS=1 AND DATABASE_URL pointing at ezpos_test; fails
 * closed otherwise.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { ensureRbacSeed } from "../rbac/seed.js";

const runIntegration =
  process.env.INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

// 1x1 transparent PNG (67 bytes) — a real image so magic-byte checks pass.
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("document settings integration", { skip: !runIntegration }, () => {
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

  interface Ctx {
    token: string;
    businessId: number;
    userId: number;
    locationId: number;
  }

  async function api(
    ctx: { token: string; businessId: number },
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
    let parsed: unknown = null;
    const text = await res.text();
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
        fullName: "DocSettings Test",
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

    const loc = await fetch(`${baseUrl}/api/locations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${loginBody.accessToken}`,
        "X-Business-Id": String(bizBody.business.id),
      },
      body: JSON.stringify({ name: "Main Store" }),
    });
    assert.equal(loc.status, 201);
    const locBody = (await loc.json()) as { data: { id: number } };

    return {
      token: loginBody.accessToken,
      businessId: bizBody.business.id,
      userId: loginBody.user.id,
      locationId: locBody.data.id,
    };
  }

  let owner: Ctx;
  let other: Ctx;
  let cashier: Ctx;
  let manager: Ctx;

  before(async () => {
    const stamp = Date.now();
    owner = await registerAndCreateBusiness(
      `docset-owner-${stamp}@example.test`,
      `DocSet Biz ${stamp}`,
    );
    other = await registerAndCreateBusiness(
      `docset-other-${stamp}@example.test`,
      `DocSet Other ${stamp}`,
    );

    // Staff users for permission tests.
    const rolesRes = await api(owner, "GET", "/api/roles");
    assert.equal(rolesRes.status, 200);
    const bySlug = new Map<string, { id: number }>(
      (rolesRes.body as { data: { id: number; slug: string }[] }).data.map(
        (r) => [r.slug, r],
      ),
    );
    async function createStaff(label: string, roleId: number): Promise<Ctx> {
      const email = `docset-${label}-${stamp}@example.test`;
      const created = await api(owner, "POST", "/api/users", {
        fullName: `DocSet ${label}`,
        email,
        password: "strong-password-123",
        roleIds: [roleId],
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const createdBody = created.body as { data: { userId: number } };
      await api(
        owner,
        "PATCH",
        `/api/users/${createdBody.data.userId}`,
        { locationIds: [owner.locationId] },
      );
      const login = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "strong-password-123" }),
      });
      assert.equal(login.status, 200);
      const loginBody = (await login.json()) as {
        accessToken: string;
        user: { id: number };
      };
      return {
        token: loginBody.accessToken,
        businessId: owner.businessId,
        userId: loginBody.user.id,
        locationId: owner.locationId,
      };
    }
    cashier = await createStaff("cashier", bySlug.get("cashier")!.id);
    manager = await createStaff("manager", bySlug.get("manager")!.id);
  });

  it("default roles carry the receipt_settings permission template", async () => {
    const rolesRes = await api(owner, "GET", "/api/roles");
    assert.equal(rolesRes.status, 200);
    const roles = (rolesRes.body as {
      data: { slug: string; permissionKeys: string[] }[];
    }).data;
    const cashierRole = roles.find((r) => r.slug === "cashier")!;
    const managerRole = roles.find((r) => r.slug === "manager")!;
    assert.ok(cashierRole.permissionKeys.includes("receipt_settings.view"));
    assert.ok(!cashierRole.permissionKeys.includes("receipt_settings.edit"));
    assert.ok(managerRole.permissionKeys.includes("receipt_settings.edit"));
    assert.ok(managerRole.permissionKeys.includes("receipt_settings.manage_logo"));
  });

  it("GET returns versioned defaults before any customization", async () => {
    const res = await api(owner, "GET", "/api/document-settings");
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    const data = res.body.data;
    assert.equal(data.defaultsVersion, 1);
    // Receipt defaults mirror the legacy printed receipt.
    assert.equal(data.sales_receipt.paperWidth, "80mm");
    assert.equal(data.sales_receipt.visibility.grandTotal, true);
    assert.equal(data.sales_receipt.visibility.qrCode, false);
    assert.equal(data.sales_receipt.layout.itemTableStyle, "detailed");
    assert.equal(data.sales_receipt.print.autoPrintOnSale, false);
    assert.equal(data.sales_receipt.print.copies, 1);
    // Invoice defaults: A4 formal document.
    assert.equal(data.sales_invoice.paperSize, "a4");
    assert.equal(data.sales_invoice.visibility.invoiceNumber, true);
    assert.equal(data.sales_invoice.showSignature, true);
    assert.ok(data.sales_invoice.text.title === "INVOICE");
  });

  it("PUT updates the receipt config and GET reflects it", async () => {
    const res = await api(owner, "PUT", "/api/document-settings/sales_receipt", {
      config: {
        paperWidth: "58mm",
        visibility: { businessEmail: true, qrCode: true, vat: false },
        layout: { fontSize: 11, itemTableStyle: "compact" },
        text: { footerMessage: "No returns without receipt.", title: "মেমো" },
        print: { autoPrintOnSale: true, copies: 2 },
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);

    const get = await api(owner, "GET", "/api/document-settings");
    const receipt = get.body.data.sales_receipt;
    assert.equal(receipt.paperWidth, "58mm");
    assert.equal(receipt.visibility.businessEmail, true);
    assert.equal(receipt.visibility.qrCode, true);
    assert.equal(receipt.visibility.vat, false);
    // Untouched flags keep their defaults (partial patch semantics).
    assert.equal(receipt.visibility.grandTotal, true);
    assert.equal(receipt.layout.fontSize, 11);
    assert.equal(receipt.layout.itemTableStyle, "compact");
    assert.equal(receipt.layout.logoWidthPx, 96);
    assert.equal(receipt.text.footerMessage, "No returns without receipt.");
    assert.equal(receipt.text.title, "মেমো");
    assert.equal(receipt.print.autoPrintOnSale, true);
    assert.equal(receipt.print.copies, 2);
  });

  it("PUT updates the invoice config independently of the receipt", async () => {
    const res = await api(owner, "PUT", "/api/document-settings/sales_invoice", {
      config: { paperSize: "a5", text: { terms: "Pay within 7 days." } },
    });
    assert.equal(res.status, 200);

    const get = await api(owner, "GET", "/api/document-settings");
    assert.equal(get.body.data.sales_invoice.paperSize, "a5");
    assert.equal(get.body.data.sales_invoice.text.terms, "Pay within 7 days.");
    // Receipt config untouched by the invoice PUT.
    assert.equal(get.body.data.sales_receipt.paperWidth, "58mm");
  });

  it("rejects invalid configs with 400 and stores nothing", async () => {
    const badPaper = await api(
      owner,
      "PUT",
      "/api/document-settings/sales_receipt",
      { config: { paperWidth: "999mm" } },
    );
    assert.equal(badPaper.status, 400);

    const badFontSize = await api(
      owner,
      "PUT",
      "/api/document-settings/sales_receipt",
      { config: { layout: { fontSize: 99 } } },
    );
    assert.equal(badFontSize.status, 400);

    const badCopies = await api(
      owner,
      "PUT",
      "/api/document-settings/sales_receipt",
      { config: { print: { copies: 50 } } },
    );
    assert.equal(badCopies.status, 400);

    const badInvoice = await api(
      owner,
      "PUT",
      "/api/document-settings/sales_invoice",
      { config: { paperSize: "letter" } },
    );
    assert.equal(badInvoice.status, 400);

    const stillThere = await api(owner, "GET", "/api/document-settings");
    assert.equal(stillThere.body.data.sales_receipt.paperWidth, "58mm");
    assert.equal(stillThere.body.data.sales_invoice.paperSize, "a5");
  });

  it("rejects unknown document types", async () => {
    const res = await api(owner, "PUT", "/api/document-settings/purchase_order", {
      config: {},
    });
    assert.equal(res.status, 400);
  });

  it("enforces business isolation on both read and write", async () => {
    // `other` must not see owner's customized configs.
    const foreignGet = await api(other, "GET", "/api/document-settings");
    assert.equal(foreignGet.status, 200);
    assert.equal(foreignGet.body.data.sales_receipt.paperWidth, "80mm");
    assert.equal(foreignGet.body.data.sales_receipt.print.autoPrintOnSale, false);

    // Writing from another business context cannot touch owner's row.
    const crossWrite = await api(
      other,
      "PUT",
      "/api/document-settings/sales_receipt",
      { config: { paperWidth: "58mm" } },
    );
    assert.equal(crossWrite.status, 200);
    const ownerGet = await api(owner, "GET", "/api/document-settings");
    assert.equal(ownerGet.body.data.sales_receipt.paperWidth, "58mm");
    assert.equal(other.businessId !== owner.businessId, true);
    // ...and other's own row is the one that changed.
    const otherGet = await api(other, "GET", "/api/document-settings");
    assert.equal(otherGet.body.data.sales_receipt.paperWidth, "58mm");
  });

  it("cashier can read settings but cannot edit them", async () => {
    const read = await api(cashier, "GET", "/api/document-settings");
    assert.equal(read.status, 200);
    assert.equal(read.body.success, true);

    const write = await api(cashier, "PUT", "/api/document-settings/sales_receipt", {
      config: { paperWidth: "80mm" },
    });
    assert.equal(write.status, 403);

    const logo = await api(cashier, "PUT", `/api/businesses/${owner.businessId}/logo`, {
      dataUrl: `data:image/png;base64,${PNG_1PX}`,
    });
    assert.equal(logo.status, 403);
  });

  it("manager can edit settings", async () => {
    const res = await api(manager, "PUT", "/api/document-settings/sales_receipt", {
      config: { text: { thankYouMessage: "Dhonnobad!" } },
    });
    assert.equal(res.status, 200);
    const get = await api(manager, "GET", "/api/document-settings");
    assert.equal(get.body.data.sales_receipt.text.thankYouMessage, "Dhonnobad!");
  });

  it("unauthenticated requests are rejected", async () => {
    const res = await fetch(`${baseUrl}/api/document-settings`);
    assert.equal(res.status, 401);
  });

  it("uploads, replaces and removes the business logo with validation", async () => {
    // Valid PNG.
    const put = await api(owner, "PUT", `/api/businesses/${owner.businessId}/logo`, {
      dataUrl: `data:image/png;base64,${PNG_1PX}`,
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.ok(String(put.body.logoUrl).startsWith("data:image/png;base64,"));

    // Reflected in the business detail.
    const detail = await api(owner, "GET", `/api/businesses/${owner.businessId}`);
    assert.equal(detail.status, 200);
    assert.ok(
      String((detail.body as { business: { logoUrl: string } }).business.logoUrl).startsWith(
        "data:image/png;base64,",
      ),
    );

    // Reject: not a data URL.
    const badScheme = await api(owner, "PUT", `/api/businesses/${owner.businessId}/logo`, {
      dataUrl: "https://example.com/logo.png",
    });
    assert.equal(badScheme.status, 400);

    // Reject: magic bytes contradict the declared type.
    const badMagic = await api(owner, "PUT", `/api/businesses/${owner.businessId}/logo`, {
      dataUrl: `data:image/jpeg;base64,${PNG_1PX}`,
    });
    assert.equal(badMagic.status, 400);

    // Reject: oversized. A >300 KB logo base64 also exceeds the JSON body
    // limit (~100 KB), so express.json rejects it with 413 before the
    // service-level 300 KB check runs.
    const big = Buffer.alloc(301 * 1024, 0x41).toString("base64");
    const tooBig = await api(owner, "PUT", `/api/businesses/${owner.businessId}/logo`, {
      dataUrl: `data:image/png;base64,${big}`,
    });
    assert.equal(tooBig.status, 413);

    // Removal clears it.
    const del = await api(owner, "DELETE", `/api/businesses/${owner.businessId}/logo`);
    assert.equal(del.status, 200);
    const after = await api(owner, "GET", `/api/businesses/${owner.businessId}`);
    assert.equal(
      (after.body as { business: { logoUrl: string | null } }).business.logoUrl,
      null,
    );
  });

  it("saves business document profile fields (website, vatBin, tagline)", async () => {
    const res = await api(owner, "PUT", `/api/businesses/${owner.businessId}`, {
      website: "https://shop.example.com",
      vatBin: "BIN-1234567",
      tagline: "Fresh grocery, every day",
    });
    assert.equal(res.status, 200);
    const biz = (res.body as { business: Record<string, unknown> }).business;
    assert.equal(biz.website, "https://shop.example.com");
    assert.equal(biz.vatBin, "BIN-1234567");
    assert.equal(biz.tagline, "Fresh grocery, every day");

    const badUrl = await api(owner, "PUT", `/api/businesses/${owner.businessId}`, {
      website: "not-a-url",
    });
    assert.equal(badUrl.status, 400);
  });

  it("sale receipt payload embeds branding + templates with untouched financials", async () => {
    // Minimal sellable catalog: unit + non-tracked product in stock.
    const unitRes = await api(owner, "POST", "/api/product/unit", {
      unitName: "Piece",
      abbreviation: "Pcs",
    });
    assert.equal(unitRes.status, 201);
    const unitId = (unitRes.body as { data: { value: number } }).data.value;

    const prodRes = await api(owner, "POST", "/api/product", {
      name: `DocSet Product ${Date.now()}`,
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
          sku: "DOCSET-1",
          barcode: null,
          sellingPrice: 120,
          alertQuantity: 0,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: "",
          purchasePrice: 80,
          quantity: 10,
          expiryDate: null,
        },
      ],
    });
    assert.equal(prodRes.status, 201, JSON.stringify(prodRes.body));
    const listRes = await api(owner, "GET", "/api/products");
    assert.equal(listRes.status, 200);
    const products = listRes.body as {
      id: number;
      name: string;
      variants?: { id: number }[];
    }[];
    const created = products.find((p) => String(p.name).startsWith("DocSet Product"))!;
    const variantId = created.variants![0]!.id;

    // Brand the business, customize the receipt, then sell.
    await api(owner, "PUT", `/api/businesses/${owner.businessId}/logo`, {
      dataUrl: `data:image/png;base64,${PNG_1PX}`,
    });
    await api(owner, "PUT", "/api/document-settings/sales_receipt", {
      config: { text: { title: "বিক্রয় রশিদ" } },
    });

    const saleRes = await api(owner, "POST", "/api/sales", {
      saleDate: new Date().toISOString(),
      customerId: null,
      payments: [{ method: "cash", amount: 240, tendered: 250 }],
      discount: null,
      vatPercent: 0,
      items: [{ variantId, quantity: 2, unitPrice: 120, discount: null }],
    });
    assert.equal(saleRes.status, 201, JSON.stringify(saleRes.body));
    const saleId = (saleRes.body as { data: { sale: { id: number } } }).data.sale.id;

    // The createSale response already carries the receipt.
    const saleReceipt = (saleRes.body as { data: { receipt: any } }).data.receipt;
    assert.equal(saleReceipt.business.name.startsWith("DocSet Biz"), true);
    assert.ok(
      String(saleReceipt.business.logoUrl).startsWith("data:image/png;base64,"),
    );
    assert.equal(saleReceipt.documentSettings.sales_receipt.text.title, "বিক্রয় রশিদ");
    assert.equal(saleReceipt.finalTotal, 240);
    assert.equal(saleReceipt.paidAmount, 240);
    assert.equal(saleReceipt.change, 10);
    assert.equal(saleReceipt.items[0]?.unitName, "Pcs");

    // Reprint path: GET /api/sales/:id/receipt — same embedding, same values.
    const receiptRes = await api(owner, "GET", `/api/sales/${saleId}/receipt`);
    assert.equal(receiptRes.status, 200);
    const receipt = receiptRes.body as {
      business: { name: string; vatBin: string | null };
      documentSettings: { sales_receipt: { text: { title: string } } };
      finalTotal: number;
      subtotal: number;
      vat: number;
      items: { unitPrice: number; quantity: number; unitName: string | null }[];
    };
    assert.equal(receipt.business.name.startsWith("DocSet Biz"), true);
    assert.equal(receipt.documentSettings.sales_receipt.text.title, "বিক্রয় রশিদ");
    assert.equal(receipt.finalTotal, 240);
    assert.equal(receipt.subtotal, 240);
    assert.equal(receipt.vat, 0);
    assert.equal(receipt.items[0]?.unitPrice, 120);
    assert.equal(receipt.items[0]?.quantity, 2);
    assert.equal(receipt.items[0]?.unitName, "Pcs");

    // Historical accuracy: changing the template + branding afterwards must
    // not alter any financial value of the existing sale.
    await api(owner, "DELETE", `/api/businesses/${owner.businessId}/logo`);
    await api(owner, "PUT", "/api/document-settings/sales_receipt", {
      config: { text: { title: "CHANGED" } },
    });
    const after = await api(owner, "GET", `/api/sales/${saleId}/receipt`);
    const afterReceipt = after.body as typeof receipt;
    assert.equal(afterReceipt.finalTotal, 240);
    assert.equal(afterReceipt.subtotal, 240);
    assert.equal(afterReceipt.items[0]?.unitPrice, 120);
    assert.equal(afterReceipt.items[0]?.quantity, 2);
    assert.equal(afterReceipt.documentSettings.sales_receipt.text.title, "CHANGED");
  });
});
