# ezPos — Multiple Units of Measure & Packaging Conversion: Audit and Implementation Architecture

**Phase 0 — READ-ONLY audit.** Branch: `feature/multiple-units-of-measure` (tip `ab09ad9`, clean).
**No source files, schemas, migrations, or data were modified.** This document is the only artifact.

---

## 1. Executive summary

The current system gives every product exactly **one** unit (`products.unit_id` → a `units` table that
stores only `name` + `abbreviation`). Every quantity in every table — stock, batches, purchase lines,
sale lines, transfers, counts, movements, offline allowances — is denominated in that one unit.
There is no conversion factor anywhere; the units table is a display label.

The decisive finding is that this is an **asset, not an obstacle**: because today "the product's unit"
is the only unit, every existing quantity already *is* a base-unit quantity. The proposed architecture
therefore requires a **zero-touch migration**: the product's existing unit becomes its base unit by
definition, existing stock is already correct base-unit stock, and products without packaging
configuration behave bit-for-bit identically to today (absence of a conversion row ≡ identity factor 1).

Key architectural facts that make this land cleanly:

1. **Stock storage is already "base-unit storage."** `inventory_stock.quantity` is an `INTEGER` per
   (business, variant, location); batches are integer too. We do not introduce a parallel balance —
   we keep exactly one authoritative integer balance and convert at the line boundary.
2. **`consumeStockFifo` consumes an arbitrary base-unit quantity** (`sales.service.ts:290-376`), so a
   "1 Box = 12 pcs" sale is natively just a 12-unit FIFO consumption across batches, with the existing
   `sale_item_batch_consumptions` ledger and blended `cost_at_sale` working unchanged.
3. **Landed cost operates on line quantities vs batch quantities** — it stays untouched as long as
   line storage remains base-unit (the allocation engine, BigInt micros, largest-remainder, and the
   `additional_cost_per_unit` batch write-back all keep their invariants).
4. **Trusted pricing is already server-side** in a small number of resolver spots — the per-unit price
   resolver slots into exactly those spots.

The work concentrates in: a new conversion table + resolver, snapshot columns on transaction lines,
a small set of precision widenings, barcode alias extension, and frontend unit-selection surfaces.

---

## 2. Current-state audit

### 2.1 The existing unit system

| Fact | Reference |
|---|---|
| `units` = `{id, businessId, name, abbreviation}` — no factor, no base concept, no type | `ezPosBackend/src/db/schema/units.ts:4-15` |
| `products.unitId` is the **only** unit reference; variants inherit it | `products.ts:34`, `productVariants.ts` (no unit column) |
| Units CRUD exists: `POST/PUT/DELETE /api/product/unit` | `modules/addProduct/product.routes.ts:88-100` |
| `unitId` is nullable in DB but required by the product form | `product.schema.ts` (pos `src/features/products/product.schema.ts:84-90`) |
| Frontend unit options come from `GET /product/select-options`; legacy mock unit list is dead code | `useProductStore.ts:104-112`; `src/data/products.ts` (unused) |

### 2.2 Inventory behavior

- `inventory_stock.quantity` / `reservedQuantity`: `INTEGER`, unique per (business, variant, location)
  (`inventoryStock.ts:24-40`). No cost column — cost lives on batches.
- `inventory_batches`: `quantityReceived` / `quantityRemaining` **INTEGER**;
  `purchasePrice numeric(10,2)` per unit (session cost, never mutated by landed cost);
  `landedCostPerUnit` DB-generated = `purchase_price + additional_cost_per_unit` (`inventoryBatches.ts:57-66`).
- `inventory_movements.quantity INTEGER`; sign convention is **mixed** (sale/return rows positive-means-out;
  transfers signed; adjustments signed) — reports compensate with `ABS()` (`reports.service.ts:1348,1370-1400`).
- Reservations (`inventory_reservations`, `reserved_quantity`) are online-channel holds; POS ignores
  them when validating stock (`sales.validation.ts:88-123`).
- Serials: unique per (business, serial); sale requires `serials.length === item.quantity`
  (`sales.service.ts:986-989`).
- **Existing limitation (pre-dates this feature):** stock is integer while purchase lines are
  `numeric(12,3)` — fractional stock (0.5 kg rice) cannot be held today. This program will **not**
  widen stock columns (see §10, Decision D4).

### 2.3 Purchases

- `purchase_items`: `quantity / receivedQuantity / deliveredQuantity / rejectedQuantity / cancelledQuantity`
  `numeric(12,3)`; `unitCost numeric(12,2)` **per product unit**; discount/tax per line;
  **`total` is DB-generated `quantity × unit_cost − discount + tax`** (`purchaseItems.ts:77-79`) —
  a hard single-unit assumption baked into a stored column. **No unit column or snapshot anywhere.**
- Receiving: cumulative `receivedQuantity` (ordered qty never mutated); outstanding =
  `quantity − received − cancelled`; over-receive tolerance is a % of ordered quantity, beyond-tolerance
  needs `purchases.over_receive` permission + reason and writes a `purchase_discrepancies` row
  (`receive/receive.validation.ts:114-156`). Batch quantities must sum exactly to `receiveNow`;
  serials count must equal `receiveNow` (`receiveItem.schema.ts:54-75`).
- **Batch-authoritative cost (decision D1 already in the codebase):** line `unit_cost` keeps the PO
  order cost; the per-session cost lands on `inventory_batches.purchase_price`. Landed cost rides on
  `additional_cost_per_unit`. **Neither is ever mutated by receiving.**
- Purchase returns: whole-unit integers; eligibility = `received − Σ prior returns` per line and
  on-hand stock at the receiving location; per-unit credit = batch FIFO price + amortized
  `(lineTax − lineDiscount) / orderedQuantity`; landed-cost reversal per consumed batch
  (`purchaseReturn.service.ts`, `return.valuation.ts`).
- Price history / reorder / price alerts derive everything from `purchase_items.unit_cost`
  (weighted average, "last cost" = latest PO line). These stay **correct automatically** if stored
  quantities/costs remain base-unit.
- Precedent: `price_observations.package_quantity numeric(12,3)` (procurement quotations) is the only
  existing package concept — display-normalized only (`priceCheck.service.ts:80-83`).

### 2.4 Sales / POS

- `sale_items.quantity` **INTEGER**; `sellingPrice numeric(12,2)` per-unit snapshot; `costAtSale`
  blended per-unit COGS snapshot; per-batch decomposition in `sale_item_batch_consumptions`
  (`unitCostAtConsumption numeric(14,6)`). No unit columns.
- **Costing method: FIFO per batch** (`inventory_batches.id` ASC, `FOR UPDATE`, per location) — not
  weighted average, not FEFO (`consumeStockFifo`, `sales.service.ts:290-376`).
- Trusted price: `sellingPrice` is always taken from `productVariants.sellingPrice` in the DB — the
  client-sent `unitPrice` is accepted by zod but **ignored**. Resolver spots: POS
  (`sales.service.ts:833-846`), exchange (`2292-2303`), quote (`2674-2687`), storefront
  (`orders.service.ts:315-345`).
- Duplicate-variant cart lines are **rejected** ("Combine their quantities first",
  `sales.validation.ts:51-55`) — box + pcs of one variant in one cart is impossible today.
- Refunds: **whole-line, once-only** (`saleRefundItems.quantity` = full line quantity; no quantity in
  the refund API). Restock disposition re-enters stock as a new `RETURN-…` batch priced at
  `costAtSale`; damaged/inspection never restock and never reverse COGS.
- Held carts are **server-side** (`held_sales.items` jsonb: `{variantId, quantity, discount,
  serialNumbers}`); resume re-prices from live catalog and re-validates stock.
- Offline/terminals: allowances in base units (`offline_allocations`); offline sale ops go through
  `createSale` with `allowNegativeStock`; LAN catalog sync copies the `units` table wholesale
  (`sync.service.ts:205-210`).
- GL: revenue = header `final_total − vat − delivery_fee`; COGS = `Σ cost_at_sale × quantity` —
  header/snapshot based, so GL is structurally insulated from line re-derivation
  (`sales.ledger.ts:174-186`).

### 2.5 Barcodes

- Primary barcode on `product_variants.barcode` (unique per business) + `variant_barcode_aliases`
  (migration 0044/0046): per-business unique codes resolving to a variant. **An alias carries no
  quantity or unit context** — one code = one variant = one base unit, everywhere (`barcodes.service.ts`).
- Lookup payload returns `sellingPrice`, `stockAtLocation`, `purchaseCost`, `trackingType` — no unit.
- Eight scan entry points in `pos` all do "1 scan = +1 base unit".
- Label printing renders code + text only — no qty/unit.

### 2.6 Landed cost

- Methods `quantity | value | weight | manual | equal`; BigInt micros allocator, largest-remainder;
  one document per purchase; allocation rows immutable with `quantitySnapshot`; write-back divides
  allocated amounts by **batch** `quantity_received` (`landed-cost.calculator.ts`, `landed-cost.lifecycle.ts:571-589`).
- Allocation ratios mix line `quantity − cancelled` with batch `quantityReceived` — **both must remain
  in the same (base) unit or every method except `value`/`manual` misallocates.** This is the strongest
  argument for keeping transaction line storage in base units.

### 2.7 Reports, import/export, multi-location

- Reports aggregate `quantity`, `selling_price × quantity`, `(selling_price − cost_at_sale) × quantity`
  in SQL (`reports.service.ts:98,341,525,584`); none join `units`; the API returns no unit label.
- Transfers: `quantity/quantityShipped/quantityReceived INTEGER`, FIFO at ship, `TRF-…` batch at ship
  cost. Stock counts: expected frozen, approval applies `counted − current` delta, adjustments consume
  FIFO / create `ADJ-…` batches.
- Product import (migration 0047 sessions): `unit` is a **required** column matched/created by name;
  no factor/package columns. Products CSV export has **no** unit column.
- Storefront/local-server: no independent unit logic found; the LAN catalog delta carries `units`
  wholesale and would need the conversion set added.

### 2.8 Frontend surfaces (pos app)

| Surface | Current state |
|---|---|
| Product form | Single `unitId` dropdown (`GeneralInfoCard.tsx:41-46`); variant rows carry price/qty only |
| Cart line | `{variantId, quantity, discount, serialNumbers}` — no unit; price = `variants[0].sellingPrice`; qty input `step=1`, `Math.floor` |
| Checkout payload | `{variantId, quantity, unitPrice, discount, serialNumbers}`; zod `quantity int().positive()` |
| Purchase order | `purchaseQty` fractional-capable; price prefilled per base unit; **no unit column** |
| Receiving | Unit column shows `productUnit` label (display only); `receiveNow` fractional for non-serial |
| Purchase return | Base-unit integer returns; Unit column display-only |
| Stock UI | Adjustment absolute integer; transfers whole numbers; counts integer; hardcoded `"units"`/`"pcs"` strings in 5+ places |
| Reports | `qtySold`, `currentStock`, etc. rendered bare — no unit label anywhere |
| Receipts | `SaleReceiptItem.unitName` already exists and renders in invoices |

---

## 3. Load-bearing single-unit assumptions (the full list)

1. `purchase_items.total` **DB-generated** from `quantity × unit_cost` (`purchaseItems.ts:79`).
2. Five purchase-path derivations **divide line money by quantity** (return credit amortization ×2,
   cancellation value ×2, receiving VAT share) — numerator/denominator must share one unit.
3. Landed-cost allocation ratios mix line quantities with batch quantities (§2.6).
4. `sale_items.quantity INTEGER` + per-unit `selling_price`/`cost_at_sale` snapshots; profit =
   `(selling_price − cost_at_sale) × quantity` in 4+ report queries.
5. Duplicate-variant-line rejection in `validateStock`.
6. Serial count equality `serials.length === item.quantity`.
7. Whole-line-only refunds; `refundPrice = effective / quantity`.
8. Barcode aliases carry no unit/quantity context; lookup returns no unit.
9. Integer stock/batch/transfer/count/movement/allocation columns (~12 tables).
10. Held-cart jsonb shape has no unit field.
11. Frontend: price = `variants[0].sellingPrice`; scan = +1 base unit at 8 entry points;
    hardcoded "units"/"pcs" strings.
12. Import requires a single `unit` name per row; export omits units.
13. Offline allowances and LAN sync operate on bare base-unit quantities; sync copies `units` only.
14. Over-receive tolerance = % of ordered quantity (same unit on both sides).

---

## 4. Migration path for existing products with stock — the critical design

**Principle: existing inventory must remain byte-for-byte unchanged, and it already is base-unit stock.**

1. **The base unit is the product's current `unit_id`.** No new column, no copy, no backfill.
   `products.unit_id` *is* the base-unit anchor; it becomes non-reassignable once packaging exists.
2. **Existing quantities need no rewriting.** `inventory_stock.quantity = 60` on a "Piece" product
   means 60 pieces — which is exactly what a base-unit store should say. Same for every historical
   purchase/sale line, batch, movement, transfer, and count: their quantities were denominated in the
   product's only unit, which is now defined as the base unit. **Nothing is recomputed.**
3. **Absence of configuration ≡ identity conversion.** A product with zero rows in the new
   `product_unit_conversions` table behaves exactly as today: the only sellable/purchasable unit is the
   base unit, factor 1. Every conversion lookup routes through one resolver that returns factor `1` when
   no row matches. Single-unit products never require extra configuration (master-prompt Rule 3).
4. **All new columns are nullable with no defaults that change reads.** Historical rows read as
   `entered_quantity = quantity`, `conversion_factor = 1`, `entered_unit_price = selling_price` via
   `COALESCE` at read time. No historical row is ever updated (master-prompt §14: never re-derive old
   transactions from current settings).
5. **Precision widenings change no values** (e.g., `125.00 → 125.000000`). Widening `numeric` scale is
   loss-free and index-safe.
6. **Lazy materialization only.** A base-unit conversion row (factor 1) is *never* created by the
   migration; if the owner opens "Units & Packaging" on an old product, the UI shows the base unit
   implicitly from `products.unit_id` and offers to add packaging units. Adding packaging units does
   **not** touch any existing quantity or transaction.
7. **Barcodes unaffected.** Existing primary barcodes and aliases continue to resolve to the base unit;
   package barcodes are *new* alias rows with a nullable unit link.

**Net database migration for existing data: zero rows touched.** The only DDL is additive
(new table + new nullable columns + two precision widenings + one nullable alias column).

---

## 5. Proposed database architecture

> Numbers assume the current chain ends at `0060`; renumber at implementation time if development
> moves (established renumbering discipline from prior programs).

### 5.1 `product_unit_conversions` (migration 0061)

```sql
CREATE TABLE product_unit_conversions (
  id                  serial PRIMARY KEY,
  business_id         integer NOT NULL REFERENCES businesses(id),
  product_id          integer NOT NULL REFERENCES products(id),
  variant_id          integer,                -- NULL = product-level default; set = variant override
  unit_id             integer NOT NULL REFERENCES units(id),
  conversion_factor   numeric(14,6) NOT NULL CHECK (conversion_factor > 0),
  is_purchase_enabled boolean NOT NULL DEFAULT true,
  is_sale_enabled     boolean NOT NULL DEFAULT true,
  is_default_purchase boolean NOT NULL DEFAULT false,
  is_default_sale     boolean NOT NULL DEFAULT false,
  sale_price          numeric(14,2),          -- default sale price per THIS unit; NULL = derive
  purchase_price      numeric(14,2),          -- default purchase price per THIS unit (prefill)
  status              varchar(20) NOT NULL DEFAULT 'active',  -- active | inactive
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX puc_product_unit_uq
  ON product_unit_conversions (product_id, COALESCE(variant_id, 0), unit_id);
CREATE UNIQUE INDEX puc_default_sale_uq
  ON product_unit_conversions (product_id, COALESCE(variant_id, 0))
  WHERE is_default_sale AND status = 'active';
CREATE UNIQUE INDEX puc_default_purchase_uq
  ON product_unit_conversions (product_id, COALESCE(variant_id, 0))
  WHERE is_default_purchase AND status = 'active';
-- tenant-safe composite FKs from transaction tables (existing repo pattern):
CREATE UNIQUE INDEX puc_id_business_uq ON product_unit_conversions (id, business_id);
```

Design decisions:

- **Single table, nullable `variant_id`** — product-level defaults with per-variant overrides
  (master-prompt §11). Football Small 12/box, Medium 10/box, Large 6/box = three override rows.
- **The base unit never gets a row.** Creating a conversion row for `products.unit_id` is rejected;
  the base unit is implicitly factor 1, always purchasable and sellable.
- **Per-unit default prices live on the row** — one concept ("you can buy/sell this product in this
  unit at this price") instead of a second table. `NULL` sale_price = `factor × variant.selling_price`
  displayed as the default; **transaction prices are always captured per line** (configured default vs
  actual transaction price stays distinguished, as the existing trusted-price pattern does).
- **Factor semantics:** `factor = how many base units one of this unit contains` (1 Box = 12 → 12).
  Direct-to-base only (master-prompt §4C) — no chained conversion resolution.
- Tenant isolation: `business_id` scoped + the repo's composite `(id, business_id)` candidate-key FK
  pattern for referencing tables.

### 5.2 Transaction snapshot columns (migration 0062)

```sql
-- purchase_items, purchase_receiving_records, sale_items (same shape each):
ALTER TABLE …
  ADD COLUMN uom_conversion_id  integer,        -- FK → product_unit_conversions (id, business_id)
  ADD COLUMN entered_quantity   numeric(12,3),  -- as the user typed it (e.g. 5 boxes)
  ADD COLUMN entered_unit_price numeric(14,6),  -- per entered unit (৳1,200/box)
  ADD COLUMN conversion_factor  numeric(14,6);  -- factor AT TRANSACTION TIME (snapshot)
```

**Storage rule (the heart of the design): every stored quantity and stored per-unit cost/price column
keeps today's meaning — BASE units.** `purchase_items.quantity`, `receivedQuantity`, `unitCost`,
`sale_items.quantity`, `sellingPrice`, `costAtSale` all remain base-unit. The entered unit lives only
in snapshot columns. Consequences:

- The DB-generated `purchase_items.total = quantity × unit_cost − …` stays correct (base × per-base).
- The five divide-by-quantity derivations (§3.2) stay correct.
- Landed cost allocations, batch write-backs, FIFO consumption, transfers, counts, movements,
  offline allowances, GL postings: **zero changes** — they already speak base units.
- Purchase price history / reorder / price alerts remain per-base-unit and therefore remain correct.

**Rounding rule:** entered-unit money (`5 boxes × ৳1,200`) is authoritative for line and header totals
at write time; the derived per-base `unitCost = 1,200/12 = ৳100` (or `sellingPrice` per base) is stored
at 6dp so that re-derivation from base columns never drifts beyond display rounding.

### 5.3 Precision widenings (migration 0062, same file)

| Column | From → To | Why |
|---|---|---|
| `sale_items.selling_price` | numeric(12,2) → **numeric(14,6)** | per-base equivalent of a package price (৳1,500/12 = 125.00 exact; ৳1,000/3 = 333.333333) |
| `purchase_items.unit_cost` | numeric(12,2) → **numeric(14,6)** | same; keeps DB-generated `total` exact |
| `inventory_batches.purchase_price` | numeric(10,2) → **numeric(14,6)** | per-base batch cost from a package-priced receipt |
| `purchase_return_items.unit_price` | numeric(10,2) → **numeric(14,6)** | per-base credit |

All widenings are value-preserving; no existing value changes.

### 5.4 Barcode aliases (migration 0062, same file)

```sql
ALTER TABLE variant_barcode_aliases
  ADD COLUMN uom_conversion_id integer REFERENCES product_unit_conversions(id);
```

- `NULL` (all existing rows) = resolves to the **base unit** — existing behavior bit-for-bit.
- A package barcode is an alias row with `uom_conversion_id` set; per-business uniqueness is inherited;
  lookup response gains `{ unitId, unitLabel, conversionFactor, salePrice }`.
- Label printing gains per-packaging labels (12-pc box label vs piece label).

### 5.5 Non-migration contract changes

- `held_sales.items` jsonb item shape gains optional `{ uomConversionId, enteredQuantity }`
  (resume re-resolves the factor and re-prices — consistent with the existing "prices are not trusted
  from the hold" contract).
- LAN catalog sync payload (`sync.service.ts`) gains the active conversion set for the location catalog;
  offline terminals keep allowances and consumption in **base units** (no change to allocation math).

### 5.6 Explicitly unchanged

`inventory_stock`, `inventory_batches` (quantities), `inventory_movements`, `stock_transfer_items`,
`stock_count_lines`, `offline_allocations`, `channel_inventory_allocations`, `serial_numbers`,
`landed_cost_*`, `sale_item_batch_consumptions`, `sale_refund*` (quantities), all money columns on
`sales`/`purchases` headers, and every historical row.

---

## 6. Business rules & calculations

### 6.1 Conversion resolution (single choke point)

`uom.service.ts` (shared): `resolve(businessId, product, variant, conversionId | null)` →
`{ factor, unit, scope }`. Absent/`null`/base ⇒ factor 1. Cached per request; the **backend always
resolves the authoritative factor and prices from the DB — frontend-submitted factors/prices are
advisory** (master-prompt §15).

### 6.2 Purchase math (worked example)

Enter 5 Box @ ৳1,200, factor 12 → stored: `entered_quantity=5`, `entered_unit_price=1200`,
`conversion_factor=12`; `quantity=60` (base), `unitCost=100.000000`. Subtotal ৳6,000 unchanged.
Shipping ৳600 → landed cost allocates on base quantities (60 pcs) → `৳110/pc` batch landed cost,
`৳1,320/box` equivalent — computed by the existing engine, untouched.

Partial receiving in purchase units: `receiveNow` may be submitted with a `uomConversionId` (e.g. 6 Box);
service converts to 72 base before the outstanding check, batch writes, discrepancy logic, and receiving
record snapshots. Over-receive tolerance continues to compare base units on both sides.

Purchase returns: return qty accepted in the **original purchase unit or any active purchase-enabled
unit**; converted to base; eligibility (remaining received, on-hand stock) validated in base; per-unit
credit derived per base; snapshots preserved.

### 6.3 Sale math (worked example)

Stock 60 pcs. Sell 1 Box @ ৳1,500 → stored `entered_quantity=1, entered_unit_price=1500, factor=12`,
`quantity=12` (base), `sellingPrice=125.000000` (per base), `lineTotal=৳1,500` (computed from entered
values — authoritative). FIFO consumes 12 pcs across batches; `costAtSale = ৳110`/pc (blended);
`sale_item_batch_consumptions` rows per batch; COGS ৳1,320; profit ৳180; stock 48 pcs. Sell 3 pcs →
deduct 3. **The master-prompt §7B example reconciles exactly, with no changes to FIFO or COGS code.**

Sell 2 Box with 15 pcs available → 24 base required > 15 → rejected with a clear message
("Requires 2 Box = 24 pcs; available 15 pcs"). Stock validation happens on **base quantities
aggregated across cart lines** (see 6.4), before checkout and again inside the sale transaction
(`FOR UPDATE` — existing concurrency machinery, unchanged).

### 6.4 Cart rules

- Cart line gains `{ uomConversionId, enteredQuantity, unitPrice }`; base quantity derived.
- **Multiple lines per variant are allowed when their units differ**; `validateStock` aggregates base
  quantities per variant before comparing to available (relaxes the duplicate-line guard
  `sales.validation.ts:51-55` for distinct conversions only).
- Price per unit: `row.sale_price ?? round2(factor × variant.sellingPrice)`; the cashier may not edit
  price (existing rule) — only units/quantities.

### 6.5 Editing safety (master-prompt §5E)

- A conversion row's **factor is immutable once any transaction references it** (checked at update);
  the safe operation thereafter is `status → inactive` (hidden from new documents, historical
  transactions keep their snapshots).
- A unit cannot be deleted while referenced by any conversion row (extends the existing unit-delete
  usage check).
- Open carts/POs hold `uomConversionId`; resume re-resolves the factor and flags lines whose factor
  changed for re-confirmation (held carts already re-price on resume — same contract).
- Barcodes mapped to a conversion block factor edits (referenced-check covers the alias row).

### 6.6 Batch & serial rules

- Batches keep base-unit integers: a package receipt converts before `insertInventoryBatches`;
  batch quantities must sum to the converted base quantity (existing exactness rule preserved).
- **Serial-tracked variants:** selling a package unit requires capturing exactly
  `factor × enteredQuantity` serials (the box barcode resolves to a serial-picker pre-filled with 12
  slots). Receiving likewise expands. This honors "a box of 12 serialized products resolves to 12
  serial records" without weakening any tracking rule (master-prompt §9E).

### 6.7 Returns

- Sales refunds remain whole-line; the returned base quantity = line `quantity` (e.g. the 12 pcs of the
  box) restocked per disposition — snapshots preserve the original unit for display ("Returned 1 Box").
- **Scope addition required by master-prompt §10:** accept a per-line return quantity (schema column
  already exists; service change) so "return 3 of the 12 pieces" restocks exactly 3 base units with
  pro-rata money per the existing refund allocation math. Cross-unit returns (return a box against a
  piece-line or vice versa) validate in base units.
- Damaged/non-restockable dispositions behave exactly as today (no stock, no COGS reversal).

### 6.8 Reports

- Every quantity-bearing report gains `unitLabel` +, where a UOM line exists, a
  "sold as 3 Box (36 pcs)" presentation: **report rows group by (variant, entered unit)** with a base
  equivalent column; aggregates across units sum only base equivalents. No report ever adds
  "3 boxes + 5 pieces = 8" (master-prompt §12).
- Valuation, COGS, profit math: unchanged (all base-unit); only precision from §5.3 flows through.
- Low stock: thresholds remain base-unit (`alertQuantity`); displays may add "≈ 2 Box".
- Dashboard/receipts/imports: replace hardcoded `"pcs"`/`"units"` with the resolved label.

---

## 7. API architecture

Follows the existing flow: zod → auth → business authorization → permission → logic → DB tx → response.

| Endpoint | Purpose |
|---|---|
| `GET /api/product/:id/uom` | Conversion config (product-level + variant overrides) |
| `POST /api/product/:id/uom` | Add packaging unit (validation per §6.5) |
| `PATCH /api/product/uom/:conversionId` | Update flags/prices; factor only while unreferenced |
| `POST /api/product/uom/:conversionId/deactivate` | Safe retirement |
| `GET /api/variant/:id/sell-units` | POS: active sale units + resolved prices + available base stock |
| `GET /api/variant/:id/purchase-units` | Purchasing: active purchase units + last/default costs |
| `POST /api/uom/resolve` | Server-authoritative conversion preview (entered qty/unit → base + prices) |
| `GET /api/barcodes/lookup/:code` | **Extended**: gains unit context when alias has `uom_conversion_id` |
| `POST /api/sales`, `/api/sales/quote`, exchange | Items gain optional `uomConversionId` + `enteredQuantity`; factor/price re-resolved server-side |
| `POST /api/purchases`, receiving, returns | Same pattern; base-unit storage rule enforced server-side |
| `POST /api/product-import` sessions | Optional UOM columns (Phase 6) |

Idempotency: sale idempotency keys already cover UOM lines (payload hash includes them).
Audit logging via the existing patterns for conversion config changes.

---

## 8. Frontend implementation plan (pos app)

1. **Product form — "Units & Packaging" section** (`features/products/`): base unit display
   (read-only, from `unitId`), packaging rows (unit, factor, purchase/sale toggles, default flags,
   sale price, purchase price, barcode per unit), safety messaging for locked factors. New
   `uom.api.ts` + `useProductStore` slices + `unit.schema.ts` extension.
2. **Product list/details**: stock column shows "48 pcs (4 Box)" per display preference; remove
   hardcoded `"units"`; CSV export gains base unit + packaging columns.
3. **POS** (`features/pos/`): cart line gains a compact unit chip (Box ⇄ Piece switcher popover showing
   factor + per-unit price + availability "4 Box / 48 pcs"); product cards unchanged for single-unit
   products (no clutter); stock gate converts to base; checkout payload carries UOM fields;
   IndexedDB persistence + held carts carry UOM fields (versioned shape).
4. **Purchases**: item rows gain a unit selector (default purchase unit prefilled) with live
   "5 Box = 60 pcs @ ৳100/pc" hint; receiving rows accept the purchase unit (scan-to-count counts
   entered units); purchase return accepts unit selection with remaining-quantity display.
5. **Inventory**: stock adjustment/count/transfer forms show unit labels and accept authorized units
   (base-first; transfers stay base-unit with package display).
6. **Reports**: quantity columns gain unit labels; sales-by-product groups per entered unit with base
   equivalent column.
7. **Barcodes**: generator/labels support per-packaging codes; scanning a package barcode adds the
   package (existing queue/dedupe machinery reused).
8. **Import wizard**: optional packaging columns in Phase 6 (or deferred — Decision D5).

Single-unit products see **zero UI change** beyond label corrections — no extra configuration, no extra
steps (master-prompt Rule 3 / §16).

---

## 9. Testing plan

Backend (current: 671 passing) — new/extended suites:

1. Conversion resolver: identity fallback, product-level vs variant override precedence, inactive rows,
   cross-tenant isolation.
2. Purchases: create in package unit (money + stored base fields + DB-generated total), partial
   receiving in mixed units, over-receive tolerance in base, cancellation value, purchase return in
   original and equivalent units, landed-cost `quantity/value/weight/equal` allocation on package lines
   (the §3.4 failure modes become regression tests).
3. Sales: box + piece sale reconciliation (master-prompt §7B numbers asserted exactly), stock
   validation aggregation across mixed-unit lines, insufficient-stock rejection, FIFO consumption across
   batches for a 12-pc line, COGS/profit snapshot correctness, quote endpoint, exchange flow.
4. Returns: whole-box refund, 3-pieces-from-box partial return, damaged disposition, refund ceiling
   with prior returns.
5. Barcodes: package alias resolution, base-unit default, cross-tenant uniqueness.
6. Serials: package receipt/sale expands to N serials; duplicate protection.
7. Held carts & offline: resume with stale factor, sync payload includes conversions, offline sale in
   package unit converts at apply time.
8. Concurrency: parallel box+piece sales of the same variant (no oversell, exact integer balances).
9. Historical accuracy: pre-UOM transactions read with factor-1 semantics after migration.
10. Import validation: duplicate/invalid conversion rows rejected without corrupting products.

Frontend (`pos`, vitest): cart store unit math (add/switch/merge/discount), payload building,
persistence migration of stored carts; E2E: buy-box-sell-pieces happy path.

Edge-case checklist §18 of the master prompt maps 1:1 onto suites 1-10 (each numbered case has an owner
test).

---

## 10. Implementation phases & decisions requiring approval

Phases follow the master prompt: **1** foundation (table, resolver, snapshots, tests) → **2** product
form + purchases (incl. receiving, returns, landed cost) → **3** POS sales → **4** barcodes →
**5** inventory + returns + serials → **6** reports + import/export → **7** final review. Each phase
ends with the full test suite green; no phase changes historical data.

| # | Decision | Recommendation |
|---|---|---|
| D1 | Base-unit anchor stays `products.unit_id`; zero-touch migration (§4) | **Approve** |
| D2 | Single conversion table with nullable `variant_id` (product default + variant overrides) | **Approve** |
| D3 | Transaction lines stay base-unit + snapshot columns; 4 precision widenings | **Approve** |
| D4 | Stock stays INTEGER — decimal conversion factors allowed, but `factor × entered qty` must be whole for stock flows; fractional base stock (kg) remains a documented pre-existing limitation | **Approve** |
| D5 | Product import/export packaging columns in Phase 6, or defer to a later program | **Recommend: Phase 6 (schema supports both)** |
| D6 | Serial-tracked products: support package sale via N-serial expansion (not blocked) | **Recommend: support** |
| D7 | Per-line return quantity (partial piece returns) added in Phase 5 | **Recommend: include** |
| D8 | Package barcode support via `variant_barcode_aliases.uom_conversion_id` | **Approve** |

**Awaiting explicit approval before any migration or source change (master-prompt Rule 2 / Phase 0 STOP).**
