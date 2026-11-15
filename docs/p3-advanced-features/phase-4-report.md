# ezPos P3 Advanced Features — Phase 4 Report

**Phase:** 4 — Receipt and customer display depth (N1-10, N1-02, N1-08)
**Date:** 2026-11-15
**Branch:** `feature/add-feature` · **Commit:** final hash in `git log` · **Pushed:** no
**Approved plan:** `P3_ADVANCED_FEATURES_PLAN.md` §H (D12 implemented as recommended: hashed-token table, public renderer reusing `renderReceiptHtml`, 72 h default TTL, PDF via the browser print dialog)

## 1. Receipt share link + PDF (N1-10, D12)

- **Table** `receipt_share_tokens` (0087): tokens stored ONLY as SHA-256 hashes (the CFD display-token model — the plaintext 48-hex token is returned exactly once at creation), composite `(sale_id, business_id)` FK pins a link to its own tenant's sale (a foreign link is impossible to insert — tested, 23503), indexed per business+sale.
- **API** (permission `sales.view`, the same authority that reads receipts):
  - `POST /api/sales/:saleId/receipt-link` `{ ttlHours?: 24|72|168 }` → `{ token, url, expiresAt }` once (default 72 h per D12);
  - `POST /api/sales/:saleId/receipt-link/revoke` `{ tokenId? }` (absent = revoke all live links);
  - `GET /api/sales/:saleId/receipt-link` (list, for audit).
- **Public fetch** `GET /api/public/receipts/:token` — the ONLY unauthenticated receipt surface: per-IP sliding-window limiter (30/min, in-memory, no new dependency), uniform 404 for unknown/expired/revoked/malformed tokens (nothing leaks), returns the SAME `getSaleReceipt` payload the POS renders.
- **Public page** `/receipt/t/:token` (outside the authed layout, CfdDisplayPage precedent): renders with the existing **`renderReceiptHtml`** (no second receipt engine), prints through the browser dialog — "Print / Save PDF" covers client-side PDF export per D12.
- **POS UI**: "Create share link" button in the SaleSuccessDialog (`sales.view` holders) → URL shown + copy + open; the token is never recoverable after the dialog.

## 2. USB receipt Unicode (N1-02)

- `usePrintReceipt` detects any char above 0xFF in the USB payload (shop name, item names, footer, cashier) BEFORE attempting ESC/POS: non-Latin-1 text → the USB attempt is **skipped entirely** (never silently printing `?` garbage) and the browser-print fallback renders full Unicode, with a one-line warning explaining why (printer language / English-only ESC-POS note).
- Pure ASCII/Latin-1 receipts print byte-for-byte as before (verified mapping untouched at `escpos.ts:42-52`); any USB/transport failure still falls through to browser print.

## 3. Multi-display CFD (N1-08)

- Backend registry: `Map<number, Response>` → `Map<number, Set<Response>>` — multiple live SSE clients per display (two tabs, reconnect races); pushes fan out to all members and dead sockets are pruned on write failure; `detachStream` removes only the closing response.
- `POST /api/cfd/push` accepts `displayIds: number[]` (1–20) alongside the legacy `displayId`; **every target is ownership-checked inside `pushPayload`** (a foreign displayId is a 404 in the per-target results — never a cross-business leak, tested); response carries per-target `results`.
- `POST /api/cfd/stream`'s close handler detaches only the closing socket.
- POS: `useCfdDisplayIds` (localStorage `ezpos.cfd.pushDisplayIds` array, transparently migrated from the single-id key), cart/paid pushes fan out to every selected display in one authenticated call; `CfdManageDialog` toggles per display (Push/Pushing).
- Disconnected displays are skipped (per-target `delivered: false`) and auto-reconnect via the existing SSE client.

## 4. Database changes
| Migration | Content | Rollback (in-file) |
|---|---|---|
| 0087_receipt_share_tokens | hashed-token table + composite sale FK + indexes | `DROP TABLE` |

`ezpos_test` at **88/88**. No backfill. Next migration: 0088.

## 5. API changes
- New: `POST /api/sales/:saleId/receipt-link` (+ `/revoke`, list GET) — `sales.view`; public `GET /api/public/receipts/:token` (no auth, rate-limited, uniform 404s).
- Extended: `POST /api/cfd/push` accepts `displayIds` (1–20).
- No permission catalog changes (share links reuse `sales.view`).

## 6. Test evidence (actually executed 2026-11-15)
`receiptShare.integration.test.ts` — **5/5 pass**: create → plaintext 48-hex token, URL contains no sale id, DB stores only the hash; public fetch WITHOUT auth returns the receipt (finalTotal 20); revoked → 404; force-expired → 404; unknown/malformed tokens → uniform 404; tenant isolation via the composite FK (foreign insert rejected 23503); CFD `displayIds` accepted with per-target results (foreign display id flagged, not leaked).

## 7. Gates
| Gate | Result |
|---|---|
| Backend `tsc --noEmit` | clean |
| Full backend suite | **1082/1083 pass** — the single failure is the SAME pre-existing `expensesPhase6` budget test documented in the Phase 3 report (fails with all P3 work stashed at a clean HEAD). Count reconciles exactly: 1078 + 5 new = 1083 |
| Frontend `tsc` (app config) | **119 = 119 baseline (zero new)** |
| Frontend production build | pass |
| Frontend vitest (serial) | **294/294** |

## 8. Remaining / deferred
- Image-based ESC/POS remains a stretch goal (unchanged).
- Share links are not embedded into the WhatsApp send flow (the URL is copied — it can be pasted anywhere); a direct provider attach is a later approved feature.
- Phase 5 (Bangla localization infrastructure) is next — no migration needed, react-i18next + the five core POS screens per plan §I.

## 9. Git / safety
- One focused local commit; no push, no remote/history changes; migrations applied to `ezpos_test` only after in-memory target verification; `cj-tmp.txt` untouched; no `.env` values printed.
