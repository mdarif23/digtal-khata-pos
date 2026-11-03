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
| 3 | Supplier Price Monitoring + increase alerts | ✅ Complete (2026-11-04) — see §6 |
| 4 | Smart Reorder Planning (extend `modules/reorder`) | ✅ Complete (2026-11-04) — see §7 |
| 5 | Supplier Order Value Management | ✅ Complete (2026-11-04) — see §8 |
| 6 | Integration QA + regressions | ✅ Complete (2026-11-04) — see §9 |

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

## 6. Phase 3 — Supplier Price Monitoring

Committed history note: Phases 1–2 shipped as commit `316e51b`.

### Backend

- **`supplierMonitoring.service.ts`** — `getSupplierDetail` (profile incl.
  order-value settings fields + received-value stats), and
  `getSupplierPriceHistory` (reuses the price-overview aggregation with
  the supplier filter forced on — rows aggregate only THIS supplier's
  received purchases and THIS supplier's quotations), plus
  `getSupplierVariantTrend` (chronological received unit costs for one
  variant, capped at 200 events).
- **`priceAlerts.service.ts`** — alert settings (get/upsert with defaults
  `{enabled:false, threshold:10}`) and `checkPriceIncreasesInTx`, called
  inside the purchase-receiving transaction from
  `purchases.service.ts createReceivePurchase` (wrapped in try/catch —
  alerting never blocks a legitimate receive). Compares each received
  line's actual unit cost against that supplier's previous actual price
  for the variant (excluding the current purchase), fires a factual
  `price_increase` notification when `percentChange >= threshold`:
  title `Price increase: {product}`, body `120.00 → 135.00 (+12.5%) from
  Distributor A.`, payload `{variantId, supplierId, purchaseId,
  previousPrice, currentPrice, percentChange}`.
  **Duplicate prevention is two-layered**: the notification-center dedupe
  (`UNIQUE(business_id, dedupe_key)`, day-suffixed) plus an explicit
  existence check on the event key
  `price_increase:{business}:{variant}:{supplier}:{purchase}` so a price
  event alerts exactly once — ever, even across partial receives on
  different days. Disabled by default; decreases and below-threshold
  increases never alert; no supplier is ever labeled unreliable.
- **Endpoints** (all tenancy-chained):
  - `GET /api/procurement/suppliers/:supplierId` — detail + stats
    (`anyOf suppliers.view, purchases.view`)
  - `GET /api/procurement/suppliers/:supplierId/price-history` —
    paginated, `search/from/to` (same permission)
  - `GET /api/procurement/suppliers/:supplierId/trend?variantId=` — chart
    events (same permission)
  - `GET /api/procurement/alert-settings` (`purchases.view`)
  - `PUT /api/procurement/alert-settings`
    (`purchases.manage_price_alerts` — NEW key, owner-level: catalog +
    frontend mirror only, deliberately NOT in staff role templates)
- `price-overview` rows now carry supplier-aware `latestQuotation` /
  `lastObservationDate` (when filtered by supplier, quotations from that
  supplier; otherwise latest across suppliers).

### Frontend

- **SupplierDetailsPage** (`/procurement/suppliers/:supplierId`) —
  profile + stat cards, supplier price history table (latest, latest
  quotation + date, previous, change badge, low/high/avg, counts, last
  purchase), and a per-product price trend chart (variant selector →
  `ReportTrendChart`). Reached by clicking a row in the existing
  Suppliers list (`SuppliersTable` rows now navigate).
- **PriceMonitoringPage** — "Price increase alerts" settings card
  (enable switch + threshold + save), editable only with
  `purchases.manage_price_alerts`, read-only otherwise.
- api/hooks extended (query-key factory + invalidation); `rbac.ts` mirror
  gains `purchases.manage_price_alerts`. Alerts themselves surface in the
  existing notification center (bell, SSE) — no new UI surface needed.

### Business rules implemented

- Alerts fire on the RECEIVE event (the moment an actual price lands),
  compared per (supplier, variant) against the previous actual price.
- One alert per price event ever; multi-day partial receives cannot
  re-alert the same event.
- Disabled by default; the owner opts in and sets the threshold.
- Factual numbers only — the system never labels a supplier dishonest or
  unreliable.

### Test evidence (executed 2026-11-04)

- Backend: tsc clean; `procurementSupplierMonitoring.integration.test.ts`
  **6/6** — settings read/validate/permission-gate (owner PUT, accountant
  403-PUT/200-GET), exactly one `price_increase` row with the exact
  `120.00 → 135.00 (+12.5%)` event and payload, detail stats
  (2760 received value / 5 purchases / 1 product), supplier-scoped
  history (latest 100 vs previous 140 → −28.57%, avg 115, quotation 150),
  chronological trend `[100,120,135,140,100]`, foreign-tenant 404s;
  disabled-by-default silence and below-threshold/decrease silence are
  baked into the fixture (5 purchases → exactly 1 alert). Full suite
  **386/386** (380 + 6).
- Frontend: **26/26** vitest (new SupplierDetailsPage tests; monitoring
  page test mock extended); `tsc -b` 0 new-file errors; `vite build`
  green.

### Known limitations (Phase 3)

- Quotation-only suppliers (no purchases) still appear only in the
  observations list, not the purchase-based comparison table.
- The trend chart caps at the 200 most recent events per variant.
- Alerts are in-app notifications (bell + SSE); no email/push channel.

## 7. Phase 4 — Smart Reorder Planning

Committed history: Phases 1–2 = `316e51b`; Phase 3 = `0b0c81d`.

### One computation, two surfaces (no conflicting inventory rules)

`src/modules/procurement/reorderPlanning.service.ts` is now the single
reorder computation; the pre-existing Module 2C
(`modules/reorder/reorder.service.ts listReorderSuggestions`) **delegates
to it** and maps the result onto its original response shape — existing
`/reorder` frontend and convert flow unchanged. The rule:

```
available = (current stock − reserved) + outstanding POs + in-transit
            transfers inbound to the location
```

- Outstanding POs: `quantity − received − cancelled` across purchases
  `NOT IN ('received')` (the pre-existing netting, preserved).
- **Reserved** (`inventory_stock.reserved_quantity`, online-channel
  holds) now nets in — previously ignored.
- **In-transit** (`quantity_shipped − quantity_received` on transfers in
  `shipped`/`partially_received` with `to_location = location`) now nets
  in — previously ignored entirely.
- Monitored variants: `reorder_point IS NOT NULL OR alert_quantity > 0`
  (LEFT JOIN stock so never-stocked variants still surface as out-of-
  stock — an improvement over the old INNER JOIN).
- Status classification in SQL (single source): `out_of_stock` >
  `low_stock` (alert qty) > `needs_reorder` (available ≤ point) >
  `healthy`.
- **Suggested quantity**: configured `reorder_quantity` wins; otherwise
  shortfall to the reorder point; with **neither configured, nothing is
  invented** (null — the buyer decides), per spec.

### Backend API

`GET /api/procurement/reorder-dashboard` (`purchases.view`, read chain,
location-aware via `requireLocationAccess`). Response:
`{ summary, suppliers, data, total, page, limit }` —
- `summary`: outOfStock / lowStock / needsReorder / attentionCount /
  **totalEstimatedValue** / **noSupplierCount** / **missingPriceCount** /
  supplierCount;
- `suppliers`: attention products grouped by last supplier with item
  counts, suggested totals, estimated value, and the supplier's
  `minimum_order_value` / `target_order_value` displayed for reference
  (status logic deferred to Phase 5);
- `data` rows: stock, reserved, on-order, in-transit, available,
  suggested qty, last unit cost, estimated value, last supplier, status.
Filters: `search`, `status` (`all`/`attention`/per-status), pagination.

### Frontend

- **ReorderDashboardPage** (`/procurement/reorder`, nav "Smart Reorder
  Planning" first under Purchases): six summary metric cards; supplier-
  wise reorder summary table; product table with status badges, full
  netting columns, checkbox selection (selectable = has a suggestion;
  quantities editable inline), estimated unit cost/value; "Create draft
  POs" opens a **preview dialog** (per-supplier breakdown) and only on
  explicit confirmation calls the EXISTING
  `POST /api/reorder-suggestions/convert` once per supplier — creating
  unpaid `ordered` POs through the existing purchase workflow. Nothing
  auto-submits, no auto-payments.
- Flags surfaced per spec: "No supplier yet" (never purchased) and
  "Missing purchase price" rows are counted and highlighted.
- api/hooks added to the procurement feature (query-key factory,
  invalidation); existing `/reorder` page remains reachable as before.

### Business rules implemented

- One netting rule shared by suggestions + dashboard (spec: "do not build
  a separate, conflicting inventory calculation system").
- Outstanding POs prevent double-ordering (existing rule, now tested at
  the dashboard level too).
- Reserved stock (online holds) and inbound in-transit transfers reduce
  the reorder need.
- The buyer always confirms: multi-select → preview → explicit create;
  quantities editable; below-minimum handling and order-value statuses
  land in Phase 5.

### Test evidence (executed 2026-11-04)

- Backend: tsc clean; `reorderPlanning.integration.test.ts` **7/7** —
  classification + no-invented-quantities, cost-basis estimation +
  supplier groups + suggestion delegation parity, reserved netting
  (10 reserved → available 0), outstanding-PO netting (25 on order →
  healthy), in-transit netting via a real warehouse receive + shipped
  transfer (15 in transit → healthy), status/search filters + pagination
  + validation, second-business isolation. Full suite **393/393** (386 +
  7), including the untouched pre-existing reorder tests against the
  refactored delegation.
- Frontend: **30/30** vitest (4 new dashboard tests incl. "convert
  mutation is never called until the buyer confirms"); `tsc -b` 0
  new-file errors; `vite build` green.

### Known limitations (Phase 4)

- Reserved stock netting is exercised via a direct DB update in tests
  (reserved quantities only arise from online-store reservations).
- Supplier groups use the LAST supplier as the grouping key (no
  preferred-supplier concept exists yet).
- Draft creation currently requires a suggestion (reorder point) or a
  buyer-entered quantity via the selectable rows; low-stock-only variants
  without reorder config are visible but need Phase 5's draft editor for
  ordering.

## 8. Phase 5 — Supplier Order Value Management

Committed history: 1–2 = `316e51b`, 3 = `0b0c81d`, 4 = `6e20830`.

### Backend

- **Order settings editing** — `PATCH
  /api/procurement/suppliers/:supplierId/order-settings`
  (`suppliers.edit`): independent `minimumOrderValue` (supplier's
  requirement) and `targetOrderValue` (business's own goal), enable
  flag, notes. Omitted fields unchanged; explicit nulls clear. Returns
  the full supplier detail. The two values are never derived from each
  other.
- **Order-value status** on dashboard supplier groups (factual, in
  `reorderPlanning.service orderValueStatus`): `below_minimum` (with
  `amountRemaining`), `minimum_reached`, `target_reached`,
  `above_target`, `ready_for_review`. Informational only — nothing is
  blocked, nothing is forced.
- **Supplier filter** on the reorder dashboard
  (`?supplierId=&status=attention`) — powers "add other needed products
  from this supplier" in the draft dialog.
- **`POST /api/purchases` now returns `id`** alongside
  `purchaseOrderNumber` (backward-compatible; promised in Phase 0).

### Frontend

- **SupplierDetailsPage "Order settings" card** — enable switch, minimum
  and target inputs, notes; editable with `suppliers.edit`, read-only
  otherwise.
- **Dashboard groups table** — order-status badge + "Remaining to
  minimum" column.
- **Draft creation dialog upgraded**: per-draft **supplier reassignment**
  (Select over all suppliers — the buyer can change suppliers "where
  appropriate"), per-item quantity/price lines, below-minimum **warning
  panel** ("Below {supplier}'s minimum by ৳X — you can still create this
  draft, or add other products that genuinely need replenishment") with
  **"Show needed products"** — fetches that supplier's other attention
  rows and adds them (with their suggested quantities) to the draft.
  Main table rows gained "Compare prices" links to the variant's
  supplier-comparison page. Nothing auto-submits; below-minimum drafts
  are allowed with the warning, per spec.

### Business rules implemented

- Minimum and target are independent, user-configured, enable/disable-able.
- Order status reports facts (below/at/above) and never judges the
  supplier.
- The buyer always reviews: quantities editable, supplier changeable,
  confirmation explicit; below-minimum proceeds with a visible warning;
  quantities are never auto-increased (suggestions are defaults the user
  edits).

### Test evidence (executed 2026-11-04)

- Backend: tsc clean; `procurementOrderValue.integration.test.ts`
  **7/7** — ready_for_review default, settings saved + surfaced,
  below_minimum with amountRemaining 8500 / above_target classification,
  supplierId filter, negative-value 400 + cashier 403, foreign-tenant
  404 + empty dashboard, purchase `id` in create response. Full suite
  **400/400** (393 + 7).
- Frontend: **32/32** vitest (2 new order-settings permission tests);
  `tsc -b` 0 new-file errors; `vite build` green.

## 9. Phase 6 — Integration QA and acceptance verification

No regressions were discovered in the final verification pass, and no
existing module's code paths were modified except the two intentional
hooks (receive-transaction alert check; `createPurchase` return gains
`id`).

Final verification (all executed 2026-11-04, after the last code change):
- Backend `tsc --noEmit` clean; full suite **400/400** — includes the
  untouched suites for purchases, receiving, payments, returns,
  inventory, transfers, registers, RBAC, locations, tenancy/isolation,
  sales, POS, storefront, subscriptions (67 suites).
- Frontend vitest **32/32**; `tsc -b` 0 errors in new files (pre-existing
  baseline untouched); `vite build` green.
- Migration 0036 applied to `ezpos_test` and dev `ezPos`; every feature
  runs on additive schema only.

Master-prompt acceptance scenarios (§17), each covered by automated
tests:
1. **Product price comparison** → Phase 1 suite: per-supplier latest/
   previous/min/max/weighted-avg with exact math (102.22 / 22.22%).
2. **Wholesale market price check** → Phase 2 suite: quotations persist
   separately, per-unit normalization, source separation, CRUD + audit.
3. **Supplier price increase (৳100 → ৳120 = +20%)** → Phase 3 suite:
   factual `price_increase` notification with exact body/payload, once
   per event, threshold-gated.
4. **Automatic reorder detection** → Phase 4 suite: reorder point/alert
   monitoring, status classification, no double-ordering across
   outstanding POs, reserved and in-transit netting.
5. **Supplier minimum (৳10,000 vs ৳8,000)** → Phase 5 suite + UI:
   `below_minimum` with exact remaining amount and add-needed-products
   flow; below-minimum drafts allowed with a warning.
6. **Business target (৳7,000)** → Phase 5: independent target with
   `target_reached`/`above_target` classification.
7. **Purchase integration** → Phases 4–5: draft creation via the
   existing convert/purchase workflow; receiving, payments, and
   inventory continue to pass their full suites; tenancy isolation
   verified in all five new suites.

## 10. Remaining work (post-feature polish, non-blocking)

- **Nav consolidation**: the legacy `/reorder` suggestions page and the
  new `/procurement/reorder` dashboard both live under Purchases; once
  owners are settled, fold the old page into the dashboard (it keeps
  inline reorder-point editing the dashboard does not have yet).
- **Quotation-only suppliers**: currently visible in Price Check history
  and the observations list but not in the purchase-based supplier
  comparison table (which aggregates received purchases only).
- **Alert channels**: `price_increase` alerts are in-app (bell + SSE);
  email/push would need a delivery channel outside this feature.
- **Trend chart depth**: supplier/variant trend caps at the 200 most
  recent events; a dedicated long-range points query is a candidate if
  owners need multi-year charts.
- **Cross-unit comparison**: quotations normalize per unit only within
  the same variant; a unit-conversion table would be required for
  cross-unit comparisons (deliberately out of scope — no such data
  exists in the schema).
- **Existing businesses' staff roles**: new permission keys
  (`purchases.price_check`, `purchases.manage_price_alerts`) reach staff
  roles of pre-existing businesses only via the Roles UI (owner wildcard
  covers owners automatically); new businesses get them via the manager
  template.
