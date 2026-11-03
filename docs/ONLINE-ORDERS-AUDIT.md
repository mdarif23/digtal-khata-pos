# Online Order Management & Profitability — Phase 0 Architecture Audit

> Audit performed 2026-11-04 on branch `feature/online-order-management` (HEAD 011a682).
> Scope: `ezPosBackend`, `pos` (POS frontend). `ezPosWebsite` untouched. `ezPosStorefront` (Next.js renderer) inspected read-only.
>
> **Headline finding:** a large part of the requested backend already exists. Phase 9 built a complete
> two-phase online-order engine (`src/modules/commerce/`) on the `sales` table with channel metadata,
> inventory reservations, FIFO costing and SSLCommerz/COD payments. The POS frontend has **nothing**
> for online orders, and profitability reporting beyond per-channel revenue does not exist.

Repo layout note: the POS frontend lives at `pos/` (package name `pos`), not `ezPosFrontend/`.

---

## 1. Required audit table

| Area | Existing implementation | Reusable components | Missing functionality |
|---|---|---|---|
| **Online orders** | `sales` IS the unified order table: `channel` (`pos\|woocommerce\|custom_storefront`), `externalOrderId/Number`, `idempotencyKey` (unique), `shopperId`, `deliveryFee`, `fulfillmentStatus` (4-state), `paymentStatus`, `locationId` (`src/db/schema/sales.ts:41-128`). Order engine `src/modules/commerce/orders.service.ts`: `createOnlineOrder` (:250), `confirmOnlineOrderInTx` (:442), `cancelOnlineOrder` (:573), `listUnifiedOrders` (:631), `getOrderDetail` (:748), `markOnlineOrderPaid` (:812), `updateFulfillmentStatus` (:837). Admin routes `/api/businesses/:businessId/orders*` (`ordersAdmin.routes.ts:16-35`). | Entire commerce module; idempotency stack; pagination convention `{rows,total,page,pageSize}` | Online Orders UI (frontend zero coverage); order timeline; dedicated order transitions confirm/start-processing/pack/ready-to-ship; sort options on list |
| **Order fulfillment** | `fulfillmentStatusEnum` = `unfulfilled\|processing\|shipped\|delivered` (`commerceEnums.ts:18-23`); transition map `unfulfilled→processing→shipped→delivered` (`orders.service.ts:801-809`); confirm sets `processing` | Transition guard pattern; webhook emit points | CONFIRMED / PACKED / READY_TO_SHIP states; per-order staff assignment & processing notes; return states on fulfillment; timeline view |
| **Packaging** | Nothing (grep: zero hits) | — | `sale_packages` model, packing workflow, packaging cost capture; product-level shipping & packaging defaults |
| **Shipping** | `sales.deliveryFee` (income, server-computed from `storefront_delivery_zones`, `internal/storefront.controller.ts:322-363`); customer address concatenated into `customers.address` + sale `note` (:377-393) | Delivery-zone fee engine | No shipping address columns on sales; no courier/carrier/tracking anywhere (grep: zero hits); no shipment model; no delivery-failed flow |
| **Inventory reservation** | Full engine: `inventory_reservations` table (status `active\|confirmed\|released\|expired`, partial-unique idempotency, `expiresAt`), `createReservationsInTx` / `releaseReservationsForSaleInTx` / `confirmReservationsForSaleInTx` (`reservations.service.ts:47-240`), channel caps via `channel_inventory_allocations`, expiry sweep `src/jobs/commerceJobs.ts:14-66` (30-min hold), `getOnlineAvailability` (:243-295) | Entire engine — do not touch | POS `validateStock` ignores `reservedQuantity` (documented edge, `reservations.service.ts:22-26`) — out of scope unless requested |
| **Inventory costing** | FIFO batch consumption `consumeStockFifo` (`sales.service.ts:220-278`): batch-locked (`.for("update")`, order by `id`), decrements `inventoryBatches.quantityRemaining`, returns blended `costAtSale` persisted NOT NULL on `saleItems` (`saleItems.ts:35-39`). Online orders backfill `costAtSale` at confirmation (`orders.service.ts:394,510-513`) | `consumeStockFifo` shared by POS + online; `cost_at_sale` snapshot = historical cost (requirement met) | No per-batch breakdown table (only blended average persisted) — documented limitation, not blocking |
| **Online payments** | `online_order_payments` (one row per order, idempotent `ord-<saleId>`); verify core `orderPayments.service.ts:183-307` (server-side gateway validation + amount match + ledger + confirm in ONE tx); provider abstraction `src/services/payments/*` (SSLCommerz + mock, per-business `payment_provider_configs` AES-encrypted); `sale_payment_intents` for POS QR/card; COD = confirm-immediately (hosted storefront) or portal mark-paid | Full gateway stack; verify core; IPN handling | COD writes no `sale_payments` ledger row (`markOnlineOrderPaid`, `orders.service.ts:812-835`) — cash collection untracked; no gateway-fee fields anywhere; partial online payments unsupported (all-or-nothing unpaid→paid) |
| **Profitability reports** | `getChannelPerformanceReport` (`reports.service.ts:1665-1694`): revenue/orders/AVG per channel — revenue only. `getProfitReport` (:487-616) computes COGS from `cost_at_sale` with restock-aware refund adjustment (POS-wide, not channel-scoped) | COGS SQL patterns; refund-adjustment pattern; report route/entitlement conventions (`requireFeature("advancedReports")`) | Online profitability module entirely: gateway fees, courier, packaging, commissions, shipping income vs expense split, per-product/per-channel/per-location contribution |
| **Permissions** | Catalog `src/rbac/permissions.ts:18-111` (55 keys, `storefront.{view,manage}` newest); `requirePermission/Any/All` (`src/middleware/permissions.ts`); owner wildcard `*`; roles owner/manager/cashier/accountant with defaults (:127-213); seeded at startup `ensureRbacSeed()` `onConflictDoNothing` (`rbac/seed.ts:14-33`) — **new permissions need NO migration** | Entire RBAC stack; `stripCostData` (`rbac/sanitize.ts`) | `orders.*` action keys; `reports.online_profitability.view`; frontend nav gating |
| **Storefront integrations** | WooCommerce inbound webhook (HMAC-verified, `integrations.service.ts:858-1107`): variant mapping, `createOnlineOrder(channel:'woocommerce')`, auto-confirm/cancel, `integration_sync_logs`, retry queue. Hosted Next.js storefront via internal token (`/api/internal/storefront/*` incl. checkout + delivery-fee computation). Public API-key storefront API `/api/v1/storefront/orders` (Idempotency-Key header). Outbound business webhooks `order.created/paid/cancelled` (HMAC, backoff, dead-letter) | All of it (explicitly: do not rebuild) | Fulfillment/tracking never pushed back to Woo or storefront; `order_webhook_retry` job enqueued but **no handler branch** (`integrations.service.ts:1098` vs `:739-760`) — lost Woo webhooks; no periodic Woo order pull/reconciliation; outbound webhooks ignore endpoint `events` filter (stub `true`, `webhookDelivery.service.ts:85-88`) |

---

## 2. Backend inventory (facts the implementation must respect)

### 2.1 Sales as the order table (`src/db/schema/sales.ts:41-128`)
- `status` `saleStatusEnum` default `completed`: `pending | completed | held | cancelled | refunded` (`sales.ts:30-36`)
- `channel` `saleChannelEnum` default `pos`: `pos | woocommerce | custom_storefront` (`commerceEnums.ts:12-16`)
- `fulfillmentStatus` default `unfulfilled`: `unfulfilled | processing | shipped | delivered` (`commerceEnums.ts:18-23`)
- `paymentStatus` default `paid`: `paid | partial | unpaid` (`commerceEnums.ts:25-29`)
- `integrationId` FK, `externalOrderId`, `externalOrderNumber`, `idempotencyKey` varchar(120) UNIQUE
- `deliveryFee` numeric(10,2) default 0 — **included in `finalTotal`** (comment `sales.ts:92-97`)
- `dueAmount`, `note`, `customerId`, `shopperId` (guest = null), `cashierUserId`
- `saleDate` — **column name is `purchase_date`** (legacy quirk, `sales.ts:82`)
- `invoiceNumber` unique per (businessId, invoiceNumber); app allocates via `nextDocumentNumber(tx, businessId, "sale_invoice")` — DB default still references the legacy global sequence (`sales.ts:76-81`)
- `locationId` nullable, composite FK `(locationId, businessId)` + `sales_id_business_uq` — tenant guarantee pattern
- Indexes: `(businessId, locationId)`, `(businessId)` only — **no (businessId, channel, date) index** for order-list queries
- **No shipping address / courier / tracking / delivery-date columns.**

### 2.2 Sale items (`src/db/schema/saleItems.ts:19-70`)
- `sellingPrice`, `discount`, `lineTotal`, `taxAmount`, `taxDetail` jsonb — order-time snapshots ✔
- **`costAtSale` numeric(12,2) NOT NULL** — per-unit blended FIFO cost snapshot
- No per-line fulfillment/ship quantity (all-or-nothing order fulfillment)

### 2.3 Sale creation (POS) — `sales.service.ts:633-1112`
- One `db.transaction`; idempotency replay via `findSaleByIdempotencyKey`; variant rows locked in sorted order
- `validateStock` (`sales.validation.ts:80-121`) locks `inventoryStock` FOR UPDATE, checks `quantity` only (**ignores `reservedQuantity`**)
- Stock deduction: `consumeStockFifo` (`sales.service.ts:220-278`) — FIFO by batch `id`, row-locked, rollback-on-short; returns `{totalCost, costAtSale}`
- Movements: `movementTypeEnum` = `purchase | sale | return | adjustment | transfer_in | transfer_out` (`inventoryMovements.ts:17-24`); no batch-level consumption detail persisted on the sale line

### 2.4 Online order engine (`src/modules/commerce/orders.service.ts`)
- `createOnlineOrder` (:250-434): sale `status:'pending'`, `paymentStatus:'unpaid'`, `dueAmount=finalTotal`, channel/external ids/shopperId/deliveryFee; server-side price re-fetch; `costAtSale:0` placeholder; reservations (30-min); customer upsert by phone→email; `order.created` webhook
- `confirmOnlineOrderInTx` (:442-570): sale row FOR UPDATE → `consumeStockFifo` → `costAtSale` backfill → `inventory_stock` decrement + movement → reservations `confirmed` → `status:'completed', paymentStatus:'paid', fulfillmentStatus:'processing'` → `order.paid` webhook. ⚠️ Marks the order **paid** at confirm — correct for prepaid gateway verify flow, but portal confirm of an unpaid COD order needs the independent-payment path
- `cancelOnlineOrder` (:573-601): pending-only, releases reservations, `order.cancelled` webhook
- `updateFulfillmentStatus` (:837-875): transition map :801-809; rejects `pos`-channel sales; no event history written
- `markOnlineOrderPaid` (:812-835): sets paid + confirms; **no `sale_payments` ledger row** (method string only lands in `note`)
- COD via hosted storefront confirms immediately (`internal/storefront.controller.ts:430-436`) — stock consumed at confirm, collection not tracked as money-in

### 2.5 Reservations & availability
- `inventoryStock` aggregate per (business, variant, location), unique; `quantity` + `reservedQuantity` (`inventoryStock.ts:13-42`)
- Online available = `quantity − reservedQuantity`, capped by `reserved`-mode channel allocation (`reservations.service.ts:109-115`); two inlined copies of the formula in `integrations.service.ts:394,645`
- Reservations invisible to POS stock check (documented oversell edge)

### 2.6 Refunds (`applySaleRefund` `sales.service.ts:1113-1404`)
- Pro-rata allocation, cap at `finalTotal − prior refunds`, `saleRefunds` header (`status` = disposition `restock|inspection|damaged` — free varchar, `refundMethod` `cash|store_credit|original_payment` — free varchar, `providerRefundId`), `saleRefundItems` per line
- Restock disposition → stock increment at sale's location + new `RETURN-…` batch at `costAtSale` + `return` movement
- Provider payout post-commit (`settleProviderRefundAfterCommit` :1730-1840); exchange flow reuses refund + replacement sale (`exchangeOfSaleId`)
- **Gaps:** no fulfillment-status/reservation handling for online orders; no refund cash-out ledger row in `sale_payments` (comment :1351-1355); Woo-only refund push-back

### 2.7 Payments
- `salePayments` (`salePayments.ts:19-61`): unique (business, method, reference); schema-file CHECK `cash|bangla_qr|card|sslcommerz` **narrower than live DB** (migration 0035 adds `store_credit|loyalty_points|gift_card`) — drift to fix
- `onlineOrderPayments` (`onlineOrderPayments.ts:28-70`): per-order idempotent gateway intent; verify → ledger row (`method 'sslcommerz'`) + paid + confirm in one tx
- `paymentProviderConfigs`: per-business SSLCommerz creds (AES-256-GCM); provider interface ready for bkash/nagad/shurjopay (adapters throw "not implemented")
- **No fee/commission columns anywhere** (grep "fee" → only `deliveryFee` + zone rate)

### 2.8 Numbering, tenancy, RBAC, entitlements
- `documentSequences` + atomic `nextDocumentNumber` (`utils/documentSequence.ts:38-57`); keys `sale_invoice|purchase_order|product_sku` — adding an `online_order` key = **code-only**
- Tenancy: `requireBusinessContext()` (X-Business-Id) / `requireBusinessAccess("businessId")` (path param) → `resolveBusinessContext` (`middleware/business.ts:43-142`, re-derives permissions every request); location: `requireLocationAccess()` + `resolveOptionalLocationParam` (403 on unauthorized ids, `middleware/location.ts:188-211`); composite-FK pattern everywhere
- RBAC: catalog single-source `src/rbac/permissions.ts`; `requirePermission(key)`; permissions re-seeded from catalog at every boot (`onConflictDoNothing`) → **new keys = code-only**
- Entitlements: `PlanFeatures` jsonb (`subscriptionPlans.ts:18-43`); `requireFeature(feature)` middleware returns 403 `FEATURE_NOT_IN_PLAN` + `upgradePlans`; online-order surface already gated by `requireBusinessMode("online_only","omnichannel")`
- Audit: `auditLog` (businessId, actorUserId, action, entityType, entityId, metadata jsonb) + `recordAuditInTx` (`services/audit.ts:27-36`); indexes `(business_id, created_at)` and `(entity_type, entity_id)` — usable for order timeline but lacks structured prev/new status
- Realtime: SSE `publishRealtime` event types `sale.created | stock.changed | notification.created | held_sales.changed | register.changed` (`realtime.service.ts:112-117`) — **no online-order events**

### 2.9 Webhooks / integrations
- Outbound: `webhookDelivery.service.ts` — transactional enqueue, HMAC `X-Ezpos-Signature`, backoff, dead-letter + `notifyIntegrationFailure`; events limited to `order.created|paid|cancelled` (:23-27); endpoint `events` filter is a stub (:85-88); `sendTestEvent` wrong business scope (:217-220)
- WooCommerce: push-only sync (products/stock/customers/refunds); inbound order webhook solid; `integration_order_mappings` unique (integration, external_order); terminal-state skip; `statusVersion` counter
- Retry queue `integration_sync_jobs` (SKIP LOCKED, backoff, dead) — handles `product_push|stock_push|refund_sync` only; **`order_webhook_retry` has no branch** (silently no-ops)

### 2.10 Testing & migrations
- Node test runner via tsx (`npm test` = `tsx --test "src/**/*.test.ts"`); integration suites double-guarded (`INTEGRATION_TESTS=1` + `DATABASE_URL`), safety-abort unless `current_database() === 'ezpos_test'`; no shared helper — self-contained suites with `buildApp()` on ephemeral port, `createOwnerCtx` fixture, mock Woo HTTP server; env quirks: `AUTH_RATE_LIMIT_MAX` raised in tests, `PAYMENT_PROVIDER=mock` refused in production
- Migrations: `drizzle/NNNN_name.sql` + `meta/_journal.json` (v7); latest **0036_smart_procurement**; authored via `drizzle-kit generate`, applied `npm run db:migrate`; hand-edits happen (0033)
- 400/400 backend tests green as of feature/price-monitoring merge

---

## 3. Frontend inventory (`pos/`)

- **Routes:** single `src/routes/AppRoutes.tsx` (react-router v7, no lazy loading); `RequirePermission`/`anyPermission`/`allPermissions` guards → `/403`; `REPORTS_PERMISSIONS` array precedent (AppRoutes.tsx:41-48)
- **Nav:** `src/config/navigation.ts` — "Sales" is a flat leaf (navigation.ts:104-109); "Reports" is a group of `?tab=` links (navigation.ts:42-87); renderer filters by permission (`app-sidebar.tsx:62-88`)
- **Feature convention:** newest = `features/procurement` — `api/*.api.ts` (co-located types, `{success,data}` unwrap, `toQuery()`), `hooks/useProcurement.ts` (query-key factory, `keepPreviousData`, invalidate-root), colocated `*.test.tsx`; stated convention source: `due-management`
- **API client:** `src/api/axios.ts` — attaches `Authorization` + `X-Business-Id` + `X-Location-Id` headers; session store `auth/sessionStore.ts` (zustand) with `usePermissions()`; location switch = full reload
- **Tables:** no generic server-paginated DataTable; TanStack Table v9 pieces in `features/products/components/ProductsPage/Table/` (client-side); **`ReportTable`** (reports feature) is the only server-paginated table; best server-pagination + filters example: `PriceCheckPage.tsx` (PAGE_SIZE, filters state, keepPreviousData)
- **Reports kit (fully reusable):** `ReportHeader`, `ReportDateFilter` (period presets + location select + custom range), `ReportMetricCard`, `ReportTrendChart/BarChart/PieChart`, `StatusBadge` (extensible statusConfig), `PlanUpgradeCard` (403 FEATURE_NOT_IN_PLAN UX), `useReportData` hook, `exportToCsv`, `getPeriodDateRange` — all in `src/features/reports/`
- **Reports hub:** `ReportsHub.tsx` reads `?tab=` → switch; new tab = extend `ReportTabId` union + case
- **Toast:** Base UI — `toast.add({type,title,description})`, `createEntityPromiseToast` (`lib/toast-utils.ts:11-33`); do NOT copy the one legacy `toast.success` (react-hot-toast API) in due-management
- **Forms:** RHF + zodResolver with `z.input`/`z.output` split; `Field/FieldLabel/FieldError` primitives; product page = single form, card sections (no tabs) — a "Shipping & Packaging" card fits the left column stack (`AddProductPage.tsx:245-255`, schema `features/products/product.schema.ts`)
- **Existing online surface:** none (only `ChannelPerformanceReport` with channel labels `pos|woocommerce|custom_storefront`)
- **Types:** `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` ON — optional props need explicit `| undefined`; conditional filter objects use `...(x ? {x} : {})` spread
- **Tests:** Vitest 3 + Testing Library, colocated `*.test.tsx` beside components/pages
