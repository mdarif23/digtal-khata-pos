# Online Order Management & Profitability — Phase 1 Data Model, Policies & Plan

> Status: **PROPOSED — awaiting explicit approval before any migration is created or applied.**
> Companion document: `docs/ONLINE-ORDERS-AUDIT.md` (Phase 0).

---

## 1. Data-model & business-rule policies

### 1.1 Order lifecycle (adapted to existing enums — no duplicate system)

The recommended 7-state workflow maps onto the existing `sales.status` + `fulfillmentStatus` pair:

| Prompt state | ezPos representation | Notes |
|---|---|---|
| NEW | `sales.status = 'pending'` | created by storefront/Woo checkout, reservations held |
| CONFIRMED | `fulfillmentStatus = 'confirmed'` *(new enum value)* | business checks pass; stock consumed + reservations confirmed (existing `confirmOnlineOrderInTx`) |
| PROCESSING | `fulfillmentStatus = 'processing'` | existing value |
| PACKED | `fulfillmentStatus = 'packed'` *(new)* | requires ≥1 `sale_packages` row |
| READY_TO_SHIP | `fulfillmentStatus = 'ready_to_ship'` *(new)* | requires packages; shipment draft optional |
| SHIPPED | `fulfillmentStatus = 'shipped'` | requires `sale_shipments` row with courier + tracking |
| DELIVERED | `fulfillmentStatus = 'delivered'` | COD collection recorded at this point |
| CANCELLED | `sales.status = 'cancelled'` | pending-only; releases reservations (existing) |
| RETURN_* | `fulfillmentStatus = 'return_requested' \| 'partially_returned' \| 'returned'` *(new values, if approved)* | driven by refund flow; money-side truth stays in `saleRefunds` |

- Stock consumption happens at **confirm** (existing two-phase design: reservation → consumption). PACKED / READY_TO_SHIP are pure status steps; no stock movement.
- Transition map extended additively; invalid transitions rejected (extend `updateFulfillmentStatus` map, `orders.service.ts:801-809`).
- Existing rows keep their current enum values — additive `ALTER TYPE … ADD VALUE` is backward-compatible.

### 1.2 Payment lifecycle (independent from fulfillment — enforced, never inferred)

- `paymentStatus` (`unpaid|partial|paid`) and `fulfillmentStatus` are updated by different endpoints and never derived from each other. Shipping an unpaid COD order is valid and must not mark it paid.
- **COD:** stays `unpaid` through shipped; on **deliver** (or portal mark-paid), a `sale_payments` ledger row is written (method from request, default `cash`, reference `COD-<invoice>`), `paymentStatus` recomputed. Collection is thus tracked in the existing ledger — no new balance system.
- **Gateway (SSLCommerz):** existing verify core writes the ledger row and confirms in one tx; we add fee capture.
- Refunds deduct from recorded payments via existing `applySaleRefund` machinery.

### 1.3 Inventory rules

- Reuse `inventory_reservations` + `consumeStockFifo` unchanged. Reservations release on cancel (existing) and expiry sweep continues.
- Returns restock only on `restock` disposition via existing `RETURN-<refundId>` batch path — damaged returns never restock automatically.
- No double reversal: per-item refund guard already present; fulfillment/return statuses add a transition guard so a returned order cannot be "returned again".

### 1.4 Revenue recognition & COGS policy (documented for the report)

Population: `sales` rows with `channel != 'pos'`. Periods respect business + location access.

```
Gross Product Sales   = Σ sale_items.line_total          (completed orders only; pending/cancelled excluded)
− Product Refunds     = Σ sale_refunds.refund_total
= Net Product Sales
− COGS                = Σ (cost_at_sale × qty) − restocked cost (restock dispositions only)
= Gross Profit
+ Shipping Income     = Σ sales.delivery_fee             (income; kept separate from product sales)
− Courier Expenses    = Σ sale_shipments.shipping_cost
− Packaging Expenses  = Σ sale_packages.packing_cost
− Gateway Fees        = Σ sale_payments.gateway_fee
− Marketplace Commissions = Σ sales.marketplace_commission
= Net Contribution Profit
```

- All aggregation in SQL over persisted snapshots (`line_total`, `cost_at_sale`, persisted fees). **Never** current product prices (audit confirms `costAtSale` satisfies this).
- VAT excluded from revenue following the existing report treatment; inclusive-tax caveat documented in the report UI.
- "Estimated operating profit" adds channel-scoped `expenses` (see 2.8) and is labelled as NOT full net business profit.
- Currency: numeric(10,2)/12,2 as existing; BDT; rounding only at SQL aggregate boundaries.
- Validation target: the §9 worked example (250,000 / 150,000 / 100,000 / fees → 88,000) as an automated test.

---

## 2. Proposed schema changes — migration `0037_online_order_fulfillment` (single migration)

**Why existing structures are insufficient:** the audit (§1 table + §2) shows no packaging, shipment, courier, tracking, fee, or commission model anywhere; the fulfillment enum lacks workflow states; sales lacks shipping-address fields (currently concatenated into `customers.address` + `note`, which cannot be displayed or edited structurally); COD collection never touches the payments ledger; the orders list lacks a supporting index.

| # | Change | Detail | Impact |
|---|---|---|---|
| 2.1 | Extend `fulfillment_status` pgEnum | ADD `confirmed`, `packed`, `ready_to_ship` (+ `return_requested`, `partially_returned`, `returned` if approved) | Additive; existing rows unchanged; safe |
| 2.2 | `sales` — shipping snapshot columns | `shippingName varchar(150)`, `shippingPhone varchar(30)`, `shippingAddress text`, `shippingCity varchar(100)`, `shippingArea varchar(100)`, `deliveryInstructions text` — all NULLable | New orders populated at checkout; legacy orders fall back to `customers.address` in UI; no backfill needed |
| 2.3 | `sales` — commission | `marketplaceCommission numeric(10,2) NOT NULL DEFAULT 0` | 0 for all existing rows |
| 2.4 | NEW `sale_shipments` | `id, businessId, saleId (unique — one active shipment per order), courierName, courierService, trackingNumber, shipmentDate, expectedDeliveryDate, shippingCost numeric(10,2), status varchar(20) ('preparing\|in_transit\|delivered\|failed'), notes, referenceUrl, createdAt, updatedAt` + composite FK `(saleId,businessId)` + idx `(businessId, shipmentDate)` | New table; no existing data touched |
| 2.5 | NEW `sale_packages` | `id, businessId, saleId, packageNo int, packageType varchar(50), weightKg numeric(10,3), lengthCm/widthCm/heightCm numeric(10,2), materialsNote text, packingCost numeric(10,2) DEFAULT 0, packedByUserId, packedAt, notes` + composite FK + idx `(saleId)` | Multiple packages per order supported; product defaults are **copied** at pack time (snapshots — editing product defaults never rewrites orders) |
| 2.6 | NEW `sale_order_events` (timeline) | `id, businessId, saleId, eventType varchar(40), previousStatus varchar(30), newStatus varchar(30), actorType varchar(20) ('user'\|'system'\|'integration'), actorUserId, actorLabel varchar(120) (e.g. 'WooCommerce webhook'), note text, metadata jsonb, createdAt` + idx `(saleId, createdAt)` | Chronological per-order timeline; written by every transition + confirm/cancel/ship/deliver/refund/import paths; `auditLog` continues in parallel for generic audit. (Alternative considered: reuse `auditLog` — rejected: needs structured prev/new status and per-order display queries) |
| 2.7 | `sale_payments` — fee + CHECK alignment | `gatewayFee numeric(12,2) NOT NULL DEFAULT 0`; align method CHECK with live DB (add `store_credit|loyalty_points|gift_card` — fixes schema/DB drift from 0035) | Existing rows: fee 0, methods unchanged |
| 2.8 | `expenses` — channel attribution | `channel sale_channel NULL` (NULL = all channels), `saleId int NULL` composite FK | Enables channel-scoped operating expenses + order-linked expenses without duplicating the expense module |
| 2.9 | `products` — shipping & packaging defaults | `shippingWeightKg numeric(10,3)`, `shippingLengthCm/WidthCm/HeightCm numeric(10,2)`, `packagingInstructions text`, `handlingInstructions text`, `isFragile boolean NOT NULL DEFAULT false` | Product-level defaults copied into `sale_packages` per order |
| 2.10 | Index | `sales (businessId, channel, saleDate)` for list/profitability queries | Existing queries unaffected |

**Not proposed (documented limitations / out of scope):** per-batch COGS breakdown table (blended `costAtSale` is sufficient and historical); partial per-line shipment quantities (v1 fulfills whole orders; partial returns already modeled via `saleRefunds`); refund cash-out ledger rows (existing P1 backlog, separate fix); POS `validateStock` reservation-awareness (documented edge, separate decision).

**Code-only (no migration):** new RBAC catalog keys; `online_order` document-sequence key (`ORD-…`) if wanted; realtime `order.updated` SSE event; webhook events `order.fulfilled|shipped|delivered`; `order_webhook_retry` handler branch (bug fix).

---

## 3. Permissions (catalog-only, seeded at boot — no migration)

New keys in `src/rbac/permissions.ts`:

```
orders.view  orders.create?  orders.confirm  orders.process  orders.pack
orders.ready_to_ship  orders.ship  orders.deliver  orders.cancel
orders.return  orders.manage_shipping  orders.mark_paid
reports.online_profitability.view
```

Role defaults: owner `*` (automatic); manager: all `orders.*` + profitability; cashier: `orders.view`, `orders.process`, `orders.pack` only (no costs/profitability). Backend-enforced via `requirePermission` on every route; frontend nav/button gating is cosmetic only.

## 4. API design (extends the existing orders surface — no duplicate endpoints)

Existing (keep): `GET /api/businesses/:businessId/orders`, `GET …/:orderId`, `POST …/:orderId/fulfillment`, `POST …/:orderId/mark-paid`.

New under the same prefix (thin controllers → `commerce` services → transactions; Zod in controllers; `{success, message?, data?}` envelope; `page/pageSize` clamped):

```
POST   …/:orderId/confirm          (pending → confirmed; reuses confirmOnlineOrder + independent payment check)
POST   …/:orderId/start-processing
POST   …/:orderId/cancel           (reason required)
GET    …/:orderId/timeline
GET    …/:orderId/fulfillment      (packages + shipment + availability snapshot)
POST   …/:orderId/packages         PATCH/DELETE …/:orderId/packages/:packageId
POST   …/:orderId/ready-to-ship    (validates packages)
POST   …/:orderId/ship             (courier + tracking required)
POST   …/:orderId/deliver          (COD collection optional payload)
POST   …/:orderId/returns          (wraps applySaleRefund with online semantics + status updates)
GET    /api/reports/online-profitability/{summary,trends,products,channels,expenses}
```

## 5. Frontend plan (`pos/`)

- `features/online-orders/` — `api/`, `hooks/` (query-key factory + `keepPreviousData`), `components/`, `pages/`, `types/` following the procurement convention; colocated vitest tests.
- Routes: `/online-orders` (list + KPI dashboard) and `/online-orders/:orderId` (details: overview, customer, items with availability, payments, packages, shipment, timeline) — `RequirePermission orders.view`.
- Nav: "Online Orders" leaf beside "Sales" (`navigation.ts`); report as `?tab=online-profitability` in Reports hub + nav item (`reports.online_profitability.view`).
- Reuse: `ReportTable`/report kit for lists, `StatusBadge` (extended statusConfig), `ReportMetricCard`, `ReportTrendChart/BarChart/PieChart`, `ReportDateFilter`, `exportToCsv`, `ConfirmDeleteDialog`, Base UI toast helpers.
- Product page: new "Shipping & Packaging" card section (fields from 2.9).

## 6. Phases (adjusted to audit reality)

| Phase | Content |
|---|---|
| 2 | Backend orders: migration 0037, enum/transitions, confirm/start-processing/cancel, timeline writes, COD ledger, permissions |
| 3 | Fulfillment: packages, shipments, ready-to-ship/deliver, online-order return fixes, reservation handling |
| 4 | Frontend: dashboard, DataTable, details page, workflow UI, timeline, product defaults |
| 5 | Profitability backend: fee capture, expense attribution, report services + SQL, formula tests (§9 example) |
| 6 | Profitability frontend: KPIs, charts, product/channel tables, filters, exports |
| 7 | Integration: `order_webhook_retry` fix, fulfillment webhook events, Woo status push-back (optional), realtime order events, storefront track enrichment |
| 8 | Full gates: `npm test` + `INTEGRATION_TESTS=1` suites, tsc, lint, builds both apps |

## 7. Testing strategy

- Backend integration tests (existing pattern: self-contained suites, `ezpos_test` guard, `buildApp`, `createOwnerCtx`): order lifecycle incl. invalid transitions; idempotent import replay; reservation + concurrent confirm oversell prevention; cancel release; batch cost allocation correctness; pack/ship prerequisites; COD ledger; partial refunds; cross-business 404s; location scoping; permission denials; profitability formula incl. the §9 worked example.
- Frontend: colocated component/page tests (filters, badges, form validation, error states).
- Existing 400/400 backend + frontend suites must stay green.
