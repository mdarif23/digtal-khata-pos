# Warranty Management — Backend Phases 1–7 Report

**Date:** 2026-11-12 · **Branch:** `feature/warrenty-management`
Covers prompt phases 1 (DB), 2 (engine), 3 (API), 5 (supplier, backend), 6 (reports, backend), 7 (notifications, backend). Frontend phases 4–6 follow in a separate commit.

## Completed work

1. **Migration `0064_warranty_management.sql`** (additive only; journal entry appended): 7 new tables, `document_type` += `warranty_certificate`, 8 permission keys + grants (sales.view roles → view/create; sales.return roles → manage).
2. **Schema TS:** `db/schema/warranties.ts` (productWarrantyConfigs, customerWarranties, warrantyClaims, warrantyClaimEvents) + `db/schema/supplierWarranties.ts` (supplierWarranties, supplierWarrantyClaims, supplierWarrantyClaimEvents). customers/serial_numbers/users get plain FKs (no composite candidate key exists — matches sales.customerId precedent); everything else composite tenant FKs.
3. **Engine** (`modules/warranty/warrantyEngine.service.ts`): `addWarrantyDuration` with month-end + leap-year clamping (verified: Feb 29 + 1y → Feb 28; Jan 31 + 1mo → Feb 28/29); `resolveWarrantyConfig` (variant row → product row → none); `createWarrantiesForSaleItems` (per-serial rows for trackingType='serial', one quantity row per sale item otherwise; snapshot terms; expiry from `sales.saleDate`; documentSequence `customer_warranty` numbers WRN-YYYY-NNNNNN); `applyRefundWarrantyEffects` + `voidWarrantiesForSale` (D2); `isWarrantyClaimable` (derived expiry, inclusive expiry-day rule).
4. **Sale hooks** (`sales.service.ts`): generation after the per-item loop (createSale) and after replacement items (createSaleExchange); `trustedItems`/`trustedReplacements` now carry `productId`. Idempotency preserved (replay returns before generation; partial unique indexes backstop duplicates). Refund hooks in `applySaleRefund`: serial warranties void per returned serialIds; quantity warranties increment `returned_quantity` and void when exhausted; full return (sale → refunded) voids all remaining warranties of the sale.
5. **Config API:** GET/PUT `/api/products/:productId/warranty-config`, PUT/DELETE `.../variants/:variantId/warranty-config` (`warranty.config.manage`), select-then-upsert per the UOM admin pattern.
6. **Registry + claims + supplier API** (`modules/warranty/warranty.routes.ts`, registered in app.ts): list (derived status filter incl. expiring-30d, search over number/serial/invoice/customer, location filter via `resolveOptionalLocationParam`), lookup (serial/invoice/phone/number), detail, certificate payload, claims CRUD + lifecycle actions (inspection/approve/reject/repair/assign/ready/pickup/replacement/close/cancel + notes) with the enforced transition map and append-only `warranty_claim_events`; supplier warranties list + retroactive create; supplier claims + response/replacement/recovery/close/cancel with recovery credited to `supplier_ledger` (`WARRANTY_RECOVERY`). Replacement (D6): guarded stock decrement + `adjustment` movement `warranty_replacement`, serial-tracked replacements bind a fresh serial to the original sale item, new warranty inherits the original expiry, original → 'replaced'. Serial repair loop uses the previously-unused `in_repair` serial status.
7. **Receive capture (Phase 5):** optional per-line `warranty` fields in `receiveItem.schema.ts`/`receive.types.ts`, captured inside `createReceivePurchase`'s transaction via `captureSupplierWarrantyOnReceive` (cumulative quantity, first-receive start date).
8. **Reports (Phase 6):** `/api/warranty-overview` + `/api/reports/warranty/{expiry,claims,costs,supplier}` — claim count ≠ units affected ≠ money everywhere; claim rate denominator = covered units issued; replacement stock value at average landed cost.
9. **Receipt enrichment (Phase 4 backend):** `getSaleReceipt` now returns per-line `serialNumbers[]` and a `warranty` summary (number/provider/duration/validUntil) — additive fields.
10. **Notifications (Phase 7):** kinds `warranty_expiring`, `warranty_claim`, `supplier_warranty_claim` added to the union + prefs list; `jobs/warrantyJobs.ts` `runWarrantySweeps` (expiring-7d, ready-for-pickup 3d, supplier awaiting 3d; per-day dedupe) registered in the scheduler tick.

## Tests executed

- `npm test`: **210 pass / 0 fail / 1 skipped** (integration suites self-skip without `INTEGRATION_TESTS=1` + valid `DATABASE_URL` — known env limitation).
- New unit tests `warrantyEngine.test.ts` (13): day/month/year math, month-end clamping (incl. leap years), inclusive expiry, claimable rules for every status.
- `npx tsc --noEmit`: clean after every step.

## Known issues / limitations

- Integration suites (generation, refund invalidation, cross-tenant isolation, receive capture) are written into the plan but require DB credentials to run — Phase 9 documents this.
- LAN-server claims are out of scope in v1 (D10); sale-time generation covers offline sales via the sync replay path because both the cloud and the LAN server run `createSale`.
- Supplier replacement intake for serial-tracked variants records serial texts on the claim; physical intake goes through the stock-adjustment endpoint (D8, documented).

## Files

New: `drizzle/0064_warranty_management.sql`, `db/schema/warranties.ts`, `db/schema/supplierWarranties.ts`, `modules/warranty/*` (8 files), `jobs/warrantyJobs.ts`, `modules/warranty/warrantyEngine.test.ts`.
Modified: `app.ts` (router), `rbac/permissions.ts` (catalog + presets), `utils/documentSequence.ts` (formatters), `sales.service.ts` (hooks + receipt), `purchases.service.ts` (capture), `receiveItem.schema.ts` + `receive.types.ts` (payload), `services/notifications.ts` (kinds), `jobs/scheduler.ts` (sweep), `drizzle/meta/_journal.json`.
