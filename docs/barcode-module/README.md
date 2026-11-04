# Barcode Generator & Label Printing module

Production documentation for the barcode/label module (2026-11). The
master prompt's Phase A audit, Phase B proposal and the user's approval
covered every change here — nothing was modified without approval.

## What it does

1. **Generate** unique internal barcodes — CODE128, `EZ` + 12-digit
   per-business sequence (never EAN/UPC: no fake GS1 identifiers are ever
   minted). Bulk generation for selected variants; variants WITH an
   existing barcode get the new code as an **alias** (nothing replaced
   silently); regeneration requires explicit confirmation and archives the
   old code to the audit log.
2. **Assign** external manufacturer barcodes (EAN-13/EAN-8/UPC-A validated
   with GS1 check digits; CODE128/CODE39 free-form) as a variant's primary
   or as aliases. Primary replacement requires explicit `replace`
   confirmation.
3. **Resolve** scanned codes server-side: primary barcode → alias → SKU,
   exact match, per-business scope, never ambiguous picks.
4. **Print labels** — 40×25 / 50×30 / 60×40 mm roll labels, A4 sheets
   (grid + spacing + margins) and custom geometry; configurable fields
   (name, variant, SKU, price, shop, logo), barcode height, quiet zone,
   font sizes, copies. Two output paths render the **same document**:
   browser print (exact `@page { size: Wmm Hmm }`) and PDF download
   (jsPDF + svg2pdf, vector barcodes — sharp at any size).
5. **Integrate scanning** — POS checkout, PO creation, purchase receiving
   (new scan-to-line box) and stock counting fall back to the server
   resolver when a scan misses the local catalog (covers aliases and
   codes newer than the loaded catalog).

## Architecture

```
pos/src/features/barcodes/
├── barcodeFormats.ts      # validation mirror of the backend rules (UX only)
├── barcodeRenderer.ts     # JsBarcode → SVG strings + QR (qrcode)
├── labelTemplates.ts      # sizes, defaults, copies expansion, page layout
├── labelRenderer.ts       # label sheet HTML (@page mm) + iframe print
├── labelPdf.ts            # jsPDF + svg2pdf vector PDF (lazy-loaded)
├── barcode.api.ts         # backend endpoints
├── hooks/useBarcodes.ts   # TanStack Query (key factory)
├── components/            # BarcodeLabelPreview, BarcodePrintDialog
└── pages/BarcodeGeneratorPage.tsx

ezPosBackend/src/modules/barcodes/
├── barcodes.validation.ts # authoritative format/check-digit validation
├── barcodes.service.ts    # assign/generate/lookup/validate/history
├── barcodes.controller.ts # Zod → rules → transactions
└── barcodes.routes.ts     # permission-gated routes
```

Key invariants:

- **Primary barcode stays on `product_variants.barcode`** — single source
  of truth; every pre-existing query/scan keeps working unchanged.
- **One code → one variant per business**: aliases and primaries are
  cross-checked against BOTH tables on every write (unique indexes
  backstop within each table).
- **Idempotent internal numbering** via `document_sequences`
  (`internal_barcode` key) — same rollback-safe allocation as SKUs.
- **A barcode is never replaced silently** — replacement needs explicit
  confirmation; the old code is archived in `audit_log`
  (`barcode.assigned/changed/regenerated/removed/alias_*`).
- Aspect ratios are never distorted: SVG output with fixed module widths,
  GS1 quiet zones (≥ 10× modules), print at 100% scale enforced by
  messaging and exact `@page` sizing.

## Database (migration 0044 — approved 2026-11-05)

- **`variant_barcode_aliases`** — `id`, `business_id`, `variant_id`
  (composite FK), `barcode` (unique per business), `barcode_format`,
  `source` (external/internal), `created_by`, `created_at`.
- **`product_variants.barcode_format varchar(20) NULL`** — symbology of
  the primary barcode.

Rollback: drop table + drop column (additive only; no data migration).

## API

| Method & path | Permission | Purpose |
|---|---|---|
| GET `/api/barcodes/search` | `products.view` or `pos.view` | Paged variant catalog for the generator |
| GET `/api/barcodes/variant/:variantId` | same | Variant detail incl. aliases |
| POST `/api/barcodes/generate` | `products.edit` + full access | Bulk internal generation (`regenerate: true` = explicit replace) |
| POST `/api/barcodes/assign` | `products.edit` + full access | Assign primary (replace confirmed) or alias |
| PUT `/api/barcodes/alias/:aliasId` | `products.edit` + full access | Update alias code/format |
| DELETE `/api/barcodes/alias/:aliasId` | `products.edit` + full access | Remove alias |
| POST `/api/barcodes/validate` | `products.view`/`pos.view` | Format + check digit + in-business conflict check |
| GET `/api/barcodes/lookup/:code` | `products.view`/`pos.view` | Exact scanner resolution |
| GET `/api/barcodes/print-history` | `products.view`/`pos.view` | Audit-backed print history |
| POST `/api/barcodes/print-history` | `products.print_labels` + full access | Record a print job |

New permission: `products.print_labels` (manager default; owner wildcard).
Generate/assign intentionally ride the existing `products.edit`.

## Testing

- Backend: `src/test/barcodes.integration.test.ts` — 11 tests: validation
  table (EAN-13/EAN-8/UPC-A + bad check digits + lengths), assignment +
  replace-confirmation flow + audit trail, duplicate prevention across
  variants/aliases/product-creation (23505→409), GTIN-shaped codes with
  bad check digits rejected at product creation, generation (primary vs
  alias vs regenerate), concurrency (5 parallel generations → 5 distinct
  codes), alias lifecycle, lookup matrix (primary/alias/SKU/unknown),
  tenant isolation (foreign assign/lookup masked; same retail code usable
  by another business), print history, unauthorized access.
- Frontend: 13 tests — validation mirror table, SVG renderer (valid +
  invalid encodes, QR), generator page (catalog render, empty state,
  selection).
- Regression: full suites green (see TEST_REPORT notes in the final
  report).

## Known limitations

1. **Thermal/ZPL direct printing deferred** (v2) — v1 ships browser print
   + PDF; raw ZPL needs Zebra Browser Print and per-vendor ESC/POS label
   modes. Print at 100% scale.
2. **EAN-13 add-ons (EAN-2/EAN-5)** are not rendered as composed symbols.
3. **Product import** doesn't exist in ezPos; the CSV export already
   carries barcodes (unchanged).
4. **Alias uniqueness is service-enforced across tables** (each table has
   its own DB unique index; the cross-table rule is checked in the
   service under row locks) — a concurrent primary-vs-alias race on the
   same code settles via the 409 path, not silently.
5. **Logo on labels** uses the receipt-settings logo URL (label preview +
   print); the PDF path draws text + barcodes but embeds the logo as an
   image only in the browser-print path.
6. **Check digits are validated, never rewritten** — a merchant's bad
   number is refused with guidance, per the master prompt.
