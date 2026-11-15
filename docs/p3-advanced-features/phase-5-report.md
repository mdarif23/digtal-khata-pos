# Phase 5 — Bangla Localization Infrastructure (report)

Executed 2026-11-15 on the Windows checkout `D:\ezposzcode\digtal-khata-pos`, branch `feature/add-feature`, on top of the Phase 4 close (`61868298`). Plan: `P5_P6_PLAN.md` (repo root, approved this session). Scope per master prompt §PHASE 5 — react-i18next infrastructure + the five core POS screens; nothing else.

---

## 1. Summary

- `i18next` ^27.1.2 + `react-i18next` ^18.0.1 added (no language detector, no HTTP backend — hand-managed). Init at `pos/src/i18n/index.ts`: `fallbackLng: "en"`, `defaultNS: "common"`, `interpolation.escapeValue: false`, `returnNull: false`, `react.useSuspense: false`.
- EN + বাংলা resources for five namespaces (`common`, `pos`, `payment`, `saleSuccess`, `register`), statically imported so Vite hashes them into `/assets/*` and the PWA SW v2 cache-first asset rule auto-busts them on deploy. **No `sw.js` change.**
- All five screens localized: PosPage (checkout toasts + topbar), CartItems (full cart surface), PaymentModal (all tender methods + validation strings), SaleSuccessDialog (summary/share/e-receipt), RegisterDialog (open/close/movements/blind count/reopen + toasts), plus the hotkey cheatsheet (`hotkeyBus` + `PosHotkeyManager`).
- Language toggle (`LanguageToggle.tsx`) in the POS topbar right cluster (between `SyncStatusIndicator` and `RegisterDialog`); persisted at `localStorage["ezpos.lang"]`; applies immediately without reload; cross-tab sync via the native `storage` event (useCfdDisplayIds precedent).
- Dates: `formatDate`/`formatDateTime` gained an **additive optional** `locale` parameter + a module-level active locale synced from the language layer. All 81 existing callers untouched; default (en) output is byte-identical (test-pinned). Money/quantities stay deterministic BDT with Latin digits.
- **No raw key path can render** — three enforced layers: `fallbackLng: "en"`; every `t()` passes `defaultValue` equal to the exact current English string (audited: all call sites, including the dynamic-key sites, pass defaultValue); a DOM-scan test helper asserts no key-shaped token renders in bn tests. Resource completeness verified by script: **261 referenced keys, zero missing in either language.**

## 2. Commits (local, NOT pushed — awaiting instruction)

| Commit | Content |
|---|---|
| `d59f5ac4` | `feat(pos): i18n infrastructure — react-i18next init, en/bn resources, language toggle` (amended once to add explicit types to the test-setup storage shim — unpushed local amend, permitted) |
| `3bb910fc` | `feat(pos): bangla localization — PosPage, CartItems, hotkey cheatsheet` |
| `8b4c86ec` | `feat(pos): bangla localization — PaymentModal, SaleSuccessDialog` |
| `ada2195e` | `feat(pos): bangla localization — RegisterDialog, shared movement labels` |
| `0f0b9042` | `feat(pos): locale-aware date formatting` |

Gates were run before every commit (backend tsc, frontend tsc worktree-diff normalized error list, build, serial Vitest).

## 3. Design decisions

1. **Validator string factories translate at call time**: `storeCreditIssue`/`loyaltyIssue` (PaymentModal) use `i18next.t` directly — signatures and the `isPaymentValid` null-check logic unchanged; they re-evaluate per render so switches apply live.
2. **`Send to` vs `Instruction`** (DigitalCashPayment) is now an explicit `sendTo` prop instead of sniffing `paymentInstruction.startsWith("Bangla QR")` — the sniff would break once the instruction is translated. Callers pass the flag by mode; behavior identical in EN.
3. **One key set per duplicated literal pair**: payment method labels (`options` list + `SPLIT_METHODS`/`methodLabel`), and register movement labels (`MOVEMENT_LABEL_KEYS` added beside `MOVEMENT_LABELS` in `registers.api.ts` — English values remain the defaultValue; `RegisterPage`'s two render sites stay English for now, see §9).
4. **`hotkeyBus` stays a pure data module**: entries gained `labelKey`/`descriptionKey`/`titleKey` fields; translation happens at render in `PosHotkeyManager`.
5. **Never translated**: product names, SKUs, serial/batch numbers, customer-entered data (charge labels, reasons, coupon codes), UOM names, all money, server-authored messages, `Bangla QR` (kept as a label; instruction now `বাংলা QR: <number>` in bn), SMS/WhatsApp, and the warranty-certificate fallbacks (`"Walk-in Customer"`, `"ezPos Store"` — they feed the printed certificate; receipts/paper out of scope per master §5.6).
6. **Bangla numerals deferred** (master §5.4.1): all digits stay Latin — pinned by test (`formatDate` bn output must match `[0-9]` and not Bengali digits).
7. **Mid-checkout safety**: the language layer only re-renders labels — cart store, react-hook-form payment state, and the server-quoted `finalTotal` are never touched. Pinned by the mid-checkout switch test (cart intact, payments unchanged, displayed charge identical across EN→বাংলা→EN).

## 4. Terminology table (user review requested before any push)

Anchors per master §5.5 applied consistently across all five screens; the **full bn string surface (261 keys) lives in `pos/src/i18n/locales/bn/*.json`** — review there (en mirrors define every defaultValue).

| EN | বাংলা | Note |
|---|---|---|
| due / Total due | বাকি / মোট বাকি | anchor |
| change (money) / Change to give | ফেরত / ফেরত দিতে হবে | anchor |
| discount | ছাড় | anchor |
| cart | কার্ট | anchor |
| customer | কাস্টমার | plan decision D3 default |
| Cash | ক্যাশ | plan decision D4 default (নগদ collides with the Nagad MFS brand) |
| payment | পেমেন্ট | anchor |
| hold | হোল্ড (হোল্ড সেল) | anchor |
| print | প্রিন্ট | anchor |
| Register / drawer | রেজিস্টার / ড্রয়ার | dialog title "ক্যাশ ড্রয়ার" |
| Cash in / Cash out | নগদ যোগ / নগদ বাদ | drawer movements (no MFS ambiguity) |
| Safe deposit (drop) / Safe withdrawal | সেফে জমা (ড্রপ) / সেফ থেকে তোলা | |
| Adjustment + / − | সমন্বয় + / − | |
| Over / Short | বেশি / কম | blind count & close variance |
| Still owed | এখনো বাকি | |
| Subtotal / Item discounts | সাব-টোটাল / আইটেম ছাড় | |
| VAT / Tax (product rules) | ভ্যাট / কর (প্রোডাক্ট নিয়ম) | |
| Store credit / Loyalty points | স্টোর ক্রেডিট / লয়ালটি পয়েন্ট | |
| Gift card | গিফট কার্ড | |
| Confirm Payment | পেমেন্ট নিশ্চিত করুন | |
| New Sale | নতুন বিক্রি | |
| Receipt / Invoice | রিসিট / ইনভয়েস | |
| Cash Receive / Exact | ক্যাশ গ্রহণ / ঠিক টাকা | till-panel wording |
| Override price | মূল্য পরিবর্তন | |
| Opening cash / Counted cash | প্রারম্ভিক নগদ / গণনাকৃত নগদ | |

## 5. Database / API / permission changes

- **Schema: NONE.** Phase 5 adds no migration; the file journal stays at 88 entries (next `0088`); `when` values monotonic.
- **API: NONE.** No route, contract, or payload change; the checkout path (server quote → PaymentModal charge) is untouched.
- **Permissions: NONE.** No rbac changes; `hasPermission` gates moved byte-identically.
- **Test-database catch-up (environment repair, not a schema change)**: this machine's `ezpos_test` had only **79/88** migrations applied — all nine P1–P4 migrations (`0079_serial_in_transit` … `0087_receipt_share_tokens`) were missing, which mass-failed the integration suites (262 fails) on first full run. Applied the nine to **`ezpos_test` only** via the repo's own `scripts/apply-migration.mjs` with `DATABASE_URL` pointed at `ezpos_test` in-memory (target verified `current_database() = 'ezpos_test'` before and after; now 88/88, `expired_batch_policy` present). **The dev DB was never touched.** The handoff's "88/88" evidently described the other machine's test DB.

## 6. Test evidence (executed 2026-11-15)

| Gate | Result |
|---|---|
| Backend `npx tsc --noEmit` | 1 error — the **pre-existing** `src/test/receiptShare.integration.test.ts(283,21)` TS2339 recorded at plan time (open decision D1). Unchanged through Phase 5 (backend untouched) |
| Frontend `npx tsc --noEmit -p tsconfig.app.json` | **119 errors after every commit; normalized error list (file+code+message, line numbers stripped) identical to the worktree baseline** — zero new diagnostics. Note: the infra commit initially introduced 5 TS7006s in the setup shim (ungated); caught at commit-2's gate and fixed by amending the unpushed infra commit |
| Frontend `npm run build` | Pass every commit (~9–11 s; pre-existing chunk-size warning) |
| Frontend Vitest (`--no-file-parallelism`) | **318/318 pass, 51/51 files** at program end. Progression: 303 (infra: 290 passing baseline + 4 terminalBinding restored by the storage shim + 9 new i18n tests) → 307 (commit 2) → 311 (commit 3) → 313 (commit 4) → 318 (commit 5). New tests: i18n init/fallback/persistence (6), LanguageToggle (3), POS-screen bn renders incl. no-raw-key DOM scan (4), checkout bn renders incl. mid-checkout switch + no-raw-key scan (4), RegisterDialog bn + shared key set (2), format locale (5) |
| Backend full suite (`INTEGRATION_TESTS=1`, Node **v26.13.0** — this machine has no Node 22; `.nvmrc` says 22) | **1106 tests recorded, 1104 pass, 1 fail, 1 skipped, 159 suites**. The single failure is the documented pre-existing `expensesPhase6` budget-scope test (fails standalone too — attribution confirmed at a clean backend tree; backend files were never touched by Phase 5). Recorded counts differ from the handoff's "1083" because this run's runner recorded more suites (the documented suite-omission flake runs the other way); nothing was skipped or hidden |

**Test-setup shim disclosure**: Node ≥22.4 declares a global `localStorage` *property* even when web storage is disabled (no `--localstorage-file`), which blocks vitest from populating jsdom's Storage — on this machine bare `localStorage` was `undefined` and the four documented `terminalBinding` failures crashed on `localStorage.clear()`. An in-memory Storage shim was added to `pos/src/test/setup.ts` (conditional — installs only when the global is missing). This restored those 4 tests to passing (294-equivalent baseline) and is required infrastructure for the language-persistence tests. It is an environment fix, not a test change; on the Node 22 machine the branch never triggers.

## 7. Known limitations (accepted, per master §5.6)

1. Server-authored messages stay English (axios error bodies, coupon/price warnings `w.message`, `extractError` passthroughs) — server-side Bangla is a later phase.
2. The `Processing ${entityName}...` wrapper comes from the shared `createEntityPromiseToast` util used by all modules — out of the five-screen scope; the success toast itself surfaces invoice + server message.
3. `RegisterPage`'s two `MOVEMENT_LABELS` render sites stay English (out of scope; the key map is ready for them).
4. Receipt/invoice/A4 paper renderers and the printed warranty certificate stay as configured (English fallbacks preserved).
5. Bangla numerals, RTL, other modules — deferred per plan §5.
6. The hotkey cheatsheet and `Bangla QR` label were included in scope (plan decision D5 default, approved).

## 8. Acceptance criteria status (master §5.7)

1. EN → বাংলা → EN flips every visible label on the five screens — **met** (bn render tests + resource completeness script + manual review pending user's bn-string review).
2. Complete a sale end-to-end in Bangla with the quoted total unchanged — **met** (mid-checkout switch test pins the quoted total, payment rows, and cart; sale flow code is language-independent by construction).
3. Dialogs, validation errors, empty states in Bangla; no raw key paths — **met** (three-layer evidence: fallbackLng + per-call defaultValue audit + DOM-scan tests; 261/261 keys present in both languages).
4. Dates per active locale; money unchanged — **met** (`15 জানু 2026` in bn; `৳1,234.50` deterministic; Latin digits pinned).
5. Language switch mid-checkout does not clear the cart / re-quote / alter the charged total — **met** (test).
6. All existing tests pass; new tests per plan §2.6 — **met** (318/318 frontend incl. all pre-existing suites; backend 1104/1105 with the one documented pre-existing failure).

## 9. Remaining work / deferred

- **User review of the bn strings** (§4 + the JSON files) before any push — translation quality is acceptance-critical.
- Open plan decisions D1 (backend tsc 1-error floor) and D2 (terminalBinding shim accepted as the restored baseline) still await owner ratification.
- Deferred registry unchanged (P5_P6_PLAN.md §6): RegisterPage movement labels, `/due_by_customers` double-fetch, select-options dual cache, catalog refetch churn, server-side Bangla, Bangla numerals, receipt renderers.
- `P5_P6_PLAN.md` is still untracked at the repo root (committed together with this report as the phase docs).
- Phase 6 (TanStack migration + large-file refactor) **requires the explicit "proceed with Phase 6" instruction** per master PART 4 — its design is ready in `P5_P6_PLAN.md` §3.
