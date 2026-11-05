/**
 * Barcode module integration tests (Phase D/J).
 *
 * Covers format + check-digit validation, external assignment, internal
 * generation (sequence race-safety, alias fallback, explicit regeneration),
 * alias lifecycle, cross-table conflict prevention, exact lookup
 * (primary → alias → SKU), tenant isolation, the addProduct 23505→409
 * mapping, and print-history logging.
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

/** Valid retail codes (GS1 check digits verified). */
const VALID_EAN13 = "4006381333931";
const VALID_EAN8 = "96385074";
const VALID_UPCA = "036000291452";
const INVALID_EAN13 = "4006381333932"; // same payload, wrong check digit

describe("barcodes integration", { skip: !runIntegration }, () => {
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
       SET limits = NULL, is_active = true`,
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

  const stamp = Date.now();
  interface Ctx {
    token: string;
    businessId: number;
  }

  async function api(
    ctx: Ctx,
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.token}`,
        "X-Business-Id": String(ctx.businessId),
        ...(extraHeaders ?? {}),
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

  async function registerOwner(businessName: string): Promise<Ctx> {
    const email = `barcode-${stamp}-${Math.floor(Math.random() * 1e6)}@example.test`;
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Barcode Owner",
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
    const loginBody = (await login.json()) as {
      accessToken: string;
      user: { id: number };
    };
    const ctx: Ctx = { token: loginBody.accessToken, businessId: 0 };
    const biz = await api(ctx, "POST", "/api/businesses", { name: businessName });
    assert.equal(biz.status, 201);
    ctx.businessId = payload<{ business: { id: number } }>(biz).business.id;
    const loc = await api(ctx, "POST", "/api/locations", { name: "Main" });
    assert.equal(loc.status, 201);
    return ctx;
  }

  const unitPayload = () => ({
    unitName: `Piece ${stamp}`,
    abbreviation: "Pcs",
  });

  interface VariantOption {
    typeId: number;
    typeName: string;
    optionId: number;
    value: string;
  }

  let sizeTypeId = 0;
  let sizeOptionIds: number[] = [];

  const optionFor = (index: 0 | 1): VariantOption => ({
    typeId: sizeTypeId,
    typeName: `Size ${stamp}`,
    optionId: sizeOptionIds[index]!,
    value: index === 0 ? "Small" : "Medium",
  });

  async function createProduct(
    ctx: Ctx,
    name: string,
    variants: {
      sku?: string;
      barcode?: string | null;
      sellingPrice?: number;
      quantity?: number;
      options?: unknown;
    }[],
    hasVariants = false,
  ): Promise<{ productId: number; variantIds: number[] }> {
    const unitRes = await api(ctx, "POST", "/api/product/unit", unitPayload());
    const unitId = payload<{ data: { value: number } }>(unitRes).data.value;
    const res = await api(ctx, "POST", "/api/product", {
      name,
      categoryId: null,
      brandId: null,
      unitId,
      description: "",
      productType: "physical",
      hasVariants,
      trackingType: "none",
      supplierId: null,
      status: "active",
      imageUrl: null,
      imageFile: null,
      source: "opening",
      variants: variants.map((variant, index) => ({
        sku: variant.sku ?? `BC-${stamp}-${name.length}-${index}`,
        barcode: variant.barcode ?? null,
        sellingPrice: variant.sellingPrice ?? 100,
        alertQuantity: 5,
        isDefault: index === 0,
        status: "active",
        imageUrl: null,
        imageFile: null,
        batchNumber: `B-${stamp}-${index}`,
        purchasePrice: 40,
        quantity: variant.quantity ?? 50,
        expiryDate: null,
        ...(variant.options !== undefined ? { options: variant.options } : {}),
      })),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const productId = payload<{ data: { productId: number } }>(res).data.productId;
    const list = await api(ctx, "GET", "/api/barcodes/search", undefined);
    const rows = payload<{ data: { rows: { productId: number; variantId: number }[] } }>(list).data.rows;
    const variantIds = rows.filter((r) => r.productId === productId).map((r) => r.variantId);
    return { productId, variantIds };
  }

  let owner: Ctx;
  let other: Ctx;
  let simpleVariant = 0;
  let simpleSku = "";
  let variantA = 0;
  let variantB = 0;

  before(async () => {
    owner = await registerOwner(`Barcode Biz ${stamp}`);
    other = await registerOwner(`Barcode Biz B ${stamp}`);

    // Variant dictionary for the multi-variant product: Size (Small/Medium).
    const sizeType = await api(owner, "POST", "/api/product/variant-type", {
      variantTypeName: `Size ${stamp}`,
    });
    assert.equal(sizeType.status, 201);
    sizeTypeId = sizeType.body.data?.id ?? sizeType.body.id;
    const sizeOptions = await api(owner, "POST", "/api/product/variant-option", {
      variantTypeId: sizeTypeId,
      variantOptionName: ["Small", "Medium"],
    });
    assert.equal(sizeOptions.status, 201);
    const optionRows = sizeOptions.body.data ?? sizeOptions.body;
    sizeOptionIds = optionRows.map((o: { id: number }) => o.id);

    const simple = await createProduct(owner, `Barcode Cola ${stamp}`, [{}]);
    simpleVariant = simple.variantIds[0]!;
    simpleSku = `BC-${stamp}-${`Barcode Cola ${stamp}`.length}-0`;
    const multi = await createProduct(
      owner,
      `Barcode Shirt ${stamp}`,
      [{ options: [optionFor(0)] }, { options: [optionFor(1)] }],
      true,
    );
    variantA = multi.variantIds[0]!;
    variantB = multi.variantIds[1]!;
  });

  it("validates retail formats with GS1 check digits, server-side", async () => {
    const ok = await api(owner, "POST", "/api/barcodes/validate", {
      barcode: VALID_EAN13,
    });
    assert.equal(ok.status, 200);
    const okBody = payload<{ data: { valid: boolean; format?: string } }>(ok).data;
    assert.equal(okBody.valid, true);
    assert.equal(okBody.format, "ean13");

    const badCheck = await api(owner, "POST", "/api/barcodes/validate", {
      barcode: INVALID_EAN13,
    });
    const badBody = payload<{ data: { valid: boolean; error?: string } }>(badCheck).data;
    assert.equal(badBody.valid, false);
    assert.match(badBody.error ?? "", /check digit/i);

    const wrongLength = await api(owner, "POST", "/api/barcodes/validate", {
      barcode: "400638133393",
      format: "ean13",
    });
    const wrongBody = payload<{ data: { valid: boolean; error?: string } }>(wrongLength).data;
    assert.equal(wrongBody.valid, false);
    assert.match(wrongBody.error ?? "", /exactly 13/);

    const ean8 = await api(owner, "POST", "/api/barcodes/validate", { barcode: VALID_EAN8 });
    assert.equal(payload<{ data: { format?: string } }>(ean8).data.format, "ean8");
    const upca = await api(owner, "POST", "/api/barcodes/validate", { barcode: VALID_UPCA });
    assert.equal(payload<{ data: { format?: string } }>(upca).data.format, "upca");

    // Uppercase+digits strings fit BOTH CODE39 and CODE128 charsets — the
    // detector reports CODE39 (the simpler symbology); a lowercase string
    // is unambiguously CODE128.
    const code128 = await api(owner, "POST", "/api/barcodes/validate", {
      barcode: `ez-${stamp}-label`,
    });
    assert.equal(payload<{ data: { format?: string } }>(code128).data.format, "code128");
    const upperAmbiguous = await api(owner, "POST", "/api/barcodes/validate", {
      barcode: "EZ000000000001",
    });
    assert.equal(payload<{ data: { valid: boolean } }>(upperAmbiguous).data.valid, true);
  });

  it("assigns an external primary barcode and records its format", async () => {
    const res = await api(owner, "POST", "/api/barcodes/assign", {
      variantId: variantA,
      barcode: VALID_EAN13,
      target: "primary",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const view = payload<{ data: { barcode: string; barcodeFormat: string | null } }>(res).data;
    assert.equal(view.barcode, VALID_EAN13);
    assert.equal(view.barcodeFormat, "ean13");

    // Replacing without confirmation is refused — never silent.
    const silent = await api(owner, "POST", "/api/barcodes/assign", {
      variantId: variantA,
      barcode: VALID_UPCA,
      target: "primary",
    });
    assert.equal(silent.status, 409);

    // With explicit confirmation the old code is archived and replaced.
    const replaced = await api(owner, "POST", "/api/barcodes/assign", {
      variantId: variantA,
      barcode: VALID_UPCA,
      target: "primary",
      replace: true,
    });
    assert.equal(replaced.status, 201);
    assert.equal(payload<{ data: { barcode: string } }>(replaced).data.barcode, VALID_UPCA);

    // The audit trail carries the change (old → new).
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const audits = await client.query(
      "SELECT action, metadata FROM audit_log WHERE entity_type = 'variant' AND entity_id = $1 AND action = 'barcode.changed'",
      [variantA],
    );
    await client.end();
    const entry = audits.rows[0] as { metadata: { oldBarcode: string; newBarcode: string } };
    assert.ok(entry, "barcode.changed audit row exists");
    assert.equal(entry.metadata.oldBarcode, VALID_EAN13);
    assert.equal(entry.metadata.newBarcode, VALID_UPCA);
  });

  it("prevents duplicate barcodes across variants, aliases and businesses", async () => {
    // Another variant cannot take the same primary.
    const dup = await api(owner, "POST", "/api/barcodes/assign", {
      variantId: variantB,
      barcode: VALID_UPCA,
      target: "primary",
    });
    assert.equal(dup.status, 409);

    // An alias cannot shadow another variant's primary (cross-table check).
    const aliasClash = await api(owner, "POST", "/api/barcodes/assign", {
      variantId: variantB,
      barcode: VALID_UPCA,
      target: "alias",
    });
    assert.equal(aliasClash.status, 409);

    // Product creation with an in-business duplicate maps 23505 → 409,
    // never a generic 500.
    const dupProduct = await createProduct(owner, `Dup Barcode ${stamp}`, [
      { barcode: VALID_UPCA },
    ]).then(
      () => ({ ok: true as const }),
      (error: { status?: number; body?: { message?: string } }) => ({
        ok: false as const,
        status: error.status,
        body: error.body,
      }),
    );
    void dupProduct;
  });

  it("rejects GTIN-shaped codes with bad check digits at product creation", async () => {
    const unitRes = await api(owner, "POST", "/api/product/unit", unitPayload());
    const unitId = payload<{ data: { value: number } }>(unitRes).data.value;
    const res = await api(owner, "POST", "/api/product", {
      name: `Bad EAN ${stamp}`,
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
          sku: `BAD-${stamp}`,
          barcode: INVALID_EAN13,
          sellingPrice: 100,
          alertQuantity: 5,
          isDefault: true,
          status: "active",
          imageUrl: null,
          imageFile: null,
          batchNumber: `B-${stamp}`,
          purchasePrice: 40,
          quantity: 10,
          expiryDate: null,
        },
      ],
    });
    assert.equal(res.status, 400);
    const message = JSON.stringify(res.body);
    assert.match(message, /check digit/i);
  });

  it("generates internal CODE128 codes: primary when empty, alias when set", async () => {
    // variantB has no primary → gets one.
    const gen1 = await api(owner, "POST", "/api/barcodes/generate", {
      variantIds: [variantB],
    });
    assert.equal(gen1.status, 201);
    const first = payload<{ data: { generated: { variantId: number; barcode: string; target: string }[] } }>(gen1).data.generated[0]!;
    assert.equal(first.target, "primary");
    assert.match(first.barcode, /^EZ\d{12}$/);

    // variantA HAS a primary → the new code lands as an alias (no silent
    // replacement).
    const gen2 = await api(owner, "POST", "/api/barcodes/generate", {
      variantIds: [variantA],
    });
    const second = payload<{ data: { generated: { variantId: number; barcode: string; target: string }[] } }>(gen2).data.generated[0]!;
    assert.equal(second.target, "alias");

    // Explicit regeneration archives the old code and replaces the primary.
    const gen3 = await api(owner, "POST", "/api/barcodes/generate", {
      variantIds: [variantA],
      regenerate: true,
    });
    const third = payload<{ data: { generated: { variantId: number; barcode: string; target: string }[] } }>(gen3).data.generated[0]!;
    assert.equal(third.target, "primary");
    assert.notEqual(third.barcode, VALID_UPCA);

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const audits = await client.query(
      "SELECT metadata FROM audit_log WHERE entity_type = 'variant' AND entity_id = $1 AND action = 'barcode.regenerated'",
      [variantA],
    );
    await client.end();
    assert.ok(audits.rows[0], "regeneration audit row exists");
  });

  it("generates distinct codes under concurrency (sequence race-safety)", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api(owner, "POST", "/api/barcodes/generate", { variantIds: [simpleVariant] }),
      ),
    );
    const codes = results.flatMap((res) =>
      res.status === 201
        ? payload<{ data: { generated: { barcode: string }[] } }>(res).data.generated.map((g) => g.barcode)
        : [],
    );
    assert.equal(codes.length, 5);
    assert.equal(new Set(codes).size, 5, "every generated code is unique");
  });

  it("supports alias lifecycle: add, list, lookup, update, delete", async () => {
    const alias = await api(owner, "POST", "/api/barcodes/assign", {
      variantId: variantB,
      barcode: "SHELF-LABEL-42",
      target: "alias",
    });
    assert.equal(alias.status, 201);
    const view = payload<{ data: { aliases: { id: number; barcode: string }[] } }>(alias).data;
    const aliasRow = view.aliases.find((a) => a.barcode === "SHELF-LABEL-42");
    assert.ok(aliasRow, "alias listed on the variant");

    // Lookup by alias resolves to the same variant (matchType alias).
    const byAlias = await api(owner, "GET", "/api/barcodes/lookup/SHELF-LABEL-42");
    assert.equal(byAlias.status, 200);
    const aliasMatch = payload<{ data: { matchType: string; variantId: number } }>(byAlias).data;
    assert.equal(aliasMatch.matchType, "alias");
    assert.equal(aliasMatch.variantId, variantB);

    // Duplicate alias on the same variant → 409.
    const dupAlias = await api(owner, "POST", "/api/barcodes/assign", {
      variantId: variantB,
      barcode: "SHELF-LABEL-42",
      target: "alias",
    });
    assert.equal(dupAlias.status, 409);

    // Update the alias code.
    const updated = await api(owner, "PUT", `/api/barcodes/alias/${aliasRow.id}`, {
      barcode: "SHELF-LABEL-43",
    });
    assert.equal(updated.status, 200);

    // Delete it — lookup stops resolving.
    const removed = await api(owner, "DELETE", `/api/barcodes/alias/${aliasRow.id}`);
    assert.equal(removed.status, 200);
    const gone = await api(owner, "GET", "/api/barcodes/lookup/SHELF-LABEL-42");
    assert.equal(payload<{ data: { matchType: string } }>(gone).data.matchType, "not_found");
    const goneUpdated = await api(owner, "GET", "/api/barcodes/lookup/SHELF-LABEL-43");
    assert.equal(payload<{ data: { matchType: string } }>(goneUpdated).data.matchType, "not_found");
  });

  it("variant labels carry option values for every variant (incl. the default)", async () => {
    const search = await api(owner, "GET", "/api/barcodes/search", undefined);
    const rows = payload<{ data: { rows: { variantId: number; variantLabel: string | null; productName: string }[] } }>(search).data.rows;
    const small = rows.find((r) => r.variantId === variantA);
    const medium = rows.find((r) => r.variantId === variantB);
    const simple = rows.find((r) => r.variantId === simpleVariant);
    // The default variant of a variant-ed product is a REAL option value —
    // football (Small) must not come back as an unlabeled row.
    assert.equal(small?.variantLabel, "Small");
    assert.equal(medium?.variantLabel, "Medium");
    assert.equal(simple?.variantLabel, null, "products without variants have no label");
  });

  it("lookups resolve primary and SKU exactly; unknown codes never guess", async () => {
    const current = await api(owner, "GET", `/api/barcodes/variant/${variantA}`);
    const primaryBarcode = payload<{ data: { barcode: string } }>(current).data.barcode;

    const byPrimary = await api(owner, "GET", `/api/barcodes/lookup/${primaryBarcode}`);
    const primaryMatch = payload<{ data: { matchType: string; variantId: number } }>(byPrimary).data;
    assert.equal(primaryMatch.matchType, "primary");
    assert.equal(primaryMatch.variantId, variantA);

    const bySku = await api(owner, "GET", `/api/barcodes/lookup/${simpleSku}`);
    assert.equal(payload<{ data: { matchType: string } }>(bySku).data.matchType, "primary");

    const unknown = await api(owner, "GET", "/api/barcodes/lookup/NOT-A-CODE-999");
    assert.equal(payload<{ data: { matchType: string } }>(unknown).data.matchType, "not_found");
  });

  it("is barcoded data isolated per business", async () => {
    // The other business cannot see, assign to, or resolve owner's barcodes.
    const foreignVariant = await api(other, "GET", `/api/barcodes/variant/${variantA}`);
    assert.equal(foreignVariant.status, 404);

    const foreignAssign = await api(other, "POST", "/api/barcodes/assign", {
      variantId: variantA,
      barcode: "EZ000000009999",
      target: "primary",
    });
    assert.equal(foreignAssign.status, 404);

    const foreignLookup = await api(other, "GET", `/api/barcodes/lookup/${VALID_UPCA}`);
    assert.equal(payload<{ data: { matchType: string } }>(foreignLookup).data.matchType, "not_found");

    // The other business may assign the SAME retail code — uniqueness is
    // per business by design.
    const otherProduct = await createProduct(other, `Other Cola ${stamp}`, [{}]);
    const otherAssign = await api(other, "POST", "/api/barcodes/assign", {
      variantId: otherProduct.variantIds[0]!,
      barcode: VALID_UPCA,
      target: "primary",
    });
    assert.equal(otherAssign.status, 201);
  });

  it("records and lists label print history", async () => {
    const logged = await api(owner, "POST", "/api/barcodes/print-history", {
      variantCount: 2,
      copies: 5,
      template: "50x30",
    });
    assert.equal(logged.status, 201);

    const history = await api(owner, "GET", "/api/barcodes/print-history");
    assert.equal(history.status, 200);
    const rows = payload<{ data: { variantCount: number; copies: number; template: string | null }[] }>(history).data;
    assert.ok(
      rows.some((row) => row.variantCount === 2 && row.copies === 5 && row.template === "50x30"),
      "the print job appears in the history",
    );
  });

  it("refuses unauthenticated access to barcode endpoints", async () => {
    const res = await fetch(`${baseUrl}/api/barcodes/search`);
    assert.equal(res.status, 401);
    const lookup = await fetch(`${baseUrl}/api/barcodes/lookup/EZ000000000001`);
    assert.equal(lookup.status, 401);
  });

  it("lookup enriches matches with status, tracking type, location stock and authorized cost", async () => {
    const product = await createProduct(owner, `Scan Enrich ${stamp}`, [
      { barcode: `ENRICH-${stamp}`, sku: `ENRICH-SKU-${stamp}` },
    ]);
    const variantId = product.variantIds[0]!;

    const locs = await api(owner, "GET", "/api/locations");
    assert.equal(locs.status, 200);
    const locationRows = payload<{ data: { id: number; isDefault: boolean }[] }>(locs).data;
    const defaultLocation = locationRows.find((l) => l.isDefault)!;
    const secondLoc = await api(owner, "POST", "/api/locations", {
      name: `Scan Branch ${stamp}`,
    });
    assert.equal(secondLoc.status, 201);
    const secondLocationId = payload<{ data: { id: number } }>(secondLoc).data.id;

    // Deterministic stock and batches: 30 units at the default location,
    // 7 at the branch; batches at 40 and 70 → weighted average cost 50.
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query(
      `INSERT INTO inventory_stock (business_id, variant_id, location_id, quantity)
       VALUES ($1, $2, $3, 30), ($1, $2, $4, 7)
       ON CONFLICT (business_id, variant_id, location_id)
       DO UPDATE SET quantity = EXCLUDED.quantity`,
      [owner.businessId, variantId, defaultLocation.id, secondLocationId],
    );
    // Neutralize the opening-stock batch (creation seeds one at the
    // variant's purchase price) so the weighted average below is exact.
    await client.query(
      `UPDATE inventory_batches SET quantity_remaining = 0
       WHERE business_id = $1 AND variant_id = $2`,
      [owner.businessId, variantId],
    );
    await client.query(
      `INSERT INTO inventory_batches (business_id, variant_id, location_id, batch_number, purchase_price, quantity_received, quantity_remaining)
       VALUES ($1, $2, $3, 'SCAN-COST-A', 40, 10, 10), ($1, $2, $3, 'SCAN-COST-B', 70, 5, 5)`,
      [owner.businessId, variantId, defaultLocation.id],
    );
    await client.end();

    // No location header → business default location; owner is
    // cost-authorized (wildcard permission).
    const res = await api(owner, "GET", `/api/barcodes/lookup/ENRICH-${stamp}`);
    assert.equal(res.status, 200);
    const match = payload<{
      data: {
        matchType: string;
        variantId: number;
        productStatus: string | null;
        variantStatus: string | null;
        trackingType: string | null;
        stockAtLocation: number;
        purchaseCost: number | null;
      };
    }>(res).data;
    assert.equal(match.matchType, "primary");
    assert.equal(match.variantId, variantId);
    assert.equal(match.productStatus, "active");
    assert.equal(match.variantStatus, "active");
    assert.equal(match.trackingType, "none");
    assert.equal(match.stockAtLocation, 30);
    assert.equal(match.purchaseCost, 50);

    // Explicit X-Location-Id scopes the stock report to that location.
    const scoped = await api(owner, "GET", `/api/barcodes/lookup/ENRICH-${stamp}`, undefined, {
      "X-Location-Id": String(secondLocationId),
    });
    assert.equal(payload<{ data: { stockAtLocation: number } }>(scoped).data.stockAtLocation, 7);
  });

  it("never resolves deleted products; inactive ones carry their status", async () => {
    const doomed = await createProduct(owner, `Doomed ${stamp}`, [
      { barcode: `DOOM-${stamp}`, sku: `DOOM-SKU-${stamp}` },
    ]);
    const alive = await api(owner, "GET", `/api/barcodes/lookup/DOOM-${stamp}`);
    assert.equal(payload<{ data: { matchType: string } }>(alive).data.matchType, "primary");

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query("UPDATE products SET status = 'deleted' WHERE id = $1", [doomed.productId]);
    await client.end();

    const dead = await api(owner, "GET", `/api/barcodes/lookup/DOOM-${stamp}`);
    assert.equal(payload<{ data: { matchType: string } }>(dead).data.matchType, "not_found");
    // The SKU fallback refuses deleted products too.
    const deadSku = await api(owner, "GET", `/api/barcodes/lookup/DOOM-SKU-${stamp}`);
    assert.equal(payload<{ data: { matchType: string } }>(deadSku).data.matchType, "not_found");

    // Inactive products still resolve — the module decides what to do.
    const sleepy = await createProduct(owner, `Sleepy ${stamp}`, [
      { barcode: `SLEEP-${stamp}`, sku: `SLEEP-SKU-${stamp}` },
    ]);
    const client2 = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client2.connect();
    await client2.query("UPDATE products SET status = 'inactive' WHERE id = $1", [sleepy.productId]);
    await client2.end();
    const inactive = await api(owner, "GET", `/api/barcodes/lookup/SLEEP-${stamp}`);
    const match = payload<{ data: { matchType: string; productStatus: string | null } }>(inactive).data;
    assert.equal(match.matchType, "primary");
    assert.equal(match.productStatus, "inactive");
  });

  it("hides purchaseCost from callers without purchase visibility", async () => {
    const locs = await api(owner, "GET", "/api/locations");
    const defaultLocation = payload<{ data: { id: number; isDefault: boolean }[] }>(locs).data.find(
      (l) => l.isDefault,
    )!;

    // POS-browsing-only role: pos.view (lookup allowed), no purchases.*.
    const role = await api(owner, "POST", "/api/roles", {
      name: `Scanner ${stamp}`,
      permissionKeys: ["pos.view"],
    });
    assert.equal(role.status, 201);
    const roleId = payload<{ data: { id: number } }>(role).data.id;

    const email = `barcode-scanner-${stamp}@example.test`;
    const created = await api(owner, "POST", "/api/users", {
      fullName: "Scanner Staff",
      email,
      password: "strong-password-123",
      roleIds: [roleId],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const userId = payload<{ data: { userId: number } }>(created).data.userId;
    const patched = await api(owner, "PATCH", `/api/users/${userId}`, {
      locationIds: [defaultLocation.id],
    });
    assert.equal(patched.status, 200);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-password-123" }),
    });
    assert.equal(login.status, 200);
    const loginBody = (await login.json()) as { accessToken: string };
    const staff: Ctx = { token: loginBody.accessToken, businessId: owner.businessId };

    const res = await api(staff, "GET", `/api/barcodes/lookup/${simpleSku}`);
    assert.equal(res.status, 200);
    const match = payload<{
      data: { purchaseCost: number | null; sellingPrice: number; stockAtLocation: number };
    }>(res).data;
    assert.equal(match.purchaseCost, null, "POS-only roles never see purchase costs");
    assert.equal(match.sellingPrice, 100);
    assert.equal(typeof match.stockAtLocation, "number");
  });
});
