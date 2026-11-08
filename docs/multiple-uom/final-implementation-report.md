# ezPos — Multiple Units of Measure & Packaging Conversion: Final Implementation Report

**Branch:** `feature/multiple-units-of-measure` — commits `39b6cd9` (Phase 1), `853e09d` (Phase 2), `19bbb71` (Phase 3), `c98d520` (Phases 4–6 backend), `c347798` (frontend). Audit report: `docs/multiple-uom/phase-0-audit-and-architecture.md`.

**The core invariant, everywhere:** every stored quantity and stored per-unit cost/price keeps today's meaning — BASE units (the product's `unit_id`). The unit the operator typed lives only in nullable snapshot columns. The product's existing unit IS its base unit; existing stock needed zero backfill; products with no packaging rows behave bit-for-bit as before (identity factor 1).

---

## 1. Features implemented

- Product-level + variant-override packaging configuration (direct-to-base conversion factors, purchase/sale availability, default unit flags, per-unit default prices).
- Purchases entered in packaging units (create, partial receiving incl. explicit cross-unit, over-receive tolerance in base, short-receive/cancellation math untouched, purchase returns in the original or an authorized equivalent unit).
- POS selling in packaging units (unit picker, mixed Box+Piece carts, server-authoritative pricing, stock validation on aggregated base demand, held carts with entered units, receipts showing entered units).
- Package barcodes (alias-level qualifier; scan adds one package; per-unit labels).
- Partial sales returns ("3 of the 12 pieces of a box") with a returned-quantity ledger; partial serial returns require explicit serial selection.
- Landed cost works unchanged over base quantities (batch-authoritative costs verified by tests).
- Unit-aware read surfaces: sale receipts, sold products, product-sales report, purchase details, export.
- Decimal-safe conversion math (BigInt micros, same discipline as the landed-cost allocator).

## 2. Database tables and columns added or changed

**New table** `product_unit_conversions` (0061): id, business_id, product_id, variant_id (NULL = product-level), unit_id, conversion_factor numeric(14,6), is_purchase_enabled, is_sale_enabled, is_default_purchase, is_default_sale, sale_price numeric(14,2), purchase_price numeric(14,2), status, timestamps. Unique `(product_id, COALESCE(variant_id,0), unit_id)`; partial unique default-flag indexes; composite `(id, business_id)` FK target; tenant-enforcing FKs to products/variants/units (plus `units_id_business_uq`).

**Snapshot columns** (0062) on `purchase_items`, `sale_items`, `purchase_receiving_records`, `purchase_return_items`: `uom_conversion_id`, `entered_quantity` numeric(12,3), `entered_unit_price` numeric(14,6), `conversion_factor` numeric(14,6) + factor-presence CHECKs + composite FKs. `variant_barcode_aliases.uom_conversion_id`.

**Precision widenings** (0062, value-preserving): `sale_items.selling_price` & `cost_at_sale`, `purchase_items.unit_cost`, `inventory_batches.purchase_price`, `purchase_return_items.unit_price` → numeric(14,6). The three generated columns (`purchase_items.total`, `inventory_batches.landed_cost_per_unit`, `purchase_return_items.line_total`) were dropped and recreated with identical expressions (PG cannot ALTER TYPE under a generated column).

## 3. Migrations created and approval status

`0061_product_unit_conversions.sql`, `0062_uom_transaction_snapshots.sql` (journal `when` monotonic). The user authorized implementation without further approvals ("complete the feature, do not wait for my approval"). Applied to `ezpos_test` via drizzle-kit; **dev/prod databases are NOT migrated yet** — run `npm run db:migrate` on each environment (Windows machine included, per established practice). Zero-touch: no existing row is read or rewritten by either migration.

## 4. API endpoints

New: `GET/POST /api/product/:productId/uom`, `PATCH /api/product/uom/:conversionId`, `POST /api/product/uom/:conversionId/deactivate`, `GET /api/variant/:variantId/sell-units`, `GET /api/variant/:variantId/purchase-units`, `POST /api/uom/resolve` (permissions: products.view/edit, sales.view; location-aware).
Extended: sale create/quote/exchange items, held-sales items, purchase create items, receiving items, purchase-return items (all optional `uomConversionId` + entered quantities); barcode assign (alias `uomConversionId`) and lookup (`unit` context); sold-products + receipt payloads (entered-unit fields); product-sales report (`unitLabel`); product export (`package_units` column).

## 5. Frontend pages and components modified

pos app: Units & Packaging section (AddProductPage), products table stock label; POS cart (unit chip + switcher `UnitSwitcher`, base-delta stock bookkeeping, unit-scoped quantity actions, scan-to-cart packages, hold/resume re-derivation, IndexedDB persistence), checkout/quote payloads, receipt renderer ("1 Box (= 12 pcs)"); Purchases (unit column + conversion hints, receiving in the line's unit with serials locked to base, purchase return unit selector, details drawer entered-primary display); Barcodes (package-alias assignment, "Box of 12" on labels); Product-sales report unit label; dashboard "pcs" removed. Single-unit products are pixel-identical to before.

## 6–7. Purchase and POS workflow changes

Purchase line: entered `quantity`/`purchasePrice` per selected unit → stored base `quantity`/`unitCost` (÷ factor, 6-dp) + snapshots; financials computed from ENTERED values (exact line money); DB-generated `total` reconciles (base × per-base). Receiving normalizes once at the boundary (`normalizeReceiveItemsToBase`): outstanding/tolerance/batch-sum/serial-count rules untouched; batch `purchase_price` = entered session cost ÷ factor. Sales: same boundary (`normalizeSaleItemsToBase`); FIFO consumption, batch-consumption ledger, COGS, GL untouched; per-entered-unit price = `sale_price ?? round2(factor × variant price)`; per-base = `sale_price ÷ factor` (exact when derived). Duplicate-variant guard is now per (variant, unit).

## 8–10. Barcode, inventory conversion, landed cost

Package alias lookup returns `{conversionId, unitName, unitAbbreviation, conversionFactor, salePrice}`. Stock adjustments/transfers/counts/offline allowances remain base-unit (no changes needed — the boundary conversion covers them). Landed cost: zero code changes; its line-vs-batch ratios stay base-unit by construction (tests assert ৳600 shipping over 60 pcs → ৳110/pc).

## 11–13. Variants, returns, reports

Variant overrides: same unit configurable per variant (Small 12/box, Medium 10/box); transaction resolution validates variant scope. Sales refunds: per-line partial quantities in base with pro-rated money (cart-discount/VAT delta included); damaged/inspection dispositions unchanged; purchase returns per §6 above. Reports aggregate base units (3 Box + 5 pcs = 41 pc — never "8"); rows carry unit labels; import of packaging columns is a documented follow-up (master prompt §13 allowance), export includes `package_units`.

## 14. Tests executed and results

- Backend: new suites — uom.money (7 pure invariants), uom foundation (13), purchases UOM (6), sales UOM (7), package barcodes (3), cart-store UOM (pos vitest). Final full run: **862 tests, 861 pass, 0 fail, 0 cancelled — the suite is fully green, including every previously-failing test.** The transient failures seen mid-program (and on the untouched tip) were a test-infra artifact: the auth rate limiter is a process-global singleton and the suite's hundreds of registrations crossed the 20/15-min default. `env.ts` now opens the credential ceilings under `INTEGRATION_TESTS=1` (explicit env override still wins; production defaults unchanged), which fixed those 63 baseline failures as well.
- pos frontend: vitest **265/265**; tsc error count identical to baseline (136 pre-existing on this branch; none added).

## 15. Known limitations

1. **Integer stock invariant:** decimal factors are allowed, but `factor × entered quantity` must be whole for stock flows. Fractional base stock (0.5 kg rice) remains a pre-existing platform limitation (integer stock columns).
2. **Product import** does not yet create packaging configs (documented; export carries `package_units`).
3. Line money derives from entered values; the stored per-base `selling_price`/`unit_cost` may differ from the entered total by < ½·10⁻² poisha per line when a configured package price doesn't divide evenly (6-dp grid; GL posts from header totals, unaffected).
4. Offline terminals: a held UOM line resumed without connectivity falls back to the base-unit interpretation of the entered quantity (documented in code).
5. Package-unit receiving floors the outstanding remainder; odd base remainders are received by switching that line to base.
6. Pre-existing branch issues (not this program): 136 frontend tsc errors present on the development tip (the backend suite is now fully green); the repo's tsconfig `baseUrl` deprecation under TS 6.

## 16. Remaining tasks (user items)

1. Run `npm run db:migrate` on dev/production environments (Windows machine included).
2. Push the branch and open the PR into `development` (5 commits; no migration renumbering needed — chain ends at 0062).
3. Optionally clean up the 136 frontend tsc errors inherited from the finance/purchase-refactor merges (separate program; the backend suite is green).
4. Decide on import-packaging columns (Phase 6+ follow-up) and fractional-base-stock widening if weight/volume products need it.
