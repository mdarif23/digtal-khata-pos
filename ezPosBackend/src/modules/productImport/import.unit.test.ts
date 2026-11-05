import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertUploadAcceptable,
  FileParseError,
  generateTemplate,
  parseCsvUpload,
} from "./fileParser.service.js";
import {
  autoMapHeaders,
  groupRows,
  normalizeRow,
  type NormalizedRow,
} from "./import.service.js";

function bom(text: string): Buffer {
  return Buffer.from("\uFEFF" + text, "utf8");
}

describe("CSV parser (Phase D)", () => {
  it("parses quoted cells, embedded newlines, BOM and CRLF", () => {
    const csv = bom('product_name,description\r\n"Football, Size 5","line1\nline2"\r\n"Say ""hi""",x\r\n');
    const sheet = parseCsvUpload(csv, 1);
    assert.equal(sheet.headers[0], "product_name");
    assert.equal(sheet.rows[0]!["product_name"], "Football, Size 5");
    assert.equal(sheet.rows[0]!["description"], "line1\nline2");
    assert.equal(sheet.rows[1]!["description"], "x");
    assert.deepEqual(sheet.rowNumbers, [2, 3]);
  });

  it("skips empty rows but preserves original row numbers", () => {
    const csv = bom("product_name,selling_price\n\nFootball,500\n\nBottle,120\n");
    const sheet = parseCsvUpload(csv, 1);
    assert.deepEqual(sheet.rowNumbers, [3, 5]);
  });

  it("detects duplicate headers", () => {
    const sheet = parseCsvUpload(bom("sku,sku,name\nA,B,C\n"), 1);
    assert.deepEqual(sheet.duplicateHeaders, ["sku"]);
  });

  it("rejects binary and macro signatures", () => {
    assert.throws(
      () => assertUploadAcceptable({ filename: "a.csv", bytes: Buffer.from([0x4d, 0x5a, 0x00, 0x01]) }),
      (e: unknown) => e instanceof FileParseError,
    );
    assert.throws(
      () =>
        assertUploadAcceptable({
          filename: "a.xlsx",
          bytes: Buffer.from("not a zip"),
        }),
      (e: unknown) => e instanceof FileParseError && e.code === "invalid_signature",
    );
    assert.doesNotThrow(() =>
      assertUploadAcceptable({
        filename: "ok.xlsx",
        bytes: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(16)]),
      }),
    );
  });

  it("generates CSV + XLSX templates", async () => {
    const csv = await generateTemplate("csv");
    assert.ok(csv.bytes.toString("utf8").includes("product_name"));
    const xlsx = await generateTemplate("xlsx");
    assert.ok(xlsx.bytes.length > 0);
  });
});

describe("column mapping (Phase D)", () => {
  it("maps exact, aliased and Bengali headers", () => {
    const mapping = autoMapHeaders([
      "Product Name",
      "Sale Price",
      "ক্যাটাগরি",
      "Opening Stock",
      "unnamed",
    ]);
    assert.equal(mapping["Product Name"], "product_name");
    assert.equal(mapping["Sale Price"], "selling_price");
    assert.equal(mapping["Opening Stock"], "opening_stock");
    assert.equal(mapping["unnamed"], undefined);
  });
});

function row(overrides: Partial<NormalizedRow>): NormalizedRow {
  return {
    rowNumber: 2,
    productName: "Football",
    productType: "physical",
    category: null,
    brand: null,
    unit: "Piece",
    description: null,
    sku: null,
    hasVariants: false,
    optionValues: [],
    optionsLabel: null,
    barcode: null,
    sellingPrice: 100,
    purchasePrice: null,
    alertQuantity: null,
    trackingType: "none",
    openingStock: null,
    location: null,
    batchNumber: null,
    expiryDate: null,
    serialNumbers: [],
    imageUrl: null,
    status: "active",
    groupKey: "football",
    ...overrides,
  } as NormalizedRow;
}

describe("grouping (Phase E)", () => {
  it("groups rows by product identity into one product with variants", () => {
    const groups = groupRows([
      row({ rowNumber: 2, sku: "FOOT-S", optionValues: [{ name: "Size", value: "Small" }], optionsLabel: "Size: Small", groupKey: "football||sports||adidas" }),
      row({ rowNumber: 3, sku: "FOOT-M", optionValues: [{ name: "Size", value: "Medium" }], optionsLabel: "Size: Medium", groupKey: "football||sports||adidas" }),
      row({ rowNumber: 4, sku: "FOOT-L", optionValues: [{ name: "Size", value: "Large" }], optionsLabel: "Size: Large", groupKey: "football||sports||adidas" }),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.rows.length, 3);
    assert.equal(groups[0]!.hasVariants, true);
  });

  it("keeps simple products separate", () => {
    const groups = groupRows([
      row({ productName: "Bottle", groupKey: "bottle||" }),
      row({ productName: "Ball", groupKey: "ball||" }),
    ]);
    assert.equal(groups.length, 2);
    assert.equal(groups.every((g) => !g.hasVariants), true);
  });
});

describe("normalization (Phase E)", () => {
  it("handles decimal commas, Bengali digits, booleans and DMY dates without silent zeroing", () => {
    const mapping = {
      "Product Name": "product_name",
      "Sale Price": "selling_price",
      "Opening Stock": "opening_stock",
      "Has Variants": "has_variants",
      "Expiry Date": "expiry_date",
    };
    const parsed = normalizeRow(2, {
      "Product Name": "  Football  ",
      "Sale Price": "1.234,56",
      "Opening Stock": "১০",
      "Has Variants": "হ্যাঁ",
      "Expiry Date": "31/12/2027",
    }, mapping);
    assert.equal(parsed.row.productName, "Football");
    assert.equal(parsed.row.sellingPrice, 1234.56);
    assert.equal(parsed.row.openingStock, 10);
    assert.equal(parsed.row.hasVariants, true);
    assert.equal(parsed.row.expiryDate, "2027-12-31");
  });

  it("records issues instead of converting garbage to zero", () => {
    const parsed = normalizeRow(2, {
      "Product Name": "Football",
      "Sale Price": "abc",
    }, { "Product Name": "product_name", "Sale Price": "selling_price" });
    assert.equal(parsed.row.sellingPrice, null);
    assert.ok(parsed.issues.some((i) => i.code === "invalid_number"));
    assert.ok(parsed.issues.some((i) => i.code === "missing_required"));
  });
});
