# Phase 0 — Read-Only Audit & Architecture Proposal
# Percentage-Based Pricing Management System

Branch: `feature/percentage-pricing` (at development `c7ee72a`, migrations 0000–0062)
Date: 2026-11-08
Status: **AUDIT ONLY — no source, schema, or data changes have been made.**
Nothing below is implemented. Implementation starts only after explicit approval.

---

## 0. Governing design principle (user directive, adopted)

> Keep pricing rules separate from actual selling prices. A pricing rule tells
> ezPos how to calculate a price; the product's selling-price field stores the
> currently effective price.

This is adopted as the system's first constraint, and it happens to align with
what the codebase already does at checkout:

- **Rules are configuration.** `pricing_rules` rows (markup % / margin % / fixed)
  only describe *how to compute* a recommended price. They are never read at
  checkout.
- **`product_variants.selling_price` stays the single effective price** that POS,
  storefront, quotes, and reports charge. Nothing in the sale path re-derives it
  from rules.
- **Materialization is explicit.** A rule's recommended price reaches
  `selling_price` only through: a user pressing *Apply*, an approved Mode-A
  proposal, a bulk update, or the opt-in Mode-B auto-update. Every such write
  appends a `product_price_history` row recording old price, new price, source
  rule, and actor.
- **Previews never persist.** Preview endpoints compute from the rule + cost
  provider and return numbers; they write nothing.
- **POS override is an exception path.** Manual price edits at the register
  (today impossible — see §4.1) become a permission-gated `priceOverride` input
  that is snapshotted and audited; they do not touch `selling_price` unless the
  user separately applies it as a price change.

---

## 1. Existing architecture overview (what the audit found)

| Layer | Tech | Notes |
|---|---|---|
| Backend | Express 5 + TS + Drizzle + PostgreSQL | `ezPosBackend/src`, modules pattern `schema zod → service → controller → routes`, mounted under `/api/*` in `app.ts` |
| POS frontend | React 19 + Vite + Tailwind v4 + Zustand + TanStack Query | `pos/src`, feature dirs `features/<domain>/{api,types,hooks,pages,components}` |
| Storefront | Next.js (`ezPosStorefront`) | Reads catalog via backend service; sells at `product_variants.sellingPrice` (`ezPosBackend/src/modules/storefront/storefront.catalog.service.ts:96`) |
| Tenancy | `business_id` everywhere; `X-Business-Id` header verified server-side (`pos/src/api/axios.ts`); location scoping via `requireLocationAccess()` |
| RBAC | `src/rbac/permissions.ts` catalog → `DEFAULT_ROLE_PERMISSIONS` (owner, manager, cashier, accountant + custom roles, wildcard `*`) → `ensureRbacSeed()` upserts at boot (`src/rbac/seed.ts`) → `requirePermission()` middleware |

**Baseline health:** branch is clean at the UOM merge (PR #71). Backend suite was 864/864 green on the merged tree per the UOM program record. Migration numbering: next free is **0063**.

---

## 2. Product & variant pricing flow (audit area A)

### 2.1 Where selling prices live

- **`product_variants.selling_price` — numeric(12,2), NOT NULL** (`src/db/schema/productVariants.ts:34-38`). This is the *only* selling price in the system.
- Products carry **no** price columns (`src/db/schema/products.ts`); a product's "price" is its default variant's price.
- **No cost column exists on variant** — cost is batch-derived (§3).
- **No per-location selling price** exists.
- UOM packaging units (`src/db/schema/productUnitConversions.ts`, migrations 0061/0062) carry optional per-unit `sale_price` / `purchase_price` **prefill/display defaults**; the transaction price is always resolved server-side (§4.1) and stored per-base on `sale_items`.

### 2.2 Every place selling price is written (pricing touchpoints)

1. **Product create** — `src/modules/addProduct/product.service.ts:352-361` (`insert(productVariants)` with `sellingPrice: variant.sellingPrice`).
2. **Product/variant edit** — same file `:899-904` (`update(productVariants)`).
3. **Product patch** — `src/modules/products/products.service.ts:546 patchProduct` (product-level fields only; not variant prices).
4. **Product import** — `src/modules/productImport/importSession.service.ts:668` (create) and `:880` (update-when-non-null). Import writes prices **with no history record** — see risk §12.6.
5. **Duplicate product** — `products.controller.duplicateProduct` copies variant rows.
6. Export path reads it (`import/export.service.ts:98,203`).

### 2.3 Reading prices

- POS catalog / product list: `products.service.ts:399-443` returns variants json with `sellingPrice`; the same query computes a **weighted-average landed cost per variant** from `inventory_batches` (permission-sensitive — cost stripped without `products.view_cost`, see §7.3).
- Storefront catalog: `storefront.catalog.service.ts:96`.
- Sale path: server-side resolution (§4.1) — **client-sent `unitPrice` is ignored**.

### 2.4 Adjacent tables that are *not* selling-price systems

- `price_observations` (`src/db/schema/priceObservations.ts`) = **supplier quotations** for procurement ("Quick Price Check").
- `price_alert_settings` (`src/db/schema/priceAlertSettings.ts`) = purchase-price-increase notifications.
Both are procurement-side and untouched by this program, but the Pricing UI should not confuse them with selling prices.

### 2.5 No price history exists anywhere today

There is no table recording how `selling_price` changed over time. This program introduces it (§13.7).

---

## 3. Cost & landed-cost flow (audit area B) — the authoritative cost source

**Authoritative effective unit cost = `inventory_batches.landed_cost_per_unit`** — a DB **generated column**: `(purchase_price + COALESCE(additional_cost_per_unit, 0))`, both numeric(14,6) (`src/db/schema/inventoryBatches.ts:33-65`). Original purchase price is never mutated; landed costs (freight/customs/adjustments from `modules/landed-cost`, migrations 0058–0060) write `additional_cost_per_unit` per batch.

Flow: purchase → receive (full or partial via `purchase_receiving_records`) creates batches per (variant, location) → landed-cost allocation updates `additional_cost_per_unit` → sale consumes batches **FIFO** per location (`consumeStockFifo`, `src/modules/sales/sales.service.ts:303`) stamping `sale_items.cost_at_sale` (numeric(14,6)). Purchase returns reverse via `modules/purchaseReturn/return.valuation.ts` (batchCarryingValue from the retained pool × landed_cost_per_unit).

**Readers of `landedCostPerUnit`** (all query batches directly; there is no single cost-provider function today): products list valuation, sales COGS, reports (stock/valuation), finance overview & reports (batch-valuation cross-check), stock counts, transfers, purchase returns, barcodes, backups.

**Consequence for the design:** the pricing engine must not re-derive cost. It gets a **`PricingCostProvider`** built on the *already-existing* weighted-average definition — `loadVariantPurchaseCost(businessId, variantId)` (`src/modules/barcodes/barcodes.service.ts:690-709`, same query the products list exposes as `purchaseCost` at `products.service.ts:413-426`): `Σ(landed_cost_per_unit × quantity_remaining) / Σ quantity_remaining` over on-hand batches. The provider offers (a) variant-level global cost and (b) the same average filtered by location (cost is per-location; the products-list query is global), and returns an explicit **"cost unavailable"** result when no priced batches exist — **no silent zero** (master prompt Part 8 satisfied by wrapping, not duplicating). Preview-vs-sale nuance to document in the UI: recommended prices derive from the on-hand weighted average, while actual COGS remains per-location FIFO at sale time — the profit variance that implies is inherent to FIFO and unchanged by this feature.

**Costing method (documented):** FIFO batch consumption by batch id, per location, FOR UPDATE row-locked (`consumeStockFifo`, `sales.service.ts:303-389`); sale lines stamp the blended per-base `cost_at_sale` with per-batch detail in `sale_item_batch_consumptions`; refund restocks create `RETURN-*` batches at `cost_at_sale`; transfers ship at landed cost and receive into `TRF-*` batches at the shipped unit cost; purchase returns remove inventory at full landed carrying value while the supplier credit excludes landed additions, reconciled by the landed-cost reversal (`lifecycle.ts:1318-1466`). There is **no weighted-average costing system** — averages are read-side display/valuation only. Finance already cross-checks GL 1050 against `Σ quantity_remaining × landed_cost_per_unit` (`finance.reports.service.ts:578`); pricing never writes cost, so that invariant is untouched.

---

## 4. Sales & POS pricing flow (audit area C)

### 4.1 Checkout pipeline (verified, current behavior)

```
POS cart (client)                    quote POST /sales/quote          createSale POST /sales
  variantId, qty, uomConversionId  →  resolveTaxRulesForSale         →  tx:
  discount per line                   + normalizeSaleItemsToBase          idempotency check (payload-hash bound)
  cart discount                       + getCartTotalsWithTaxRules         validateVariants (FOR UPDATE row locks)
  vatPercent | couponCode             + coupon evaluation                 normalizeSaleItemsToBase   ← prices resolved HERE
                                    →  server totals                     validateStock
  POS displays quote result            (local math only as offline        getCartTotals[WithTaxRules]  ← totals recomputed HERE
   (fallback when offline)             fallback)                          coupon evaluation (XOR cart discount, FOR UPDATE)
                                                                       validatePayments vs finalTotal
                                                                       insert sale + items (snapshots) + batch consumption
                                                                       coupon_redemptions + used_count++
```

**Key verified facts:**

1. **Prices are already server-authoritative.** `normalizeSaleItemsToBase` (`src/modules/sales/sales.uom.ts:104-186`) sets base-unit `unitPrice = Number(variant.sellingPrice)` from the DB-locked variant row; UOM lines resolve `conversion.sale_price ?? round2(factor × variant.selling_price)`. The `unitPrice` field in the request `Items` type (`sales.validation.ts:34-45`) is accepted **but ignored**. The comment at `sales.service.ts:879` ("trusted prices … come from the database") is accurate — my initial read of it was wrong and was corrected by tracing `normalizeSaleItemsToBase`.
2. **There is no manual unit-price override at checkout today.** The only per-line flexibility is the `discount` field; `pos.apply_discount` gates line-level discounts (403 without it — `src/modules/sales/sales.controller.ts:55-60`). Cart-level discounts and coupons are similarly server-evaluated.
3. **Calculation order** (`src/modules/sales/utils/cartPricing.ts`): line base = price × qty → line discount → cart discount (pro-rata allocation per line, last line absorbs rounding) → tax. Legacy `vatPercent` engine vs rules engine are mutually exclusive (never mixed — would double-tax).
4. **Coupons** (`src/services/coupons.ts:61 evaluateCouponInTx`, shared by quote AND createSale): percentage|fixed, validity window, min order, max discount, usage + per-customer limits, FOR UPDATE on redemption, `coupon_redemptions` unique per sale. **v1 stacking rule: coupon XOR cart-level discount** (both → 400). Coupons are *not* customer-group scoped today.
5. **Held carts** (`src/db/schema/heldSales.ts`) store a slim snapshot (variantId, qty, discount, serials, UOM ids) under an explicit **not-trusted-prices contract**: resume re-resolves prices/stock live. Compatible with this system by construction.
6. **Refunds/exchanges** work from immutable `sale_items` snapshots; exchange replacement lines go through the same normalization (`sales.service.ts:2508`).
7. **Sale header snapshots** (`src/db/schema/sales.ts`): `subtotal`, `discount` (**conflates line + cart discounts** — see risk §12.1), `vat`, `finalTotal`, `dueAmount`, `paymentStatus`, invoice number from `document_sequences`. **Sale-item snapshots** (`saleItems.ts`): `selling_price` (14,6 per-base), `discount`, `cost_at_sale`, `tax_amount` + `tax_detail` jsonb, UOM snapshot columns.
8. **Customer change repricing plumbing already exists:** `quoteSaleApi` payload already carries `customerId` (`pos/src/features/pos/quote.api.ts:39`), so "recalculate when customer changes" rides the existing quote loop.

### 4.2 VAT/tax flow

Rules-based (`tax_rates` exclusive/inclusive + `product_taxes`, Module 4): per-line, per-rule snapshot into `sale_items.tax_detail`; editing/deactivating a rate never rewrites history. Any customer-group/promotion discount introduced by this program must be applied **before** tax (they discount the pre-tax base), which matches the existing pipeline.

---

## 5. Customer architecture (audit area D)

`customers` (`src/db/schema/customers.ts`) is minimal: name, phone, email, address, `client_uuid`, timestamps. **There is no customer group, segment, tier, price level, or per-customer pricing anywhere** (schema and module greps; customer CRUD in `modules/customers`; sales link via nullable `sales.customer_id`). Wholesale/VIP-style pricing is a genuinely new capability; the master prompt's Part 6 is greenfield here, and the schema proposal (§13.3/13.4) creates the group concept with a "General" default.

---

## 6. Reporting architecture (audit area E)

Report services: `modules/reports/reports.service.ts` (27 report functions) + `dashboardMatrix.service.ts` + `modules/sales/sales.service.ts:2094 getDashboardSummary` + `modules/reports/onlineProfitability.service.ts`.

**All profit math uses historical `sale_items` snapshots**, never live product prices:

- `getProfitReport` (:491) / product profitability (:527): `SUM((selling_price − cost_at_sale) × qty)`, with refund money/restocked-cost corrections (:494-497, :563).
- Dashboard (:98,166) and location comparison (:1661) same formula.
- Shrinkage (:1340): uses `purchase_price`, with a **`selling_price × 0.7` fallback when no batch exists** (:1374) — a pre-existing approximation to note, not touch.

**Impact of this program on reports:**

- **Unaffected by price materialization** (they read snapshots) — applying new prices cannot rewrite history. ✔
- **Need new inputs** for the new dimensions: group profitability, promotion performance, price-change reports. Requires per-line adjustment snapshots (§13.8) and a `sales.customer_group_id` snapshot, because the header `discount` column conflates line+cart discounts and cannot attribute group/promotion discounts.
- Tax reconciliation, receivables, payables, stock, aging: untouched.

---

## 7. Authorization (audit area F)

### 7.1 Existing permission keys relevant to pricing

| Key | Meaning today |
|---|---|
| `products.edit` | changes variant selling prices (create/edit/duplicate/import paths) |
| `products.view_cost` | gate for cost data on catalog/import/export responses |
| `pos.apply_discount` | line-level discounts at checkout (403 without it) |
| `promotions.view` / `promotions.manage` | coupons CRUD |
| `taxes.view` / `taxes.manage` | tax rates & product tax assignment |
| `reports.profit.view`, `finance.profit.view` | profit/margin reports |

### 7.2 Role model

System roles per business: **owner, manager, cashier, accountant** (`src/rbac/permissions.ts:369-382`) + custom roles; wildcard `*` supported (:200). Cashier today gets neither `products.view_cost` nor profit reports (:328 cost is manager+; :357 accountant/manager+). Role templates live in `DEFAULT_ROLE_PERMISSIONS` (:211).

### 7.3 Enforcement & sanitization conventions

- Route chains: `requireAuth → requireBusinessContext() → requireLocationAccess() → [requireFullAccess] → requirePermission(key)` (`modules/products/products.routes.ts:15-21` pattern).
- **Cost sanitization exists:** `stripCostData()` (`src/rbac/sanitize.ts`) strips cost fields from catalog payloads for callers without `products.view_cost`. The pricing UI reuses this — cost columns in Pricing pages are permission-controlled, and the PricingCostProvider's output must never be serialized to a caller lacking the cost permission.
- Adding a permission end-to-end (verified procedure): (1) append the key to `PERMISSION_CATALOG` **and** to the relevant role arrays in `DEFAULT_ROLE_PERMISSIONS` (`src/rbac/permissions.ts`) — but note roles are created per business, so this only affects *future* businesses; (2) **the migration must retro-grant** the key to existing businesses' roles via `INSERT INTO role_permissions … SELECT … JOIN permissions` — exact precedent `drizzle/0039_expense_payments_foundation.sql:136-161`, because `ensureRbacSeed()` (`src/rbac/seed.ts`, called at `server.ts:18`) inserts *keys only*, never grants; (3) enforce with `requirePermission(key)` after the read/write chain (`middleware/permissions.ts` — wildcard-aware, 403 constant body); (4) mirror the key in the frontend catalog `pos/src/lib/rbac.ts` (feeds the Roles matrix) + nav `permission:` fields + `<RequirePermission>` route wrappers.

---

## 8. Frontend architecture (audit area G)

- **Nav:** `pos/src/config/navigation.ts` — sectioned sidebar, each item with `permission:`/`anyPermission:`; sections include Dashboard, POS, Reports, Inventory, Sales, Contacts, Expenses, **Finance & Growth** (the newest exemplar), Procurement, Promotions, Locations, Attendance, Users, Roles, Taxes, Backups, Receipt settings. A new **Pricing** section slots beside Promotions/Taxes.
- **Routes:** `pos/src/routes/AppRoutes.tsx` (flat route list, permission-wrapped).
- **API layer:** `pos/src/api/axios.ts` (in-memory access token, `X-Business-Id` + location + terminal headers, silent refresh). Feature pattern: `features/<domain>/xxx.api.ts` + `xxx.types.ts` + `hooks/useXxx.ts` (TanStack Query key factories) + `pages/` — the finance feature (`features/finance/`) is the canonical exemplar, including `finance.wiring.test.ts` vitest wiring tests.
- **POS cart:** `features/pos/stores/useCartStore.ts`; totals via quote endpoint with local-math fallback (`features/pos/quote.api.ts`).
- **Existing pricing-adjacent UI:** product table price columns, product form price fields, Coupons page (`/coupons`), Tax Rates page (`/tax-rates`), procurement price monitoring (supplier-side). No pricing-rules UI exists.

---

## 9. Files & functions that will require modification (implementation map)

**New backend module** `ezPosBackend/src/modules/pricing/`:
`pricing.engine.ts` (pure math: markup/margin/rounding/margin-guard), `pricing.rules.service.ts` (CRUD + resolution), `pricing.costProvider.ts`, `pricing.apply.service.ts` (materialize/bulk/proposals/auto-sweep), `customerGroups.service.ts`, `promotions.service.ts` (+ evaluation), `pricing.history.service.ts`, `pricing.controller.ts`, `pricing.routes.ts`, `pricing.validation.ts`.
New schema `src/db/schema/pricing.ts`; new migrations `drizzle/0063_pricing_foundation.sql` (+ follow-ups per phase).

**Modified backend:**
- `src/rbac/permissions.ts` (new keys + role templates) **+ the RBAC retro-grant migration section** (permission-row inserts + `role_permissions` backfill for existing businesses, per the `0039` precedent)
- `modules/sales/sales.service.ts` — `quoteSaleTotals` (:2840) and `createSale` (:821): insert the pricing layer **after** `normalizeSaleItemsToBase` (group discount → promotion evaluation mirroring the coupon pattern), stamp snapshots, minimum-price validation
- `modules/sales/sales.validation.ts` — optional `priceOverride` + reason on Items; payload-level stacking flags rejected from clients
- `modules/sales/sales.controller.ts` — `pricing.price_override` check beside the existing `pos.apply_discount` gate (:55-60)
- `services/coupons.ts` — stacking interplay (group discount coexists; coupon XOR *manual* cart discount unchanged)
- `modules/customers` — group assignment on customer CRUD
- `db/schema/customers.ts`, `db/schema/sales.ts`, `db/schema/saleItems.ts`, `db/schema/productVariants.ts` (additive columns only)
- `app.ts` — mount `/api/pricing/*`
- `modules/productImport/importSession.service.ts` — optional: record history on import-driven price writes (decision point, §17)

**New frontend** `pos/src/features/pricing/` + edits to `config/navigation.ts`, `routes/AppRoutes.tsx`, product pages (pricing-source column), POS cart (discount breakdown display; price-override UI for permitted roles), receipt/invoice rendering of adjustment breakdown.

**Not modified:** `inventoryBatches`/landed-cost/purchase modules (cost consumed read-only via provider), reports formulas, tax engine, refund/exchange math, storefront pricing (inherits effective price automatically).

---

## 10. Reusable existing components/services

| Asset | Reuse |
|---|---|
| `getCartTotalsWithTaxRules` + quote endpoint | discounts layer slots in ahead of tax; quote stays the single preview surface for checkout |
| `evaluateCouponInTx` pattern (shared quote+createSale, FOR UPDATE redemption) | template for promotion + group-discount evaluation |
| `posSettings` singleton-per-business pattern (`db/schema/posSettings.ts`) | `pricing_settings` follows it exactly |
| `roundMoney` (`utils/roundMoney.ts`), poisha utils (`utils/money.ts`), micros math (`modules/uom/uom.money.ts`) | engine arithmetic conventions |
| `stripCostData` + `products.view_cost` | cost visibility in pricing UI |
| `document_sequences`, audit service (`services/audit.ts`), notifications (`notifyInTx` dedupe) | proposal batching, override auditing, below-minimum alerts |
| Weighted-avg landed-cost query — `loadVariantPurchaseCost` (`barcodes.service.ts:690-709`) and the products-list subquery (`products.service.ts:413-426`) | extracted into PricingCostProvider |
| Finance frontend feature structure | Pricing module structure |

---

## 11. Missing functionality (gap list vs master prompt)

1. No pricing rules (markup/margin) of any kind. 2. No customer groups. 3. No auto-applied promotions (coupons only; the gap-closure program explicitly deferred the auto-promotions engine). 4. No price previews. 5. No price history/audit of price changes. 6. No minimum-price/profit protection (discounts can silently go below cost). 7. No manual price override at POS (client price is ignored; only discounts possible). 8. No bulk price update. 9. No cost-triggered price proposals or auto-update. 10. No configurable rounding. 11. No UOM-aware price derivation from rules (packaging prefill prices are manual). 12. Import writes prices without history.

---

## 12. Data integrity risks (must-read before approval)

1. **`sales.discount` conflates line + cart discounts** (`sales.service.ts:938-940`). Group/promotion discounts must be snapshotted separately (`sale_items.price_adjustments` + attribution ids) or group-profitability and promotion-performance reports will double-count.
2. **Coupon XOR cart-discount rule** must be re-specified once group discounts (automatic) exist: proposed rule — group discount always applies; coupon XOR *manual* cart discount unchanged; promotions stack only where configured.
3. **Margin ≥ 100% is a division-by-zero** in `Cost / (1 − margin/100)`. Guard in the engine *and* DB CHECK on rule rows; reject at validation like coupons do for >100 percentage.
4. **Two rounding conventions coexist** (2-dp `roundMoney` vs 6-dp per-base UOM grid vs poisha integer ledger math). Rule: intermediate math in integer micros/poisha (uom.money.ts style), `roundMoney` only at the final materialization stage; never round repeatedly.
5. **`sale_items.selling_price` is 6-dp per-base** while `product_variants.selling_price` is 2-dp; UOM package prices derive at sale time. Price history records the **variant field** (the effective price), not derived per-base figures.
6. **Product import writes prices silently** (`importSession.service.ts:880`). Either route import price changes through history (recommended) or document the exception — a decision point for approval.
7. **Category hierarchy** (`categories.parent_id`): a parent-category rule and a child-category rule must have deterministic precedence (proposal: nearest ancestor wins), and only **one active rule per scope** is enforced by partial unique indexes (§13.2) to make ambiguity impossible rather than adjudicated.
8. **Materialization races:** auto-update sweep vs manual edit vs concurrent applies → all price writes transactional, variant row locked FOR UPDATE, Mode-B runs deduped by an in-flight marker (entitlements advisory-lock pattern exists to copy).
9. **Minimum-price enforcement point:** quote *and* createSale must both validate (server-authoritative, like payments validation); offline terminals inherit the policy via existing offline sale rules (below-minimum sales only via `pricing.below_minimum_override` roles, audited).
10. **Tenant isolation:** every new table carries `business_id` with composite `(id, business_id)` FKs, matching `product_variants_id_business_uq` conventions.
11. **Zero-cost fallbacks are forbidden** in pricing (unlike the shrinkage report's `0.7 × price` fallback, which stays out of scope): cost-unavailable → explicit error/proposal, never price-from-nothing.
12. **Storefront symmetry:** storefront charges `selling_price` directly; group discounts/promotions apply only where the storefront checkout path is explicitly extended (v1: storefront keeps base prices; documented limitation).
13. **Pre-existing cost inconsistencies — noted, out of scope:** manual stock adjustments price `ADJ-*` batches from `purchase_price × quantity_remaining` instead of `landed_cost_per_unit` (`products.service.ts:265-277`), diverging from the other three weighted-average call sites; the shrinkage report's `selling_price × 0.7` no-batch fallback (:1374). Pricing does not rely on either, but the PricingCostProvider must use the canonical `landed_cost_per_unit` average, and these divergences are flagged for a future cleanup program.
14. **Walk-in customers:** `sales.customer_id` NULL = walk-in; a sale with due > 0 and no customer is rejected (`sales.validation.ts:213`). Group discounts apply only to customers **with** a group; walk-ins always get base prices.

---

## 13. Proposed database design (NO MIGRATIONS GENERATED YET)

All tables business-scoped (`business_id → businesses.id`), composite `(id, business_id)` FKs where children reference them, `created_at/updated_at` timestamps, money numeric(12,2) mode:"number" (matches variants/coupons), percentages numeric(6,3) (matches `tax_rates.rate`), costs numeric(14,6) (matches batches). **Additive only. No existing column is altered or backfilled.**

### 13.1 `pricing_settings` — singleton per business (posSettings pattern)
`default_method` (`fixed`|`markup`|`margin`, default `fixed`), `default_percentage` numeric(6,3), `rounding_increment` (`none`|`0.01`|`1`|`5`|`10`), `rounding_direction` (`nearest`|`up`|`down`), `auto_update_enabled` bool default false (Mode B opt-in), `auto_update_fixed_prices` bool default false (never overwrite manually-managed fixed prices unless explicitly enabled), `min_margin_percent` numeric(5,2) nullable (business-wide floor), timestamps.

### 13.2 `pricing_rules` — the hierarchy
`scope` via nullable FKs with a CHECK that exactly one level is set: `category_id` / `product_id` / `variant_id` (all NULL = global), `method` (`markup`|`margin`|`fixed`), `percentage` numeric(6,3) nullable, `fixed_price` numeric(12,2) nullable, `is_active` bool, timestamps.
CHECKs: `method='fixed' ⇔ fixed_price IS NOT NULL AND percentage IS NULL`; `method IN ('markup','margin') ⇒ percentage NOT NULL AND 0 ≤ percentage AND (method ≠ 'margin' OR percentage < 100)`; method ≠ 'fixed' ⇒ fixed_price IS NULL.
**Deterministic precedence enforced by partial unique indexes** (ambiguity impossible):
- `uq_pricing_rule_global`: `(business_id) WHERE is_active AND all scope FKs NULL`
- `uq_pricing_rule_category`: `(business_id, category_id) WHERE is_active AND product/variant NULL`
- `uq_pricing_rule_product`: `(business_id, product_id) WHERE is_active AND variant NULL`
- `uq_pricing_rule_variant`: `(business_id, variant_id) WHERE is_active`
Resolution order: **variant → product → nearest category ancestor → global**, first active hit wins; missing/inactive falls through exactly as master prompt §5.4 requires.

### 13.3 `customer_groups`
`name`, `description`, `is_default` bool (the implicit "General"), `is_active`, timestamps; `UNIQUE (business_id, name)`. Created lazily (no data backfill in the migration).

### 13.4 `customer_group_pricing` — Part 6 discounts
`group_id → customer_groups`, nullable `category_id`/`product_id`/`variant_id` (XOR CHECK — NULL/NULL/NULL = whole-cart rule), `discount_type` (`percentage`|`fixed`), `discount_value`, `min_purchase_amount`, `min_quantity`, `max_discount_amount` nullable, `valid_from`/`valid_to` date nullable, `stacks_with_promotions` bool default false, `is_active`, timestamps.

### 13.5 `customers.customer_group_id` — new nullable FK column (additive). NULL = no group pricing.

### 13.6 `pricing_promotions` — Part 7 auto-applied promotions
`name`, nullable scope FKs (variant/product/category XOR), `discount_type`, `discount_value`, `starts_at`/`ends_at` timestamps nullable, `min_quantity`, `min_order_value`, `max_discount_amount` nullable, `can_stack_with_group_discount` bool default false, `can_stack_with_coupons` bool default false, `is_active`, timestamps. + `promotion_customer_groups` join table (NULL membership row = all groups eligible). Server-side date validation mirrors `evaluateCouponInTx`. (Coupons remain untouched; promotions are the auto-applied sibling.)

### 13.7 `product_price_history`
`variant_id` (composite FK), `old_price`, `new_price` numeric(12,2), `source` (`manual`|`rule_apply`|`proposal`|`auto_update`|`bulk`|`import`|`override`), `rule_id` nullable FK, `proposal_id` nullable FK, `cost_at_change` numeric(14,6) nullable, `reason` text nullable (mandatory for below-minimum overrides), `changed_by_user_id` nullable, `created_at`. Index `(business_id, variant_id, created_at)`.

### 13.8 Sale snapshot extensions (additive columns)
- `sale_items.price_adjustments` jsonb default `[]` — ordered list `{kind: 'group'|'promotion'|'manual'|'coupon', refId, name, amount}` preserving application order and amounts (the audit trail reports need; header `discount` untouched).
- `sales.customer_group_id` nullable (group at sale time — group profitability without joining live memberships).

### 13.9 `price_change_proposals` — Mode A
`variant_id` composite FK, `batch_token` varchar (groups one sweep run), `old_cost`/`new_cost` numeric(14,6), `old_price`/`recommended_price` numeric(12,2), `percent_change` numeric(6,2), `status` (`pending`|`approved`|`rejected`|`applied`|`stale`), `rule_id` nullable, `decided_by` nullable, timestamps. `stale` marks proposals whose cost/price moved after generation.

### 13.10 Variant minimum-price protection
`product_variants.min_selling_price` numeric(12,2) **nullable additive column** (protection metadata, not a rule — lives beside the price it protects). Business-wide floor in `pricing_settings.min_margin_percent`. Checkout: price below minimum → warn always; block unless caller holds `pricing.below_minimum_override`, then record user/time/old/new/reason.

**Rollback story:** every change is a new table or nullable column with default — `DROP TABLE` / `DROP COLUMN` restores exactly; no data rewrite occurs at any point.

---

## 14. Proposed backend API (shapes follow `{success, data}` + `sendSafeError` conventions)

```
/api/pricing/settings        GET/PUT                    pricing.view / pricing.manage
/api/pricing/rules           GET/POST  /:id PUT/DELETE  pricing.manage      (preview: POST /api/pricing/preview {variantIds[]} → per-variant {cost?, method, source, recommended, applied})
/api/pricing/products/:variantId/price  GET (effective + source + recommended) / PUT (materialize)
/api/pricing/bulk            POST (filter → dryRun preview | apply)      pricing.bulk_update
/api/pricing/history         GET (variant filter, paginated)             pricing.history.view
/api/pricing/proposals       GET / POST :id approve|reject / POST bulk-approve
/api/customer-groups         CRUD + membership (customers.group_id)      pricing.customer_groups.manage (view: customers.view)
/api/promotions              CRUD (auto-applied; coupons API unchanged)  promotions.manage (reuse)
```
Price materialization endpoint flow mirrors master prompt Part 15: zod → auth → business → permission → rule resolution → cost resolution → engine → min-price validation → transaction (variant FOR UPDATE) → history row → audit → response.
Envelope/pagination conventions (verified mixed codebase): new-module reads return `{ success: true, data }`; paginated lists return `{ rows, meta: { page, pageSize, total, totalPages } }` (finance pattern, zod `page`/`page_size` defaults 1/25 max 100); all errors through `sendSafeError(res, err, fallback)`; creates return 201 with the row. Routers declare full `/api/...` paths and are mounted flat (`app.use("/", pricingRouter)`) in `app.ts`.

---

## 15. Proposed frontend module

`pos/src/features/pricing/` (finance-feature pattern): `pricing.api.ts`, `pricing.types.ts`, `hooks/usePricing.ts`, `pages/` — Pricing Dashboard, Settings, Rules (global/category), Product & Variant Pricing matrix (cost column behind `products.view_cost`, pricing-source badge "inherited from category X" / "override", preview on entry), Customer Groups, Promotions, Price History, Proposals review (Mode A), Bulk Update wizard (filter → preview table → apply).
Nav: new **Pricing** section in `config/navigation.ts`; routes in `AppRoutes.tsx`. POS cart: show per-line adjustment breakdown from quote response; customer switch already triggers re-quote; price-override UI (long-press/context menu on line) visible only with `pricing.price_override`, reason prompt when below minimum.
Conventions verified: query-key factory per feature (`financeKeys` pattern in `features/finance/hooks/useFinance.ts`), `@tanstack/react-table` data-tables, react-hook-form + zodResolver dialogs, `toast.add`/`createEntityPromiseToast`, `PermissionGuard`/`PermissionButton`/`RequirePermission` (`components/common/PermissionGuard.tsx`), a **pricing wiring test** asserting backend↔frontend key parity + nav gates (template `features/finance/finance.wiring.test.ts`). **Caveat:** do not copy `features/finance/finance.api.ts`'s import — it uses bare `axios` instead of the shared instance (`@/api/axios`); use the shared instance. A shared `formatCurrency` util does not exist (per-feature `Intl.NumberFormat("en-BD")` helpers) — the pricing feature should add one small helper rather than another local copy.

---

## 16. Testing strategy (maps to master prompt Part 18)

**Unit (`pricing.engine.test.ts`)** — the 20 mandated cases: markups 10/20/30%; margins 20/50%; margin ≥ 100 rejected; fixed price; category inheritance; product override; variant override; global fallback; customer percentage discount; fixed discount; stacking order; max-discount cap; each rounding mode; minimum-price warning/block; negative-profit flag; missing-cost → explicit unavailable; decimal precision (poisha/micros invariants).
**Backend integration (Node built-in test runner via `tsx --test`, suites in `src/test/*.integration.test.ts`)** — double guard `INTEGRATION_TESTS=1` + `DATABASE_URL` with fail-closed `ezpos_test` assertion; fixtures `src/test/helpers/fixtures.ts` (`createOwnerCtx`, `authHeaders`, `postJson/getJson`), ephemeral-port `buildApp().listen(0)`; auth rate limits auto-relax under `INTEGRATION_TESTS=1` (`config/env.ts:55-62`):
`pricingApi.integration.test.ts` (rules CRUD, partial-unique conflicts, tenant isolation, RBAC matrix incl. retro-grant verification), `pricingPos.integration.test.ts` (quote+createSale with group discount, promotion stacking configs, price-override permission matrix, below-minimum block/override-audit, customer change repricing, UOM line + group discount combined, coupon interplay), `pricingApply.integration.test.ts` (materialize→history, bulk, proposals approve→apply, Mode-B sweep + duplicate-run prevention, purchase-cost change → proposal), `pricingReports.integration.test.ts` (group profitability + promotion performance from snapshots; profit report unchanged vs pre-feature fixtures).
**Regression:** full backend suite must stay green (864 baseline); POS vitest (vitest + MSW setup, `pos/src/test/`) + existing quote/coupon suites keep semantics; new frontend wiring tests mirroring `finance.wiring.test.ts`.

---

## 17. Migration & backward-compatibility plan

- Migration **0063** (foundation: settings, rules, groups, group pricing, promotions + join, history, proposals + additive columns `customers.customer_group_id`, `sale_items.price_adjustments`, `sales.customer_group_id`, `product_variants.min_selling_price`). Later phases add only indexes/tables if genuinely needed.
- **Zero behavior change on deploy:** with no rules/groups/promotions rows, `normalizeSaleItemsToBase` prices are unchanged, totals unchanged, receipts unchanged; empty `price_adjustments` renders nothing on receipts.
- **No data backfill** except optional lazy "General" group creation; historical sales never touched; reports keep reading existing snapshots.
- Hand-written SQL validated with `psql -1 -v ON_ERROR_STOP=1` before drizzle apply (known silent-skip gotcha); journal bookkeeping per the finance-program note.
- **Open decision points for you:** (a) product-import price writes — route through history (recommended) or document as exception; (b) storefront: keep base prices in v1 (recommended) or extend checkout to groups/promotions later; (c) category rules on ancestor categories — nearest-ancestor resolution (recommended) vs direct-category-only in v1.

---

## 18. Phased implementation plan (order per master prompt Part 19)

| Phase | Scope | Gate |
|---|---|---|
| **1** | `pricing.engine` (pure, poisha/micros math) + `pricing_settings` + `PricingCostProvider` + preview endpoint; unit tests | engine 20 cases green |
| **2** | `pricing_rules` global + category, rule CRUD API, materialize-to-selling-price + history | precedence tests green |
| **3** | Product/variant rule overrides, Pricing matrix UI, inheritance source display | override tests + UI |
| **4** | Customer groups + group pricing + quote/createSale integration + snapshots + customer-change re-quote | POS integration tests |
| **5** | `pricing_promotions` engine + stacking policy + eligibility + eval in quote/createSale | stacking matrix tests |
| **6** | POS price override (`pricing.price_override`, reason, audit) + minimum-price protection (block/warn/override) + receipt discount breakdown | permission matrix tests |
| **7** | Price history UI/report, group profitability, promotion performance; report regression pass | reports tests |
| **8** | Bulk update wizard + Mode A proposals + Mode B auto-update sweep (advisory-lock dedupe, fixed-price protection flag) | sweep/concurrency tests |

Each phase ships: files changed, DB changes, API changes, frontend changes, tests, results, known limitations. No phase starts while a critical issue is open.

---

## 19. Acceptance-criteria traceability (master prompt Part 20)

1–4 rules & overrides → §13.2/§18 P2-P3 · 5 markup≠margin + margin<100 → §13.2 CHECKs · 6-8 groups/promotions/stacking → §13.4-13.6, §12.2 · 9 cost integration → §3 provider · 10 rounding → §13.1, engine · 11 minimum protection → §13.10 · 12 override permissions → §18 P6 · 13 backend-authoritative POS → §4.1 (already true for base price; extension re-verified) · 14-15 snapshots/historical invoices → §6, §13.8 · 16 isolation → §12.10 · 17 history → §13.7 · 18 existing POS intact → §17 zero-change deploy · 19 tests → §16 · 20 no unauthorized DB changes → this document is the only artifact produced in Phase 0.

---

**STOP — awaiting explicit approval.**
Per the master prompt, no code edits, no migrations, and no data changes occur until you approve this report (or a revised version of it). Approval should specifically cover: the schema in §13 (including the three open decision points in §17), the permission keys implied by §14, and the phased order in §18.
