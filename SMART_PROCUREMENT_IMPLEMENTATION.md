# ezPos Smart Procurement — Implementation Document

Feature: **ezPos Smart Procurement** — Product Price Intelligence, Supplier
Price Monitoring, Quick Price Check, Smart Reorder Planning, and Supplier
Order Value Management, built as an enhancement to the existing POS.

Branch: `feature/price-monitoring`
Spec: master implementation prompt (phases 0–6). This document tracks
architecture decisions, phase status, database design, API surface,
business rules, and test evidence.

---

## 1. Architecture decisions (approved in Phase 0)

| Decision | Choice | Rationale |
|---|---|---|
| Purchase price history storage | **Read-time derivation** from `purchase_items` × `purchases` (received lines only) | No history table → no drift, no backfill; `purchase_items.unit_cost` already holds the actual received unit cost (receiving overwrites the ordered cost at `receive.service.ts`, so received cost = actual price) |
| "Draft" procurement order | **Unpaid `ordered` PO** via existing `createPurchase` | The shared `status` pgEnum (`ordered/received/partially_received`) has no draft value and is shared by other tables; today's `/reorder` convert flow already works this way |
| Market quotations | **Separate `price_observations` table** | A quotation must never be representable as a completed purchase; purchases remain the only "actual" source |
| Price-increase alerts | Event-based check inside the receive transaction + `notifications` table (dedupe key per price event) | Reuses the notification center (migration 0030); dedupe prevents duplicate alerts |
| Unit comparison | Same-variant comparison only (same unit inherently); quotations normalize per unit via `packageQuantity` | The schema has no unit-conversion table; cross-unit comparison would be guesswork |
| Money math | Aggregations computed in the SQL `numeric` domain, `ROUND(x, 2)` before any `::float8` cast | `ROUND(float8, int)` does not exist in Postgres; keeps precision |
| Frontend data fetching | TanStack Query v5 with a query-key factory (mirrors `features/due-management`) | The one modern in-repo pattern; other pages use zustand/axios directly |
| Frontend tables | Plain `ui/table` (RolesPage pattern) | TanStack Table v9 features registry is product-specific; registering a second registry is over-engineering for MVP |
| Frontend tests | Vitest + Testing Library (new dev-only deps, user-approved) | The POS frontend had zero test infrastructure; spec requires frontend tests |

## 2. Database design (migration `drizzle/0036_smart_procurement.sql`)

All changes additive; applied to `ezpos_test` and dev `ezPos` (2026-11-04,
verified: 37 journal entries, 2 new tables, 4 supplier columns, 1 index).

1. **`price_observations`** — manually recorded supplier quotations
   ("Quick Price Check", Phase 2). `business_id`, `variant_id`,
   `supplier_id` (composite FKs to `(id, business_id)` of
   product_variants/suppliers), `quoted_price numeric(12,2) CHECK >= 0`,
   `package_quantity numeric(12,3) NULL` (NULL = per-unit price),
   `observation_date date`, `notes`, `created_by_user_id → users(id)`,
   timestamps. Indexes: `(business_id, variant_id, observation_date DESC)`,
   `(business_id, supplier_id)`.
2. **`price_alert_settings`** — one row per business (PK = business_id,
   FK cascade): `enabled boolean default false`,
   `increase_threshold_pct numeric(5,2) default 10.00 CHECK > 0`,
   timestamps. Phase 3.
3. **`suppliers` new columns** — `minimum_order_value numeric(12,2) NULL`
   (supplier's requirement), `target_order_value numeric(12,2) NULL`
   (business's own goal — independent by design),
   `order_settings_enabled boolean default false`,
   `order_settings_notes text`. Phase 5.
4. **Index** `purchase_items_business_variant_idx (business_id, variant_id)`
   — price-history aggregation by variant had no supporting index.

Drizzle mirrors: `src/db/schema/priceObservations.ts`,
`src/db/schema/priceAlertSettings.ts`, `suppliers.ts`, `relations.ts`.

## 3. Phase status

| Phase | Scope | Status |
|---|---|---|
| 0 | Architecture inspection + schema approval | ✅ Complete (2026-11-04) |
| 1 | Product Price Intelligence | ✅ Complete (2026-11-04) — see §4 |
| 2 | Wholesale Market Price Check (Quick Price Check) | ✅ Complete (2026-11-04) — see §5 |
| 3 | Supplier Price Monitoring + increase alerts | ⬜ Not started |
| 4 | Smart Reorder Planning (extend `modules/reorder`) | ⬜ Not started |
| 5 | Supplier Order Value Management | ⬜ Not started |
| 6 | Integration QA + regressions | ⬜ Not started |

## 4. Phase 1 — Product Price Intelligence

### Backend (new module `ezPosBackend/src/modules/procurement/`)

- `schemas/priceHistory.schema.ts` — Zod query schemas (`page`, `limit`,
  `search`, `categoryId`, `supplierId`, `from`/`to` as `YYYY-MM-DD`).
- `priceHistory.service.ts` — read-time price history.
- `procurement.controller.ts` — inline `safeParse` validation, `{ success: true, data }`
  envelope, `sendSafeError` error mapping.
- `procurement.routes.ts` — `requireAuth → requireBusinessContext() →
  requireLocationAccess() → requirePermission("purchases.view")` chain.
- Mounted in `src/app.ts buildApp()` after `purchasesReturnRouter`.

### API

**`GET /api/procurement/price-overview`** (permission `purchases.view`)
Query: `page` (default 1), `limit` (default 50, max 200), `search`
(product name / SKU ILIKE), `categoryId`, `supplierId`, `from`, `to`
(inclusive end day). Returns `{ success, data: { data: Row[], total, page, limit } }`
where Row = `{ variantId, sku, productId, productName, categoryName,
unitName, latestPrice, previousPrice, lowestPrice, highestPrice,
averagePrice, purchaseCount, totalReceivedQuantity, lastPurchaseDate,
lastSupplierId, lastSupplierName, priceChangePercent }`.
`latestPrice`/`previousPrice` are the two most recent price events ordered
by `purchase_date DESC, purchase_items.id DESC`; `priceChangePercent` is
`(latest − previous) / previous × 100` (NULL when previous is 0/missing).

**`GET /api/procurement/variants/:variantId/price-history`** (permission
`purchases.view`) Query: `page`, `limit`, `supplierId`, `from`, `to`.
Returns `{ success, data: { variant, summary, suppliers[], records } }` —
`summary` adds `priceChangeAmount`; `suppliers` is ordered by latest price
ascending (cheapest comparable source first); `records` is the paginated
received-purchase-line list `{ data, total, page, limit }`. Unknown variant
(outside business) → 404.

### Frontend (new feature `pos/src/features/procurement/`)

- `api/procurement.api.ts`, `hooks/useProcurement.ts` (query-key factory +
  `keepPreviousData` pagination).
- `utils/priceMath.ts` — `percentChange`, `formatPercent`, `priceDirection`.
- `components/PriceChangeBadge.tsx` — factual up/down/flat indicator.
- `pages/PriceMonitoringPage.tsx` (`/procurement/prices`) — search,
  category + supplier selects (Base UI `items` prop, `"all"` sentinels),
  date range, sortable-column table, row click → detail, pagination,
  loading/error/empty states.
- `pages/VariantPriceHistoryPage.tsx` (`/procurement/prices/:variantId`) —
  summary stat cards, Recharts trend (`ReportTrendChart`), supplier
  comparison with "Best price" badge, paginated purchase records.
- Routes registered in `src/routes/AppRoutes.tsx` (inside `AppLayout`,
  wrapped in `RequirePermission purchases.view`); nav entry
  "Product Price Monitoring" added under Purchases in
  `src/config/navigation.ts`.

### Business rules implemented

- Only **received** purchase lines are price events: `received_quantity > 0`
  AND purchase status in (`received`, `partially_received`). Ordered-but-
  unreceived purchases never appear; drafts do not exist; there is no
  cancelled status to exclude (`cancelled_quantity` is never written).
- Partially received purchases contribute **only received quantity**
  (averages weighted by `received_quantity`).
- History is never mutated by later purchases (read-time derivation).
- Tenant isolation: every query filters `business_id` from the verified
  session; composite FKs guarantee referential tenancy.
- Prices are stored/compared per variant — no cross-unit or cross-product
  comparison.
- The change badge reports numbers only; it never labels a supplier.

### Test evidence (actually executed 2026-11-04)

- Backend: `npx tsc --noEmit` — clean.
- Backend tests: `DATABASE_URL=…/ezpos_test INTEGRATION_TESTS=1
  AUTH_RATE_LIMIT_MAX=500 npm test` → **374/374 pass** (366 before + 8 new
  in `src/test/procurementPriceHistory.integration.test.ts`: aggregation
  math 102.22 weighted avg / 22.22 % change, ordered-purchase exclusion,
  partial receiving, supplier comparison ordering, filters, pagination,
  404/401, second-business isolation, query validation).
- Frontend: `npm test` (Vitest, new) → **17/17 pass** (priceMath unit
  tests, PriceChangeBadge render, PriceMonitoringPage row/empty/error).
- Frontend `npx tsc -b` → 0 errors in new files (69 pre-existing baseline
  errors untouched, per repo history `vite build` never type-checked).
- `npm run build` (vite) → green.
- ESLint: repo config lints `**/*.{js,jsx}` only — TS files are outside
  its pre-existing scope; no new JS files added.

### Known limitations (Phase 1)

- Supplier comparison uses latest received price per supplier; quotations
  (Price Check) join the comparison in Phase 2 with a source badge.
- The trend chart plots the current page of records (up to 20 newest);
  older points appear on later pages. A dedicated unbounded points query
  is a Phase 3 candidate if owners need long-range charts.
- `lastPurchaseDate` ordering uses `purchase_date` + item id; two events
  recorded in the same microsecond would fall back to insertion order.
- Overview rows only include variants with ≥1 received line.

## 5. Phase 2 — Wholesale Market Price Check

### Backend (extensions to `src/modules/procurement/`)

- `schemas/priceCheck.schema.ts` — create/update/list/param Zod schemas
  (`quotedPrice >= 0`, optional positive `packageQuantity`,
  `observationDate` YYYY-MM-DD, notes ≤ 500).
- `priceCheck.service.ts` — observation CRUD. Verifies variant + supplier
  belong to the caller's business (composite-FK tenancy), normalizes
  packaged quotes to a per-unit comparison price
  (`quoted_price / package_quantity`, rounded 2dp in numeric semantics),
  defaults `observationDate` to today, and writes `price_check.created /
  updated / deleted` audit rows via `recordAuditInTx`. Variant is
  immutable after creation (history integrity).
- `procurement.controller.ts` / `procurement.routes.ts` — new endpoints
  (below). `req.user.id` is the audit actor.
- `priceHistory.service.ts` — `GET …/price-history` response now also
  carries `observations` (latest 20 quotations + total for the variant,
  with supplier names and normalized per-unit price) and per-supplier
  `latestQuotation` + `lastObservationDate` in the comparison rows.
- RBAC: new key `purchases.price_check` (module `purchases`) added to the
  catalog and to the **manager** default template; owner covers it via
  wildcard; accountant/cashier do not have it. Frontend mirror added in
  `pos/src/lib/rbac.ts`. Existing businesses' staff roles receive the key
  only via the Roles UI (established template behavior).

### API

- `POST /api/procurement/price-check` — create observation
  (`purchases.price_check` + write chain). 201 `{ success, data: { id } }`.
- `GET /api/procurement/price-check` — paginated history
  (`purchases.view`); filters `search`, `variantId`, `supplierId`,
  `from`, `to`; rows include product/sku/unit/supplier names, quoted
  price, package size, normalized `unitPrice`.
- `PATCH /api/procurement/price-check/:id` — edit quoted price, package
  size, date, notes, supplier (`purchases.price_check`). 404 for
  observations outside the business.
- `DELETE /api/procurement/price-check/:id` — hard delete, audited
  (`purchases.price_check`).

### Frontend

- `pages/PriceCheckPage.tsx` (`/procurement/price-check`, nav "Price
  Check History") — Quick Price Check form (variant search + select,
  supplier select with inline `<SupplierDialog />` creation via the
  existing contacts workflow, quoted price, optional package size with
  live "Comparable unit" hint, date, notes), history table with per-unit
  badges, filters, pagination, edit dialog + `ConfirmDeleteDialog`
  deletion, and a read-only variant of the page for callers without
  `purchases.price_check`. Accepts `?variantId=` prefill (deep link from
  the variant history page's "Quick Price Check" button).
- `VariantPriceHistoryPage.tsx` — new "Market quotations" card (source
  badge, quoted / per-unit / date / supplier / notes) and a "Latest
  quotation" column beside the latest actual price in the supplier
  comparison; purchase aggregates remain quotation-free.
- `utils/priceMath.ts` — `perUnitPrice`; `api`/`hooks` extended with
  observation types, fetchers, mutations (query invalidation on
  `procurementKeys.all`).

### Business rules implemented

- A quotation is NEVER a purchase: separate table, separate endpoints,
  separate aggregates; purchase history and purchase-based comparisons
  are untouched by observations.
- Source labeling: every quotation display is badged "Quotation" with its
  observation date; actual prices are the received purchase lines.
- Packaged quotes normalize per unit (৳1,500 / 25 Kg → ৳60/Kg) while the
  original quoted price and package size stay visible.
- Same-variant comparison only; the variant fixes the unit.
- Mutations are permission-gated (`purchases.price_check`), audited, and
  tenant-scoped; read is `purchases.view`.

### Test evidence (executed 2026-11-04)

- Backend: tsc clean; `procurementPriceCheck.integration.test.ts` **6/6**
  (per-unit normalization 1500/25→60, purchase aggregates unaffected,
  supplier comparison quotation column, update+delete with audit rows,
  foreign variant/supplier rejection, second-business 404s, manager
  allowed + accountant 403-on-write with 200-on-read); full suite
  **380/380** (374 + 6).
- Frontend: **24/24** vitest (new: 4 `perUnitPrice`, 3 PriceCheckPage
  render/permission tests); `tsc -b` 0 new-file errors; `vite build`
  green.

### Known limitations (Phase 2)

- Quotation-only suppliers (no purchases) appear in the observations list
  but not in the purchase-based supplier comparison; Phase 3's supplier
  monitoring view will present the full union.
- The variant history endpoint returns the latest 20 quotations (with
  total); full quotation pagination lives on the Price Check History
  page.

## 6. Remaining work

- **Phase 2**: ✅ shipped (see §5).
- **Phase 3**: Supplier Details page (none exists today — suppliers have
  no GET/PATCH by id), supplier price history/comparison/trend, alert
  settings UI + receive-transaction detection + `price_increase`
  notification kind (varchar kind — no migration needed), dedupe via
  `price_increase:{variantId}:{supplierId}:{purchaseId}`, new permission
  key `purchases.manage_price_alerts`.
- **Phase 4**: extend `modules/reorder` (net `reserved_quantity` +
  in-transit transfers; supplier-wise grouping; no-supplier / missing-price
  flags; estimated reorder value dashboard).
- **Phase 5**: supplier order settings (columns ready), PATCH endpoint
  (permission `suppliers.edit`), order-value status indicators,
  below-minimum flow with warnings, draft creation via existing
  `createPurchase` (also add `id` to its `POST /api/purchases` response —
  currently returns only `purchaseOrderNumber`).
- **Phase 6**: full regression pass (purchases/receiving/POS), cleanup.
