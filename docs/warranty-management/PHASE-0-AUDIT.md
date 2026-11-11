# ezPos Warranty Management — Phase 0 Audit (Read-Only)

**Date:** 2026-11-12 · **Branch:** `feature/warrenty-management` · **Status:** audit only — no code modified
**Method:** five parallel read-only audit passes (products/variants/serials · sales lifecycle · purchases/suppliers · auth/RBAC/conventions · inventory/reports/notifications/testing), all line refs verified against the live tree.

---

## 1. Executive summary

- **Greenfield confirmed.** Case-insensitive search of `ezPosBackend/src` and `pos/src` for "warrant" finds only two unrelated string matches (a comment in `pricing.apply.service.ts:461`, a theme placeholder in `themes.catalog.ts:128`). No schema fields, no UI, no prior work.
- **The architecture is ready for warranty as an additive module.** Every integration point already exists:
  - Sale-time generation hooks inside `createSale`'s single transaction (`sales.service.ts:847-1599`), idempotency already solved.
  - Return invalidation inside `applySaleRefund` (`sales.service.ts:1600-2069`) — all refund paths funnel through it.
  - Supplier-side capture inside `createReceivePurchase`'s transaction (`purchases.service.ts:642-1094`).
  - Numbering via `document_sequences` (`utils/documentSequence.ts`), permissions via `PERMISSION_CATALOG` + `ensureRbacSeed`, claim history via the `sale_order_events` clone pattern, notifications via `notifyInTx`, reports via the `getBatchExpiryReport` recipe.
- **The three directives you flagged shape the design directly:**
  1. *Individual tracking* — warranty granularity follows the existing `products.trackingType`: `serial` → one warranty row per sold serial; `none`/`batch` → one quantity-based row per sale item with **zero extra cashier steps** (serials are only entered for serial-tracked products, which is today's existing POS behavior).
  2. *Warranty expiry* — computed once at sale time from `sales.saleDate`, snapshotted on the warranty row; claims validate against the stored `expiryDate`. The claim date never recalculates anything.
  3. *Supplier recovery* — supplier warranties and supplier claims are a separate subsystem (own tables, own claims, own events) with explicit `recoveryAmount` / cost fields so the shop can measure real warranty expense and supplier reimbursement.
- **Scope:** 1 additive migration (0064) with 8 new tables, a new backend `warranty` module, a new frontend feature folder + nav group, a new `warranty_certificate` document type, 8 permission keys, 1 scheduler sweep. No existing table semantics change; touches to existing files are hook calls in `sales.service.ts`, an additive receive-payload extension, additive receipt fields, and one pgEnum value addition.

---

## 2. Existing architecture

| Layer | Facts that matter for warranty |
|---|---|
| Backend | Express 5 + TypeScript + Drizzle + Zod + raw Postgres. Modules under `src/modules/*` own routes/controller/service/schema-validation; services throw typed errors (`NotFoundError`, `BadRequestError`, `ForbiddenError`, `ConflictError`, `UnauthorizedError` from `utils/handleError.ts`); controllers map via `sendSafeError` (`utils/safeError.ts`). |
| Tenancy | `requireAuth → requireBusinessContext() → requireLocationAccess() → requirePermission(key)`. businessId comes **only** from the `X-Business-Id` header (verified membership, `middleware/business.ts:171`); locationId from `X-Location-Id` with `user_location_assignments` enforcement and `resolveOptionalLocationParam` for optional `?locationId=` filters. |
| Tenancy at DB level | Every child table carries `businessId` + a `*(id, business_id)` unique candidate key; child FKs are composite tenant FKs `(col, business_id) → parent(id, business_id)`. Cross-tenant references are impossible at the FK level. |
| Frontend | React 19 + Vite + TanStack Query (query-key factories, `staleTime 30s`) + Zustand + react-hook-form + zod + shadcn-style UI kit + `@tanstack/react-table`. Axios instance auto-attaches auth/business/location/terminal headers; errors surfaced via `getErrorMessage(err)` (`response.data.message` first). |
| Money | `numeric` columns; financial spine uses numeric-as-strings (`utils/money.ts`, poisha integers); reports round via `roundMoney`. Currency BDT. |
| Time | Server UTC; business-local calendar helpers exist (`businessLocalDate`, `getBusinessTimezone`, default `Asia/Dhaka`) and are used by reports/finance. |
| Testing | Backend: node:test via `tsx --test`, integration suites hit **real Postgres `ezpos_test`** through the real app (guarded by `INTEGRATION_TESTS=1` + `current_database()==='ezpos_test'`). Frontend: vitest + jsdom + Testing Library + MSW. E2E: Playwright boots all three dev servers against a disposable DB. |

---

## 3. Relevant database tables

### Products & tracking
- **`products`** (`db/schema/products.ts:24-86`) — `businessId`, `name`, `categoryId/brandId/unitId`, `productType` ('physical'|'service'|'digital'), `hasVariants`, **`trackingType` varchar 'none'|'batch'|'serial'** (the switch that drives all serial/batch logic), `status` 'draft'|'active'|'inactive' (archive = status change; **no soft deletes anywhere**), `offlinePolicy` (serial-tracked always blocked offline). Unique `(id, businessId)`.
- **`product_variants`** (`productVariants.ts:18-98`) — composite FK `(productId, businessId)`; `sku` unique per business; `sellingPrice` numeric(12,2); `status` active|inactive; `weight/weightUnit` nullable with product fallback (**in-table override precedent**). No warranty fields.
- **`product_unit_conversions`** (`productUnitConversions.ts:40-117`) — **the canonical "product default + variant override" pattern**: `variantId` nullable with comment "NULL = product-level default; set = variant-specific override", COALESCE partial-unique index, `status` active|inactive. Transaction lines carry **snapshot columns** so history never depends on current config.
- **`serial_numbers`** (`serialNumbers.ts:27-81`) — enum `serial_status`: `in_stock, reserved, sold, returned, in_repair, damaged, lost`. `serialNumber` varchar(100) **unique per business**; `batchId`, `purchaseItemId`, `saleItemId` nullable composite FKs; `soldAt`. **No IMEI column; no createdAt.** `in_repair` and `reserved` are defined but written by no module today — free for warranty use.
- **`inventory_batches`** (`inventoryBatches.ts:18-99`) — `purchaseItemId` composite FK (sale→batch→purchase traceability), `purchasePrice` numeric(14,6) (session cost, never modified by landed cost), `quantityReceived/Remaining`, `expiryDate` (existing expiry analog).

### Sales
- **`sales`** (`sales.ts`) — enum `sale_status`: `pending | completed | held | cancelled | refunded`, **default `completed` — POS sales are born completed**; `payment_status` paid|partial|unpaid; `channel` pos|woocommerce|custom_storefront|offline; `saleDate` = business-effective date; `idempotencyKey` unique per business; invoice number `INV-<year>-<6digits>` from `document_sequences`.
- **`sale_items`** — quantity in **base units** (UOM snapshots as display columns), `costAtSale`, price/tax snapshots. **No `returnedQuantity` column** — returned qty is derived by summing `sale_refund_items` per `sale_item_id`.
- **`sale_refunds` / `sale_refund_items`** — refund "status" column is actually the **disposition** (`restock|inspection|damaged`), not lifecycle. `sale_refund_items` has **no serial column**; partial serial returns require explicit `options.serialIds` per sale item (enforced in `applySaleRefund:1848-1873`). Restock repoints returned serials' `batchId` to a `RETURN-*` batch (supplier trace must use `serial_numbers.purchaseItemId`, not current batchId).
- **`sale_item_batch_consumptions`** — one row per (saleItem × batch): the non-serial traceability link into `inventory_batches.purchaseItemId`.
- **`held_sales`** — separate table; resume rebuilds the cart from live catalog and flows through the normal `POST /api/sales`, so held sales need no special warranty handling.
- Cancellation: **no POS sale-cancel endpoint exists.** Only `pending` online orders can be cancelled (they never consumed stock, so they never generate warranties). A full return flips sale status to `refunded` exactly once (`sales.service.ts:2015-2018`).

### Purchases & suppliers
- **`purchases`** — shared pgEnum `status` (`enums.ts:3`): `ordered | received | partially_received` (shared enum — **do not extend**; new tables use varchar+CHECK per the 0063 convention). `payment_status` paid|unpaid|partial; `dueAmount` maintained operationally.
- **`purchase_items`** — ordered `quantity` never mutated; cumulative `receivedQuantity/deliveredQuantity/rejectedQuantity/cancelledQuantity` numeric(12,3); `unitCost` **immutable after PO creation** (receiving cost lands on batch rows — "D1" invariant).
- **`purchase_receiving_records`** — one row per item per receive submission (CHECK `delivered = accepted + rejected`); **`purchase_discrepancies`** — types `over_receival|shortage|rejection|cancellation`, resolutions incl. **`replacement`** and `supplier_credit` (currently recording-only — natural spawn point for supplier claims).
- **`suppliers`** — contact fields + procurement settings; **no warranty fields**. **`supplier_ledger`** — credit-only in practice (`PURCHASE_RETURN`, `PURCHASE_CANCELLATION`); nothing consumes credits; the payable is computed from purchases/payments/returns, not the ledger.

### Infrastructure to reuse
- **`document_sequences`** — `nextDocumentNumber(tx, businessId, key)` allocates gap-free, rollback-safe numbers **inside the caller's tx**; keys today: `sale_invoice`, `purchase_order`, `product_sku`. Warranty adds `customer_warranty`, `warranty_claim`, `supplier_warranty_claim`.
- **`document_settings`** — PK `(business_id, doc_type)`; `document_type` pgEnum currently `sales_receipt | sales_invoice`; the file explicitly reserves new enum values for future document kinds → `warranty_certificate` slot.
- **`notifications` / `notification_reads` / `notification_prefs`** — business-wide rows, per-user reads, per-user mutes; `dedupeKey` unique per business (embed day). `notifyInTx(tx, input)` is transaction-safe. Email exists (owner-only, best-effort); **no SMS/WhatsApp**.
- **`audit_log`** + `recordAuditInTx` — dot-namespaced actions (`sale.create`), entity refs, jsonb metadata.
- **`sale_order_events`** — **the established append-only status-history pattern** (`recordOrderEventInTx`: previousStatus/newStatus/actor/note/metadata, indexed `(saleId, createdAt)`, rows never updated). Claim history clones it.

---

## 4. Backend routes & services (exact hook points)

| Concern | File:lines | Fact |
|---|---|---|
| Sale creation | `sales.service.ts:847-1599` | One `db.transaction`. Idempotency pre-check (`:869-877`) replays **before** any item work — retries can never duplicate warranties. Per-item loop locks serials (`consumeSerials :404-509`, sets `sold`), FIFO-consumes stock, inserts sale_items, consumption rows, **links `serial_numbers.sale_item_id` at `:1299-1317`** — the moment both `saleItem.id` and concrete `serialIds` exist = **warranty generation point**. Covers POS, offline outbox replays (`sync.service.ts:403-453` calls the same service), and online-order creation. |
| Exchange | `sales.service.ts:2551-3037` | Inserts its own replacement sale items (`:2790-2817`), bypassing the createSale loop → generation must be a **shared helper** called in both paths. Serial-tracked replacements are rejected in exchange v1 (`:2662-2668`). |
| Refunds (all paths) | `applySaleRefund :1600-2069` | Single-item (`:2071`), whole-sale (`:2171`), and exchange (`:2634`) all funnel here. Per-line quantities from `options.quantities`; serial disposition at `:1816-1873` (restock→in_stock, damaged→damaged, else→returned); full-return flips sale to `refunded` at `:2015-2018` = **warranty invalidation points**. Refunds blocked unless sale is `completed`. |
| Receipt assembly | `getSaleReceipt :516-705` | Single assembly point (used by create response, replay, and `GET /api/sales/:id/receipt`). **Does not currently include serials** — needs an additive join on `serial_numbers.saleItemId` for warranty lines. |
| Receive goods | `purchases.service.ts:642-1094` | One tx: UOM normalize → per-line validation → `updatePurchaseItems` → `incrementStockForReceive` + movement → `insertInventoryBatches` (`receive.service.ts:67-129`, auto batch `AUTO-{purchaseItemId}-{ts}`) → `insertSerialNumbers` (`:130-151`, sets purchaseItemId+batchId+locationId) → receiving records + discrepancies → landed-cost delta → payments → GL. **Supplier-warranty capture inserts here** (per line at `:741-793` where acceptedQuantity and session cost are known). |
| Purchase returns | `purchaseReturn.service.ts:50-573` | Returns at the purchase's receiving location; batch pool FIFO per PO (never crosses POs); explicit serial selection; `markSerialsReturned`; stock decrement + `adjustment` movement; supplierLedger credit `PURCHASE_RETURN`; GL DR 2010/CR 1050. |
| Inventory primitives | `inventory.service.ts` | `recordStockMovement`, `incrementStockForReceive`, `decrementStockGuarded` (guarded upsert, never negative), `markSerialsReturned`. Movement enum has no `warranty` value → use `adjustment`/`return` + polymorphic `referenceType: 'warranty_replacement'` (deliberately FK-less). |
| Permission seeding | `rbac/permissions.ts:18-205`, `rbac/seed.ts` | `PERMISSION_CATALOG` is the single source of truth; `ensureRbacSeed()` inserts keys at startup (idempotent) but **never grants** — grants for existing roles must come from the migration (0063:343-384 pattern). Frontend mirror: `pos/src/lib/rbac.ts` must be updated in lockstep. |
| Middleware wiring | `expenses.routes.ts:11-18` is the modern template | `read = [requireAuth, requireBusinessContext(), requireLocationAccess()]`; `write = [...read, requireFullAccess]`; per-route `requirePermission("...")`. |

---

## 5. Relevant frontend components

| Area | Files | Notes |
|---|---|---|
| Product form | `pos/src/features/products/pages/AddProductPage.tsx` (RHF+zod+useFieldArray), cards in `components/addProductPage/` | Left column card list (GeneralInfo → Shipping → Variants → UnitsPackaging) — a `WarrantyInfoCard` slots after ShippingInfoCard. Variant-override manager precedent: `UnitsPackagingCard.tsx` (post-create, per-variant rows). Schemas mirrored in `product.schema.ts` (frontend) + `addProduct/schemas/product.schema.ts` (backend). |
| POS checkout | `features/pos/pages/PosPage.tsx` (`onSubmit :92-231`), `stores/useCartStore.ts` | Serial entry already exists and only fires for `trackingType === "serial"` (`ProductList.tsx:133-137` opens `SerialPickerDialog` before the line is added; cart shows a "Serials (n)" button). **Non-serial products already have zero serial steps — directive #1 requires no checkout change.** Idempotency key claimed via `beginCheckout()`. |
| Sale success | `features/pos/components/receipt/SaleSuccessDialog.tsx` | Natural home for "Print Warranty Certificate". |
| Receipt/invoice renderers | `features/receipt-settings/renderers/receiptHtml.ts` (itemSubLines slot `:102-120`), `invoiceHtml.ts`; printing via `usePrintReceipt.ts` iframe pattern | Per-line warranty text renders in `itemSubLines`; a certificate is a new sibling renderer consuming documentSettings config (logo/contact already embedded server-side). ESC/POS hardware path prints a field subset only — certificate uses the browser render path. |
| Lists | `features/pos/pages/Sales.tsx` + `SalesDataTable.tsx` (@tanstack/react-table), shared table kit in `features/products/components/ProductsPage/Table/`, page shell `components/common/EntityListLayout.tsx` | Registry/claims lists copy this kit. |
| Reports | `features/reports/pages/ReportsHub.tsx` (`?tab=` registry), `BatchExpiryReport.tsx` is the complete page template (filters → `useReportData` → metric cards → `ReportTable` → CSV) | Warranty reports = new tabs + pages reusing `ReportHeader/ReportDateFilter/ReportMetricCard/ReportTable/exportToCsv`. |
| Nav & guards | `config/navigation.ts` (auto-filtered by permission), `routes/AppRoutes.tsx` (RequirePermission), `components/common/PermissionGuard.tsx`, `hooks/usePermissions.ts` | New "Warranty Management" nav group = array entry + route children. |

---

## 6. Reusable functionality (do not rebuild)

1. `nextDocumentNumber(tx, businessId, key)` — warranty/claim numbering.
2. `PERMISSION_CATALOG` + `ensureRbacSeed` + migration grant pattern + `pos/src/lib/rbac.ts` matrix.
3. `notifyInTx` + notification reads/prefs endpoints (add `warranty_*` kinds to the `NotificationKind` union and prefs list).
4. `recordOrderEventInTx`-style append-only event tables → claim history.
5. `recordAuditInTx` for audit actions (`warranty.claim.create` etc.).
6. Inventory primitives + movement conventions for replacement stock (no bare writes outside a tx).
7. Batch-expiry report recipe (backend service + ReportsHub page) — the expiry-report is a table swap.
8. Receipt renderer + `usePrintReceipt` + `document_settings` for the certificate.
9. Expense module for formal repair-cost posting (manual, `referenceNo` = claim number) — **no automatic GL postings** (implementation rule 14).
10. Integration test harness (`helpers/fixtures.ts` owner context, real app over HTTP) and Playwright journeys.

---

## 7. Missing functionality (what must be built)

1. Product/variant warranty configuration storage + resolution (product default → variant override).
2. Warranty generation at sale completion (per-serial and per-line quantity rows, snapshot terms, expiry math incl. month-end/leap-year).
3. Warranty registry + lookup (by serial / invoice / customer / phone).
4. Claim lifecycle with enforced transitions, history, repair/replacement records, assignment.
5. Supplier warranty capture at receiving (+ retroactive manual entry for historical POs) and the supplier claim subsystem with recovery tracking.
6. Partial-return / full-return / replacement invalidation hooks.
7. Warranty certificate document type + renderer.
8. Warranty reports + overview stats.
9. Expiring-soon + claim-status notifications (in-app only) via a scheduler sweep.
10. Permission keys, nav group, routes, frontend feature folder.

---

## 8. Compatibility issues & risks

1. **No `returnedQuantity` on `sale_items`** — partial-return state must be recomputed from `sale_refund_items`; warranty invalidation hooks receive the refund quantities/serialIds from `applySaleRefund` options, so no new aggregation is needed at hook time.
2. **`sale_refund_items` has no serial column** — partial serial returns already require `options.serialIds`; quantity-based warranties rely on refund quantities (all units of a line share identical terms, so no per-unit allocation ambiguity exists).
3. **Restock repoints `serial.batchId`** to `RETURN-*` batches — supplier traceability must use `serial_numbers.purchaseItemId` (set only by purchase receiving).
4. **Shared `status` pgEnum** (`enums.ts:3`) must not be extended — all new tables use `varchar` + CHECK constraints (0063 convention).
5. **`document_type` pgEnum** needs `ALTER TYPE ... ADD VALUE 'warranty_certificate'` (additive; safe).
6. **Drizzle INSERT gotcha** — drizzle includes defaulted columns in every INSERT; new NOT NULL columns on existing tables would need DEFAULTs (we add no columns to existing tables; new tables are unaffected).
7. **Exchange path bypasses the createSale item loop** — generation must be a shared helper invoked in both paths; serial-tracked exchange replacements are already rejected.
8. **LAN sync** — sale-time generation rides `createSale`, which both the cloud and the LAN server execute, so offline-sale warranties materialize in each store's DB via replay. Warranty **claims** are shop-office operations: online-only in v1 (claims created on a LAN server would not sync up). Accepted limitation, documented.
9. **Serial re-receive uniqueness** — a repaired unit returning from a supplier keeps its original `serial_numbers` row (status flips `in_repair → in_stock`), so the per-business serial uniqueness constraint is never violated. Replacement units (different physical unit) enter via stock adjustment or PO receive, never by re-inserting the same serial.
10. **Archived products** — products are never deleted (status only; FK RESTRICT everywhere), so historical warranties always resolve; the warranty config UI must tolerate inactive products.
11. **Envelope drift** — list endpoints disagree on pagination shapes; warranty endpoints standardize on the newest (expenses) convention: `page`/`page_size` query params → `{ success, data, meta: { page, pageSize, total, totalPages } }`.
12. **Frontend rbac mirror drift** — `pos/src/lib/rbac.ts` must gain the warranty keys or the Roles matrix misses them.
13. **Test infra** — integration suites need `INTEGRATION_TESTS=1` + a valid `DATABASE_URL` against `ezpos_test` (the checked-in `.env` has been broken before); frontend gate is `vite build` with 4 known pre-existing `terminalBinding` failures.

---

## 9. Security analysis

- **Risks identified:** cross-business warranty reads (mitigated: header-only tenancy + composite tenant FKs + per-query `businessId` scoping; foreign IDs are indistinguishable from missing → 404); forged expiry/eligibility from the client (mitigated: expiry computed server-side at generation, eligibility validated server-side at claim time); privilege escalation on claim transitions (mitigated: transition map enforced in the service + per-action permission keys); location leakage (mitigated: `resolveOptionalLocationParam` validation, `locationId` from middleware only); duplicate-number collisions across businesses (mitigated: per-business uniques); history tampering (mitigated: append-only event tables, no delete endpoints, void-over-delete).
- **Rules honored:** no businessId/locationId/customerId/warrantyId from the body; every service takes the verified `businessId`; Zod validation on every body/query with `safeParse` + `validationError`; transactions for multi-row writes; no automatic financial postings; no stock writes outside inventory conventions.

---

## 10. Proposed implementation architecture

**Backend** — new module `src/modules/warranty/` (routes/controller/service/schemas) + `src/modules/warranty/supplier.*` + `src/db/schema/warranties.ts` & `supplierWarranties.ts` + `src/jobs/warrantyJobs.ts` + expiry/transition helpers in the module.

- **Config resolution:** variant-specific row → product-default row → no warranty. `enabled=false` on a variant row = explicit opt-out (Football: Small none / Medium 30d / Large 90d).
- **Generation (`createWarrantiesForSaleItems(tx, ctx)`)** called inside `createSale` (after serial linkage) and inside `createSaleExchange` (replacement items):
  - `trackingType === 'serial'` → one `customer_warranties` row per sold serial (`serialId` FK, `quantity=1`).
  - otherwise → one row per sale item (`quantity = line quantity`).
  - All terms snapshotted from the resolved config; `startDate = sales.saleDate`; `expiryDate = addWarrantyDuration(startDate, duration, unit)` with month-end clamping (Jan 31 + 1mo → Feb 28/29, leap-year safe); `warrantyNumber` via `nextDocumentNumber(tx, businessId, 'customer_warranty')` formatted `WRN-<year>-<6digits>`.
  - Idempotency: partial unique indexes — one warranty per `(saleItemId)` where `serialId IS NULL`, one per `serialId` where not null — make duplicate generation impossible regardless of code path; the existing idempotency replay returns before generation anyway.
- **Invalidation:** in `applySaleRefund` — serial rows whose `serialId ∈ options.serialIds` → `voided` (reason `sale_return:<refundId>`); quantity rows: `returnedQuantity += k`, `voided` when exhausted; on full-return (`status → 'refunded'`) every remaining warranty of the sale is voided. Claims block on voided warranties; rejected claims do **not** void warranties; a warranty keeps accepting claims while units remain covered and unexpired (multi-claim allowed).
- **Claim state machine (enforced map in service):** `submitted → under_inspection → (approved → repairing ⇄ waiting_parts → ready_for_pickup → closed) | rejected` plus `replaced → closed`; `cancelled` from any non-terminal state. Each transition writes a `warranty_claim_events` row + audit entry; per-action permission checks. Under repair, a serial-tracked unit's serial flips to `in_repair`, restored on resolution. Replacement: decrements replacement stock via `decrementStockGuarded` + `adjustment` movement (`referenceType 'warranty_replacement'`), links the replacement serial (if any) to the original sale item, and creates a **new** `customer_warranties` row for the replacement inheriting the original `expiryDate` (linked via `replacedFromWarrantyId`) — never a sale, never a financial posting.
- **Supplier subsystem:** capture (optional per-line fields) inside `createReceivePurchase`'s tx → one `supplier_warranties` row per purchase item (start = first receive date; serials identified at claim time, not per-serial rows); retroactive manual creation for historical POs. Supplier claims are fully separate: own numbers (`SWC-…`), own statuses (`submitted → sent_to_supplier → under_repair | replaced | rejected | closed/cancelled`), own events, explicit `defectiveQuantity`, `replacementQuantity`/`replacementSerialNumbers`, `recoveryAmount` + `recoveryMethod` (credit_note | replacement | cash | none). Optional `customerWarrantyClaimId` link gives claim-to-supplier traceability. Repaired units: serial status flips back (no re-receive); brand-new replacement units: stock adjustment intake linked to the claim (no payable distortion) or receive into the PO while it still has outstanding quantity.
- **Frontend** — `pos/src/features/warranty/` (pages/components/hooks/api/types) + `WarrantyInfoCard` in the product form + receipt/certificate renderer + nav group.

---

## 11. Proposed database design (migration `0064_warranty_management.sql`, additive only)

All tables: `id` serial PK, `businessId` NOT NULL FK→businesses CASCADE, `id_business_uq` unique `(id, business_id)` (composite-FK candidate keys), `created_at/updated_at timestamptz DEFAULT now()`, business index. Enums as `varchar` + CHECK. **Rollback = DROP the 8 tables + permission rows.**

1. **`product_warranty_configs`** — `productId` (CFK→products), `variantId` **nullable** (CFK→product_variants; NULL = product default), `enabled` bool default true, `provider` CHECK(manufacturer|seller|distributor|supplier|third_party), `warrantyType` CHECK(repair|replacement|service|limited|parts_only|comprehensive), `duration` int, `durationUnit` CHECK(days|months|years), `terms` text, `status` CHECK(active|inactive). Unique `(productId, COALESCE(variantId,0))`. (UOM pattern.)
2. **`customer_warranties`** — `locationId` CFK, `warrantyNumber` unique per business, `saleId`/`saleItemId`/`customerId` (nullable for walk-in)/`productId`/`variantId` CFKs (RESTRICT), `serialId` nullable CFK→serial_numbers + `serialNumber` snapshot varchar, `quantity` int default 1, `returnedQuantity` int default 0, snapshot columns (`provider`, `warrantyType`, `duration`, `durationUnit`, `terms`, `startDate`, `expiryDate`), `status` CHECK(active|voided|replaced|suspended) — **expired is derived from `expiryDate`**, `voidedAt`/`voidReason`. Indexes: `(businessId, status)`, `(businessId, expiryDate)`, `(customerId)`, `(saleItemId)`, partial unique `(serialId) WHERE serialId IS NOT NULL`, partial unique `(saleItemId) WHERE serialId IS NULL`.
3. **`warranty_claims`** — `locationId`, `claimNumber` unique per business, `warrantyId` CFK→customer_warranties, `customerId`/`productId`/`variantId`/`serialId` (denormalized for list speed), `claimType` CHECK(repair|replacement|parts_replacement|service), `status` CHECK(submitted|under_inspection|approved|rejected|repairing|waiting_parts|ready_for_pickup|replaced|closed|cancelled), `resolutionType` CHECK nullable, `reportedProblem` text, `inspectionNotes` text, `assignedUserId` CFK nullable, `receivedDate/resolvedDate/closedDate`, repair block (`repairDescription`, `partsUsed` text, `repairCost` numeric(12,2) default 0), replacement block (`replacementVariantId` CFK nullable, `replacementSerialNumber`, `replacementDate`, `pickupDate`, `newWarrantyId` CFK nullable), `resolutionNotes`. Index `(businessId, status)`, `(warrantyId)`, `(assignedUserId)`.
4. **`warranty_claim_events`** — clone of `sale_order_events`: `claimId` CFK, `warrantyId`, `eventType`, `previousStatus`, `newStatus`, `actorType` CHECK(user|system), `actorUserId`, `actorLabel`, `note`, `metadata` jsonb. Append-only; index `(claimId, createdAt)`.
5. **`supplier_warranties`** — `supplierId`/`purchaseId`/`purchaseItemId`/`productId`/`variantId` CFKs, `batchId` nullable CFK, `provider` default 'supplier', `duration`/`durationUnit`/`terms` snapshots, `quantity` int (received units covered), `claimedQuantity` int default 0, `startDate`/`expiryDate`, `status` CHECK(active|voided|exhausted) (expired derived), `source` CHECK(receive|manual). Unique `(purchaseItemId)` (prevents duplicate creation by receive + retroactive entry).
6. **`supplier_warranty_claims`** — `locationId`, `claimNumber` unique per business, `supplierWarrantyId` CFK, `supplierId`/`purchaseId`/`productId`/`variantId`, `customerWarrantyClaimId` nullable CFK (traceability), `defectiveQuantity`, `serialIds` jsonb nullable, `issueDescription`, `status` CHECK(submitted|sent_to_supplier|under_repair|replaced|rejected|closed|cancelled), replacement block (`replacementQuantity`, `replacementSerialNumbers` text, `replacementReceivedDate`), recovery block (`recoveryAmount` numeric(12,2) default 0, `recoveryMethod` CHECK(credit_note|replacement|cash|none), `recoveryReferenceId` int nullable), `costAmount` numeric(12,2) default 0, `submittedDate/respondedDate/resolvedDate/closedDate`, `notes`.
7. **`supplier_warranty_claim_events`** — same clone pattern keyed to supplier claims.
8. **Document type** — `ALTER TYPE document_type ADD VALUE 'warranty_certificate'` (frontend renderer + per-business config in `document_settings`).
9. **Permissions** — `INSERT INTO permissions … ON CONFLICT DO NOTHING` for the 8 keys + grants to owner/manager/cashier role templates (0063:343-384 pattern) **and** `PERMISSION_CATALOG` additions for new businesses.

**Data migration:** none required (no historical warranties exist). Backward compatibility: purely additive; existing behavior unchanged; products without config remain fully usable; sales without warranties unaffected.

---

## 12. Proposed API endpoints

Middleware per route: `read = [requireAuth, requireBusinessContext(), requireLocationAccess()]`, `write = [...read, requireFullAccess]`, plus per-route `requirePermission`. Tenancy from headers only; `?locationId=` via `resolveOptionalLocationParam`.

**Product warranty config**
- `GET /api/products/:productId/warranty-config` · `PUT /api/products/:productId/warranty-config` (product default)
- `PUT /api/products/:productId/variants/:variantId/warranty-config` (create/update override; body `enabled:false` = opt-out) — permission `warranty.config.manage`

**Customer warranties**
- `GET /api/warranties` — filters: `status` (active|expiring|expired|voided), `search` (number/serial/invoice), `customerId`, `productId`, `variantId`, `date_from/date_to`, `locationId`, `page/page_size`
- `GET /api/warranties/:id` — detail incl. claims + timeline pointers
- `GET /api/warranties/lookup?type=serial|invoice|phone&q=…` — cashier claim entry point (phone filtered server-side)
- `GET /api/warranties/:id/certificate` — certificate payload (business branding + doc settings)

**Warranty claims** (permission `warranty.claim.create` for create; `warranty.claim.manage` for the rest; close/cancel = `warranty.claim.close`)
- `POST /api/warranty-claims` (validates eligibility server-side: unexpired, not voided, remaining covered quantity, no blocking open claim)
- `GET /api/warranty-claims` · `GET /api/warranty-claims/:id` (detail + events)
- Action endpoints, each appending an event: `POST /:id/inspection` · `/:id/approve` · `/:id/reject` · `/:id/repair` (start/update: description, parts, cost, assignee) · `/:id/ready` · `/:id/pickup` · `/:id/replacement` (stock movement + new warranty row) · `/:id/close` · `/:id/cancel`

**Supplier warranties** (`warranty.supplier.view` / `warranty.supplier.manage`)
- `GET /api/supplier-warranties` · `POST /api/supplier-warranties` (retroactive/manual; rejects duplicates per purchase item)
- `POST /api/supplier-warranty-claims` · `GET /api/supplier-warranty-claims` · `GET /:id` (+events)
- `POST /:id/response` (approve/reject/under_repair + notes) · `/:id/replacement` (qty, serials, intake mode) · `/:id/recovery` (amount/method) · `/:id/close` · `/:id/cancel`

**Reports & overview**
- `GET /api/warranty-overview` — dashboard cards (active, expiring-30d, expired, open claims, pending inspection, in repair, ready for pickup, repair cost total)
- `GET /api/reports/warranty/expiry` · `/warranty/claims` · `/warranty/costs` · `/warranty/supplier` — batch-expiry recipe; `{ data, total, page, limit }`; claim-rate denominators stated explicitly (claims per units-sold-with-warranty; units affected counted separately from claim count)

**Receipt (additive)** — `getSaleReceipt` gains per-line `serialNumbers` + warranty summary (`provider`, duration, valid-until) so existing receipt/invoice renderers show warranty sub-lines; certificate is a separate doc type.

---

## 13. Proposed UI

- **Nav group "Warranty Management"** (`config/navigation.ts`, permission-gated): Overview · Warranty Registry · Warranty Claims · Supplier Warranties · Supplier Claims · Warranty Reports. Routes in `AppRoutes.tsx` under `RequirePermission`.
- **Overview** — metric cards from `/api/warranty-overview`, recent claims list, expiring-soon table.
- **Registry** — tanstack-table list (number, customer, product, variant, serial, invoice, start, expiry, status, actions: view / print certificate / view sale / create claim / claim history) + filters (status, date range, product, variant, customer, location, provider) + search across number/serial/invoice/phone.
- **Claims** — list with status filters; creation wizard (search warranty → eligibility check → original sale view → problem description → submit); detail page with customer/product/serial/warranty panel, original invoice link, previous claims, inspection/repair/replacement sections, and the **activity timeline** from `warranty_claim_events`; transition buttons gated by `usePermissions`.
- **Supplier pages** — registry per purchase item (status incl. expiring, claimed/remaining quantity); claims list/detail with defective units, supplier response, replacement recording, recovery amount, timeline.
- **Product form** — `WarrantyInfoCard` (enable, provider, type, duration + unit, terms) after `ShippingInfoCard`; variant overrides via expanded variant rows (inherited vs overridden clearly displayed; "No warranty" per variant supported).
- **POS** — **no checkout changes for non-serial products** (directive #1); serial picker unchanged for serial-tracked products; receipt/invoice gain warranty sub-lines via `itemSubLines`; `SaleSuccessDialog` gains "Print Warranty Certificate"; certificate = professional printable HTML (logo/contact from `document_settings`, new `warranty_certificate` doc type + renderer beside `receiptHtml.ts`).
- **Reports** — four ReportsHub tabs (expiry, claims, costs, supplier) built on the BatchExpiryReport template.

---

## 14. Testing strategy

- **Backend unit (node:test, colocated):** `addWarrantyDuration` (month-end Jan 31→Feb 28, leap years, days/months/years, inclusive-expiry rule), config resolution precedence, claim transition map (valid + invalid), number formatting.
- **Backend integration (`INTEGRATION_TESTS=1`, real `ezpos_test`, HTTP against the real app):** generation (qty-3 line → 1 quantity row; serial line → 3 rows, one per serial); no-warranty product → no rows; sale retry/idempotency → no duplicates; walk-in customer → warranty with null customer; exchange replacement → shared-helper generation; partial serial return → only those serials' warranties voided; partial quantity return → `returnedQuantity` increments, others intact; full return → all voided; claim lifecycle happy path + every invalid transition rejected; expired/voided claim rejected; replacement flow stock math; supplier warranty capture on receive + retroactive create + duplicate rejection; supplier claim → replacement + recovery; business isolation (second business gets 404); location filtering; permission denials (cashier cannot approve).
- **Frontend (vitest + MSW):** WarrantyInfoCard validation + variant override display; registry filters/search; claim creation wizard eligibility states; claim detail timeline; permission-gated actions; loading/empty/error states.
- **E2E (Playwright):** prompt scenarios 1–10 (normal warranty, no-warranty product, serial/IMEI, multi-quantity, claim lifecycle, expired claim, partial return, supplier warranty, multi-location/multi-business isolation, regression run of existing journeys).
- **Gates:** backend `npm test` (integration suites require valid `DATABASE_URL` — known .env issue), frontend `vitest run` (4 pre-existing `terminalBinding` failures are the documented baseline) + `vite build`, Playwright journeys for the key scenarios.

---

## 15. Implementation phases (prompt §16 order; report + commit per phase)

| Phase | Deliverable | Key content |
|---|---|---|
| 1 | DB & architecture | Migration 0064, schema TS, config endpoints, permission catalog+grants, product-form `WarrantyInfoCard` + variant overrides |
| 2 | Warranty engine | Expiry service, `createWarrantiesForSaleItems` shared helper wired into `createSale` + exchange, refund/full-return invalidation hooks, unit+integration tests |
| 3 | Backend API | Registry/lookup/claims/supplier/report endpoints per §12, transition map, Zod schemas, pagination envelope |
| 4 | Warranty UI | Nav group, Overview, Registry, Claims list/detail/timeline, certificate renderer + document type, receipt sub-lines, POS certificate button |
| 5 | Supplier warranty | Receive capture, retroactive entry, supplier registry + claims UI, replacement/recovery flows |
| 6 | Reports | Overview endpoint + 4 report pages |
| 7 | Notifications | `warranty_*` kinds, `runWarrantySweeps` (expiring 30/7d, ready-for-pickup aging, supplier-claim aging), prefs wiring |
| 8 | Permissions & security | Full RBAC verification, cross-tenant tests, permission matrix UX |
| 9 | E2E & hardening | Scenarios 1–10, regression pass, delivery docs (architecture/DB/API/workflow/permissions/migration/deployment) |

---

## 16. Estimated complexity & dependencies

- **Size:** 8 new tables · 1 migration · ~10 backend files (module + schema + job + tests) · ~20 frontend files · 2 renderers · 8 permission keys. Largest risk surface: `sales.service.ts` hooks (2 700+ line file — hook calls must be additive and transaction-safe) and the receive-flow payload extension.
- **Dependencies:** valid `DATABASE_URL` for integration suites (known broken-.env history); `ezpos_test` DB for E2E; no new npm packages; no SMS/email infra (in-app notifications only); no changes to existing table semantics.
- **Explicit non-goals (v1):** automatic GL postings for warranty costs; SMS/WhatsApp; per-serial supplier warranty rows; warranty claims from LAN offline mode; selling warranty extensions as paid add-ons.

---

## 17. Decisions requiring your approval

| # | Decision | Recommendation |
|---|---|---|
| D1 | Warranty config storage | **Separate `product_warranty_configs` table** with nullable `variantId` (the codebase's own UOM override pattern) — not columns on products/variants |
| D2 | Quantity-based granularity | **One warranty row per sale item** (`quantity` + `returnedQuantity`) — all units of a line share identical terms, so partial returns need no per-unit allocation; serial products get per-serial rows (your directive #1) |
| D3 | "Expired" status | **Derived from `expiryDate`**, not stored; stored statuses: active/voided/replaced/suspended — avoids a daily mass-update job |
| D4 | Serial requirement | **Follows `products.trackingType`** — no separate "serial required" flag; ordinary products never ask cashiers for serials |
| D5 | IMEI | **Single serial field** (cashiers enter IMEI as the serial — existing behavior); no separate IMEI column in v1 |
| D6 | Replacement warranty | Replacement unit gets a **new warranty row inheriting the original expiry**, linked to the claim |
| D7 | Supplier warranty granularity | **One row per purchase item**; defective serials identified at claim time |
| D8 | Supplier replacement intake | Repaired units: serial status flip (no re-receive). New replacement units: **stock adjustment linked to the claim** (no payable distortion), or receive into the PO while outstanding remains |
| D9 | Reminders | **In-app only, fixed 30/7-day windows** (no SMS/email infra); configurable in a later phase |
| D10 | Claims offline | **Online-only in v1** (sale-time generation already covers offline sales via replay) |

**Approval checklist:** approve the audit → approve the database design (§11) + decisions D1–D10 (or override any) → Phase 1 starts.
