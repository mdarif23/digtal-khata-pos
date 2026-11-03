# RECEIPT_INVOICE_IMPLEMENTATION.md

Receipt & Invoice Customization module — implementation progress.

Branch: `feature/receipt-customization`
Spec: business-owner-customizable receipts (58mm/80mm thermal) and invoices (A4/A5), server-persisted per business, shared preview/print renderer.

---

## Phase 0 — Architecture Inspection ✅ (2026-11-04)

Findings (full report in session):

- Receipt "customization" was **client-only** (Zustand `useReceiptSettingsStore` → localStorage `ezpos-receipt-settings`); never synced to the backend.
- Two duplicated receipt layouts existed (React `ReceiptTemplate.tsx` preview vs hand-rolled HTML string in `usePrintReceipt.ts`) — drift risk.
- `GET /api/sales/:id/receipt` (`sales.service.getSaleReceipt`) is the single receipt assembly point; carried **no business branding**.
- `businesses.logo_url` column existed but was completely unwired.
- No invoice document, no settings tables, no upload infra (POS), no `tabs.tsx`.
- `document_sequences` already provides per-business invoice numbers; financial values are snapshotted on sale rows (`selling_price`, `discount`, `tax_detail`).

**Owner approvals granted:** (1) DB changes as proposed — `document_settings` table + `businesses.website/vat_bin/tagline`; (2) logo stored as **data URL** in `businesses.logo_url` (no S3 dependency, offline-safe printing).

**Documented decision (historical documents):** print with **current** branding + current template; financial values always from immutable sale rows. Template changes never alter transactions. Invoice numbers are immutable columns.

## Phase 1 — Business Branding + Backend Module ✅ (2026-11-04)

### Database (migration `0038_receipt_invoice_customization.sql`)

- `document_type` enum: `sales_receipt`, `sales_invoice` (future: return slip, payment receipt).
- `document_settings`: PK `(business_id, doc_type)`, `config` jsonb, `template_version`, timestamps.
- `businesses` + `website varchar(255)`, `vat_bin varchar(60)`, `tagline varchar(160)`.
- Applied to **both** `ezPos` (dev) and `ezpos_test` — via manual statement-runner after `drizzle-kit migrate` silently no-oped (known quirk: bookkeeping was 2 entries short after earlier hand-applied migrations; rebuilt to 39/39 journal entries). DDL verified via `information_schema` on both DBs.

### Backend

- `src/db/schema/documentSettings.ts` — new table; `businesses.ts` +3 columns.
- `src/rbac/permissions.ts` — **4 new keys** (module `settings`): `receipt_settings.view`, `.edit`, `.manage_logo`, `.print_test`. Role defaults: manager = all four; cashier/accountant = view. Owner covered by wildcard. NOTE: roles of pre-existing businesses do NOT auto-gain new keys (seed runs at business creation / role edit) — mitigated: settings GET also accepts `pos.view`/`sales.view` so existing cashiers can still read the template for printing.
- `src/modules/documentSettings/` — Zod contracts (every field defaulted, `TEMPLATE_VERSION = 1`, `.prefault({})` groups fill from inner defaults), service (normalize-with-defaults on read, validate-then-upsert on write, `getDocumentBranding`), controller (`{success, data}` envelope), routes.
  - `GET /api/document-settings` — `requireAuth + requireBusinessContext + requireAnyPermission([receipt_settings.view | pos.view | sales.view])`.
  - `PUT /api/document-settings/:docType` — `+ requireFullAccess + requirePermission(receipt_settings.edit)`; invalid config → **400** (ZodError→BadRequestError), unknown docType → 400.
- Logo endpoints on `businesses` module: `PUT/DELETE /api/businesses/:businessId/logo` (`requireBusinessAccess + requireFullAccess + receipt_settings.manage_logo`). Data URL validated: PNG/JPEG/WebP allow-list + **magic bytes** + 300 KB decoded cap (JPEG-masquerading-PNG rejected).
- `PUT /api/businesses/:businessId` now also accepts `website` (`http(s)://` enforced), `vatBin`, `tagline`; `getBusinessForMembership` returns logoUrl/website/vatBin/tagline.
- `sales.service.getSaleReceipt` now embeds `business` (branding), `documentSettings` (both configs), item `unitName` (units join), `cashierName` (users join) — additive; flows into `createSale`/exchange/replay responses automatically.
- `app.ts` central error handler maps body-parser `entity.too.large` → **413** (was generic 500).
- Mounted `documentSettingsRouter` in `buildApp()`.

### Tests — `src/test/documentSettings.integration.test.ts` — **13/13 pass**

defaults / PUT receipt / PUT invoice / invalid-config 400s / unknown docType / business isolation / cashier read-no-write / manager edit / unauthenticated 401 / logo upload-validate-replace-remove / profile fields / receipt embed + historical financial accuracy (template+branding changed after sale → financials unchanged).

## Phase 2 — Receipt Customization (frontend) ✅ (2026-11-04)

- `pos/src/features/receipt-settings/` new feature:
  - `schemas/documentSettings.schema.ts` — Zod mirror of the backend contract (hand-synced, repo convention), `normalizeReceiptConfig/InvoiceConfig` for untrusted stored configs.
  - `api/receiptSettings.api.ts` — settings CRUD + business profile + logo upload/remove.
  - `hooks/useDocumentSettings.ts` — TanStack Query (`documentSettingsKeys` factory), toast-wrapped mutations, invalidation.
  - `renderers/receiptHtml.ts` — **THE shared receipt renderer**: (receipt, branding, config) → standalone HTML. 27 visibility flags, compact/detailed item table, font/align/logo-width/margins/spacings/separators layout controls, custom text (title/thank-you/footer/additional), real QR code (`qrcode` dep, encodes invoice#+total), multi-copy page-breaks, full HTML escaping (XSS-safe — old renderer interpolated raw).
  - `renderers/invoiceHtml.ts` — A4/A5 formal invoice renderer (Phase 3, same contract).
  - `renderers/sampleData.ts` — clearly-labeled SAMPLE transaction (never hits the API).
- `/settings/receipt` page (route + sidebar entry "Receipt & Invoice" gated `receipt_settings.view`): Tabs — Business Info / Receipt Design / Invoice Design / Printing — with a sticky **Live Preview** rendered by the same renderer as printing (iframe srcDoc, true paper width, auto-height). Drafts are local; Save commits per card; dirty detection; reset-to-defaults.
- `BusinessInfoCard` (RHF+Zod, saves to existing business profile endpoint) + `LogoUploader` (client type/size validation → server validation; preview, replace, remove).
- New UI primitive `pos/src/components/ui/tabs.tsx` (Base UI Tabs, kit style). `qrcode` + `@types/qrcode` added to pos (only new dependency).

## Phase 3 — Invoice Customization ✅ (2026-11-04)

- A4/A5 renderer: logo+business header, INVOICE title, invoice #/date/status meta, Bill-To block, configurable item columns (Description/SKU/Unit/Qty/UnitPrice/Discount/VAT/Amount), totals block (subtotal/discount/VAT/grand/paid/due), payment information, sale note, terms & conditions, authorized signature block, footer message. Column-level visibility (columns vanish entirely when disabled).
- `InvoiceDesignCard` — paper size, 27-flag visibility grid, custom text (title/terms/footer), signature toggle.

## Phase 4 — Printing Integration ✅ (2026-11-04)

- `usePrintReceipt.ts` rewritten around the shared renderers:
  - `printReceipt(receipt, {paperWidth?, config?, branding?, copies?, isAutoPrint?})` — template resolved from the receipt's **server-embedded `documentSettings`**, falling back to a mapping of the legacy localStorage store (offline/pre-module receipts). Hardware ESC/POS path unchanged (subset, uses branding name + footer).
  - `printInvoice(receipt, ...)` — new, same iframe mechanics.
  - Guards preserved: per-saleId auto-print dedupe, re-entrancy lock, USB→browser fallback.
- `SaleSuccessDialog` — auto-print now reads the **saved template on the receipt** (`resolveReceiptConfig(receipt).print.autoPrintOnSale`), not local state.
- `ReceiptPrintDialog` — preview is now the shared-renderer HTML in an iframe (byte-for-byte what prints); modes 58mm/80mm/Invoice(A4); "Customize" link to `/settings/receipt` (permission-gated); HardwareSettings retained. Old `ReceiptTemplate.tsx` deleted (was the drift-risk duplicate).
- `TestPrintCard` on the settings page — prints the labeled sample through the real engines using current drafts (`receipt_settings.print_test`/edit holders).
- Copies: rendered as repeated blocks with `page-break-after` — one browser dialog, N copies on the roll.
- Legacy `useReceiptSettingsStore` kept solely as offline/legacy fallback + logout reset; server is the source of truth.

## Phase 5 — Testing & QA ✅ (2026-11-04)

- Backend: `tsc -b` **clean**; full suite **421/421** (incl. 13 new documentSettings tests).
- Frontend (pos): `tsc -b` = pre-existing baseline only (0 errors in new/changed files; deviceManager×3 + config-file×2 verified pre-existing via stash comparison); vitest **56/56** (14 new renderer tests: financial accuracy, visibility flags, paper widths, compact/detailed/separator layout, copies, XSS escaping, QR mock, A4/A5, column hiding, normalization fallbacks); `vite build` **green**; `npm run lint` = 2 pre-existing `__dirname` errors in vite/vitest configs only.
- Migration verified on both DBs (`document_settings` + 3 columns + enum present).

## Acceptance criteria status

1. ✅ Logo upload/replace/remove with validation
2. ✅ Business information on documents (source of truth: `businesses`)
3. ✅ 58mm/80mm receipt layouts (live preview + print)
4. ✅ Show/hide receipt fields (27 flags)
5. ✅ Footer text + typography customization
6. ✅ A4/A5 invoice configuration
7. ✅ Preview updates immediately (debounced, same renderer)
8. ✅ Actual printing matches saved configuration (single shared renderer)
9. ✅ Existing sales transactions work (421/421 backend incl. p0 regression suite)
10. ✅ Historical invoice financials unchanged (tested explicitly)
11. ✅ Business-level isolation (PK scoping + middleware; tested)
12. ✅ Unauthorized employees cannot change templates (cashier 403 tested; nav/route gated)
13. ✅ Existing printing functionality not broken (same dialog entry points, USB path, dedupe guards preserved)
14. ✅ Tests and production builds pass

## Notes / future work (explicitly out of scope)

- Sales-return slip and payment-receipt document types: `doc_type` enum + per-type schema ready for them; not implemented (app has no return/payment printing today). The exchange flow's unused `receipt` payload is a ready hook point.
- ESC/POS USB path prints a field subset (name/qty/price/totals/footer) — extending it to honor every flag needs per-printer ESC/POS formatting work.
- Roles in businesses created before this feature lack `receipt_settings.*` keys until edited in Roles UI (read fallback via pos.view/sales.view keeps printing working).
