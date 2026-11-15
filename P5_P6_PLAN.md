# ezPos — P5/P6 Implementation Plan

**Phase 5: Bangla Localization Infrastructure · Phase 6: Platform Maintenance & Refactoring**

- Status: **PLAN — awaiting user approval.** No application code written. Phase 6 additionally requires the explicit "proceed with Phase 6" instruction after Phase 5 passes its gates (master prompt PART 4).
- Date: 2026-11-15 · Branch: `feature/add-feature` @ `61868298` (pushed, clean tree) · Machine: Windows checkout `D:\ezposzcode\digtal-khata-pos` · Node v26.13.0
- Conventions follow `SMART_PROCUREMENT_IMPLEMENTATION.md` / `RECEIPT_INVOICE_IMPLEMENTATION.md` (numbered sections, per-phase design + test evidence + known limitations).

---

## 0. Verified current state (2026-11-15, this checkout)

### 0.1 Git, migrations, PR

| Item | Verified value |
|---|---|
| Branch / remote | `feature/add-feature` @ `61868298`, clean tree, in sync with `origin/feature/add-feature` |
| PR | **None open** for `feature/add-feature` (gh query returned `[]`); `origin/development` tip is `fc9a4fc3` |
| Migration journal | `ezPosBackend/drizzle/meta/_journal.json` — **88 entries**, last `0087_receipt_share_tokens`, `when` values monotonic; **next migration is `0088`** |
| Migrations needed | **NONE.** Phase 5 and Phase 6 are frontend-only. If implementation ever believes it needs one → STOP and present why (master prompt §6 Step 1.2) |
| Sensitive file | `pos/cj-tmp.txt` — **absent** on this checkout (existence checked only; never read/searched) |

### 0.2 Baseline gates recorded today (operative numbers for this machine)

| Gate | Command | Result today | vs. handoff claim |
|---|---|---|---|
| Backend tsc | `npx tsc --noEmit` (ezPosBackend) | **1 error** — `src/test/receiptShare.integration.test.ts(283,21)` TS2339 (`Property 'code' does not exist on type 'QueryResult<any> \| { code?: string; }'`) | ⚠ Handoff said "clean". Tree is clean at the handoff commit `61868298`, so this error **is pre-existing in the committed Phase 4 state** (likely verified on the other machine). Recorded as the operative floor; not fixed silently — see Open decision D1 |
| Frontend tsc | `npx tsc --noEmit -p tsconfig.app.json` (pos) | **119 errors** | Matches recorded baseline exactly |
| Frontend tsc worktree-diff | worktree at `pos/.p56-baseline` (HEAD `61868298`), same tsc, removed after | **119 errors, error sets IDENTICAL** (sorted diff = empty) | Worktree-diff method satisfied; note `tsconfig.app.json` has no `incremental/composite/tsBuildInfoFile`, so tsc writes no cache files |
| Frontend build | `npm run build` | **Pass** (10.9s; pre-existing >500 kB chunk warning on the 3.0 MB `index` chunk) | Pass |
| Frontend Vitest | `npx vitest run --no-file-parallelism` | **294 tests: 290 pass, 4 fail** — all 4 in `src/auth/terminalBinding.test.ts` (`localStorage.clear()` → `Cannot read properties of undefined`); **fails standalone too** (protocol re-run done) | ⚠ Handoff said 294/294 (other machine). These 4 are the **documented pre-existing `terminalBinding` baseline** from the Nov-11 batch; deterministic env/test-setup failure, not a timeout flake. Operative baseline: **290 pass / 4 pre-existing fails** — see Open decision D2 |
| Backend test suite | `INTEGRATION_TESTS=1`, Node 22, `ezpos_test` | **Not run at plan time** (full run at program end per master §7.5). Node here is **v26.13.0** vs `.nvmrc` 22 — flagged as a gate-time risk (§6 R8) | Handoff: 1082/1083 (1 pre-existing `expensesPhase6` fail) |

Per-file tsc error distribution inside files this program touches (from the recorded baseline — counts must not change):

- Phase 5 files: `CartItems.tsx(1007,22)` TS2322 · `PosPage.tsx(315,23)` TS18047 · `SaleSuccessDialog.test.tsx(5,38)` TS2307 (test file — will not be edited)
- Phase 6 files: 3 matching diagnostics across the `Dashboard`/`Sales.tsx`/`PurchasesReturn` set
- `lib/format.ts` / `lib/rbac.ts`: **0 errors** (clean seams for the two files whose exports ripple widest)

### 0.3 Verified scoped-file line counts (reverified today, per master §5.1)

| Phase 5 screen | Lines | Phase 6 file | Lines |
|---|---|---|---|
| `pos/src/features/pos/pages/PosPage.tsx` | **460** | `pos/src/pages/Dashboard/Dashboard.tsx` | **1398** |
| `pos/src/features/pos/components/pos/CartItems.tsx` | **1259** | `pos/src/features/pos/pages/Sales.tsx` | **1056** |
| `pos/src/features/pos/components/pos/PaymentModal.tsx` | **1046** | `pos/src/features/pos/components/pos/PaymentModal.tsx` | **1046** |
| `pos/src/features/pos/components/receipt/SaleSuccessDialog.tsx` | **461** | `pos/src/pages/PurchasesOrder/PurchasesReturn.tsx` | **811** |
| `pos/src/features/cashRegisters/components/RegisterDialog.tsx` | **613** | | |

(Note: master §1.2's "PosPage" inventory matches; the pricing path is confirmed string-free — quote/checkout math lives in cart store + server quote.)

### 0.4 Architecture facts verified

- **No i18n exists anywhere** (`grep i18next|react-i18next|useTranslation` over `pos/src` = zero hits; no deps in package.json). Greenfield.
- **date-fns 4.4.0 ships the `bn` locale** (`node_modules/date-fns/locale/bn.*` verified). `formatDate`/`formatDateTime` currently pass no locale arg.
- **localStorage conventions** (verified inventory): `ezpos-kebab` and `ezpos.dotted` styles coexist; `ezpos.lang` does **not** exist — free for the language key. Cross-tab precedent: `useCfdDisplayIds` (`PosPage.tsx:423-460`) — read on mount + `window` `storage` event filtered by key.
- **PWA SW v2** (`pos/public/sw.js`): `ezpos-shell-v2`; navigations network-first; **only content-hashed `/assets/*` cache-first**. Statically imported i18n resources become hashed assets → auto-bust on deploy. **No SW change needed.**
- **queryClient defaults** (`pos/src/lib/queryClient.ts`): `staleTime 30s, retry 1, refetchOnWindowFocus false`.
- **Offline**: `loadProductsWithCache`/`loadCustomersWithCache` (`pos/src/features/pos/offline/catalog.ts:44,63`) wrap the two catalog fetches; IDB `ezpos-offline` v3, stores `catalog_products, catalog_customers, active_cart, outbox, offline_grants, sync_log`, scoped per user+business. Exactly **two call sites** to preserve: `useProductStore.ts:50-55`, `store/useCustomerStore.ts:83-87`.
- **Realtime** (`pos/src/features/pos/offline/realtime.ts` — only SSE subscriber): `sale.created`/`product.changed` → `stockRevision`+`productRevision` → PosPage refetches products; `customer.changed` → `customerRevision` → PosPage refetches customers; `held_sales.changed` → holds refresh; `register.changed`/`terminal.changed` → unconsumed counters; `notification.created` → bell. **Realtime never invalidates a TanStack query today** — the one precedent of a Zustand store invalidating TQ is `useSalesStore.ts:31` (`sellUnitsKeys.all`).
- **Bootstrap** (`pos/src/hooks/useInitializeApp.ts:43-62`): after `bootstrapSession()` (session → first business → locations → IDB scope → terminal binding → cart restore), fires 8 store loads. **Business/location switching = `window.location.reload()`** (`axios.ts:160-177`) — there is no business switcher; location switch is full reload.
- **D5 duplicate fetching** (dedupe candidates, Phase 6 requirement #4): `/due_by_customers` fetched twice (CustomersPage API + CartItems raw axios); product select-options in **two caches** (Zustand `productSelectOptions` + TQ `["product","select-options"]`); roles fetched independently by UsersPage and RolesPage; locations fetched by UsersPage though the session already holds them.
- Payments method labels and register movement labels are **duplicated literals** inside the frontend (PaymentModal L450-459 vs L733-741; RegisterDialog L379-384 vs `registers.api.ts:12-19`) — i18n will collapse each pair onto one key set.

---

## 1. Program scope summary

| | Phase 5 (this approval) | Phase 6 (design now; starts ONLY on explicit "proceed with Phase 6") |
|---|---|---|
| Goal | `react-i18next` infrastructure + Bangla for the 5 core POS screens | TanStack Query migration (data domains) + large-file refactor, **zero behavior change** |
| DB objects / migrations | **None** | **None** |
| New permissions | **None** | **None** |
| API contract changes | **None** | **None** |
| Backend code changes | **None** | **None** |
| New deps | `i18next` + `react-i18next` only (no detector, no HTTP backend) | None |

---

## 2. Phase 5 — Bangla Localization Infrastructure

### 2.1 Dependencies

- `i18next` **^27.1.2**, `react-i18next` **^18.0.1** (current stable majors verified via npm registry today). No `i18next-browser-languagedetector`, no HTTP backend, no plugins — language is hand-managed.
- Installed via `npm install` in `pos/` (package-lock updated; no other deps).

### 2.2 i18n architecture

**Init — `pos/src/i18n/index.ts`** (imported once from `pos/src/main.tsx` before App render):

```ts
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import enCommon from "./locales/en/common.json";   // …static imports of all 10 files
import bnCommon from "./locales/bn/common.json";   // …
export const LANG_STORAGE_KEY = "ezpos.lang";
void i18next.use(initReactI18next).init({
  resources: { en: { common, pos, payment, saleSuccess, register },
               bn: { common, pos, payment, saleSuccess, register } },
  lng: localStorage.getItem(LANG_STORAGE_KEY) === "bn" ? "bn" : "en",
  fallbackLng: "en",
  defaultNS: "common",
  interpolation: { escapeValue: false },   // React escapes; XSSI not a concern
  returnNull: false,
  react: { useSuspense: false },           // dialogs render synchronously
});
```

**Namespaces & resource files** — `pos/src/i18n/locales/{en,bn}/{common,pos,payment,saleSuccess,register}.json`, statically imported (hashed by Vite → SW cache-first picks them up automatically; documented per master §5.2.3). Keys are camelCase, nested one level by section (e.g. `payment.cash.receive`).

| Namespace | Backs | Approx. keys |
|---|---|---|
| `common` | Cancel/Confirm/Save/Close/Print/Customer/Discount/Total/Search/Loading/Reason/Amount/Name/Phone/Address/Note, empty-state scaffolding | ~35 |
| `pos` | PosPage toasts + cart chrome, CartItems labels/buttons/dialogs/aria/toasts (~55), hotkey cheatsheet (§2.7), `Cart is empty` | ~110 |
| `payment` | PaymentModal: method labels (single key set backs both `options` and `SPLIT_METHODS`), cash/digital/store-credit/loyalty/split/due panels, `storeCreditIssue`/`loyaltyIssue` string factories | ~75 |
| `saleSuccess` | SaleSuccessDialog: title/summary labels/buttons/share+send states/outcome box | ~40 |
| `register` | RegisterDialog: chrome, movement options (single key set backs the select AND `MOVEMENT_LABELS`), 18 toasts, blind-count/close/reopen strings | ~60 |

Total ≈ 320 keys. Key inventory is built **per file during the extraction pass** (see below), not pre-guessed.

**No raw key paths may ever render — three enforced layers:**
1. `fallbackLng: "en"` (bn misses fall back to en).
2. **Every `t()` call passes `defaultValue` equal to the exact current English string** — so even a key missing from BOTH locales renders the original English, never the key.
3. During each file's extraction pass only: `saveMissing: true` + a `missingKeyHandler` that console-logs gaps; the log must be empty and the flags **disabled before commit**. Evidence in the phase report: (a) the empty dev missing-log, (b) a grep over `t(` call sites confirming `defaultValue` presence, (c) the test helper that scans rendered DOM for key-shaped tokens (`/^[a-z]+\.[a-zA-Z0-9_.]+$/`) and fails on any hit.

**String extraction without breaking JSX** (per-file surgical pass, no reformat):
- Wrap each literal as `t("ns.key", { defaultValue: "<exact current English>" })`; template literals become `t(key, { defaultValue, {{var}} interpolation })` — variable content stays data.
- Ternary/dynamic strings get one key per branch; plural-ish pairs ("line item/line items", "{n} promotions") use two explicit keys + ternary — **no ICU plurals** (bn needs only one/other, and a till UI prefers explicit keys).
- Compositions that are word-order-sensitive in Bangla (e.g. CartItems `{unitPrice} × {quantity} = {total}` caption, `Due ৳x exceeds … available credit`) get full-sentence keys with interpolation, translated with natural word order.
- **Never translated**: product names, SKUs, customer-entered data (charge labels, reasons, coupon codes), money amounts, serial/batch numbers, UOM names from catalog, server-authored messages (`extractError` passthroughs, coupon/price warnings `w.message`) — server messages stay English in Phase 5 (master §5.6), flagged as a known limitation.
- **Kept verbatim**: `Bangla QR` method name (brand), receipt/paper fallbacks `"Walk-in Customer"` / `"ezPos Store"` (they feed the printed warranty HTML — receipts stay as configured per §5.6).

### 2.3 Language selection & persistence

- New `pos/src/i18n/LanguageToggle.tsx`: compact EN / বাংলা toolbar toggle, inserted in the PosPage topbar right cluster (`PosPage.tsx:345`) between `SyncStatusIndicator` and `RegisterDialog` — a one-line insertion into an existing `flex-wrap` row; zero layout risk (verified against the recon of the topbar structure).
- Click → `i18n.changeLanguage(lang)` + `localStorage.setItem("ezpos.lang", lang)`; init reads the key. Switch applies immediately, no reload, no re-mount of dialogs (`useSuspense: false`).
- Cross-tab sync: copy the `useCfdDisplayIds` pattern — `window` `storage` listener filtered to `ezpos.lang` inside the toggle (optional per master §5.3.3; included).
- **Checkout-safety argument (verified in recon)**: cart/quote/payment state lives in `useCartStore` + react-hook-form + the server quote (`POST /api/sales/quote` is authoritative; PaymentModal charges only `quotedFinalTotal`). The language layer only re-renders labels; it never touches cart state, the quote payload, or payment math. Covered by a dedicated test (§2.6).

### 2.4 Formatting rules (minimal, additive — no consolidation rework)

- **Money untouched**: `formatCurrency` stays deterministic `Intl.NumberFormat("en-US")` + `৳` — BDT semantics, Latin digits. Bangla numerals explicitly deferred (till UI digit-system mixing is a correctness risk — documented per master §5.4.1).
- **Dates**: `formatDate`/`formatDateTime` in `pos/src/lib/format.ts` gain an **optional `locale?: "en" | "bn"` parameter**, defaulting to a module-level active locale that the language layer sets on switch (`setActiveFormatLocale("bn")`). Default (en) output is byte-identical to today for all 81 existing importing files — this only ADDs a locale parameter to the consolidated formatters, exactly as master PART 5 permits; no signature breaks, no reorganization. Implementation: pass `bn` (from `date-fns/locale`, statically imported, few KB) as date-fns' third arg; en keeps current behavior (no locale arg).
- Numbers/quantities stay Latin digits via `formatNumber`/`formatQty` — untouched.

### 2.5 Translation quality (acceptance-critical)

Terminology table — draft; **the user reviews the final bn strings surfaced in the phase report** before push. Anchors per master §5.5 (due = বাকি, change = ফেরত, discount = ছাড়, cart = কার্ট, print = প্রিন্ট, payment = পেমেন্ট, hold = হোল্ড) applied consistently across all five screens.

| EN | বাংলা | Note |
|---|---|---|
| due | বাকি | anchor |
| change (money) | ফেরত | anchor |
| discount | ছাড় | anchor |
| cart | কার্ট | anchor |
| customer | **কাস্টমার** | pick one and stay consistent — কাস্টমার (retail-common) over ক্রেতা (formal); Open decision D3 |
| print | প্রিন্ট | anchor |
| payment | পেমেন্ট | anchor |
| hold | হোল্ড | anchor |
| Total / Subtotal | মোট / সাব-টোটাল | |
| VAT / Tax | ভ্যাট / কর | |
| Quantity / Qty | পরিমাণ | |
| Cash | **ক্যাশ** | নগদ collides with the Nagad MFS brand next to "Bangla QR" — Open decision D4 |
| Card / Gift card | কার্ড / গিফট কার্ড | |
| Store credit / Loyalty points | স্টোর ক্রেডিট / লয়ালটি পয়েন্ট | |
| Split (payment) | স্প্লিট পেমেন্ট | |
| Still owed / Change to give | বাকি / ফেরত দিতে হবে | |
| Register / Cash register / drawer | রেজিস্টার / ক্যাশ ড্রয়ার | |
| Cash in / Cash out | নগদ গ্রহণ / নগদ প্রদান | movement options (drawer context, no MFS ambiguity) |
| Confirm Payment | পেমেন্ট নিশ্চিত করুন | |
| New Sale | নতুন বিক্রি | |
| Receipt / Invoice | রিসিট / ইনভয়েস | |
| Save as quotation | কোটেশন হিসেবে সংরক্ষণ | |
| Cancel / Close / Save / Apply / Done | বাতিল / বন্ধ করুন / সেভ / প্রয়োগ / সম্পন্ন | common set |
| Cart is empty | কার্ট খালি | |
| Opening cash / Counted cash / Difference | প্রারম্ভিক নগদ / গণনাকৃত নগদ / পার্থক্য | register stats |
| Balanced / Over / Short | ব্যালেন্সড / বেশি / কম | blind count/close |

### 2.6 Phase 5 testing strategy

New vitest files (mirroring the existing harness patterns — `PaymentModal.test.tsx` react-hook-form Harness + mocked axios):

1. `i18n.test.ts` — init defaults (lng en, fallback en, defaultNS common, `returnNull: false`), stored `ezpos.lang: bn` is honored at init, `setLang` persists + fires `storage` event, date helpers: default output byte-identical to today, bn flips month-name rendering.
2. `LanguageToggle.test.tsx` — renders both options; click switches `i18n.language`, persists, dispatches the cross-tab event.
3. Representative bn render per screen (with a no-key-path assertion helper on rendered text):
   - `CartItems` with one line item → cart labels + `কার্ট খালি` empty-state in bn;
   - `PaymentModal` via the existing Harness → `পেমেন্ট` header + `পেমেন্ট নিশ্চিত করুন` button in bn; charged total unchanged vs en;
   - `SaleSuccessDialog` with a mock receipt → translated title/buttons; invoice number and amounts remain data;
   - `RegisterDialog` → toolbar/dialog labels in bn;
   - `PosPage` → mounted with the same mock strategy used elsewhere in the suite (heavy children mocked); asserts topbar + toast strings in bn; if the full mount proves flaky on this hardware, the fallback representative surface is the hotkey cheatsheet + toggle slice — **decided during implementation, documented in the report, never silently skipped**.
4. **Mid-checkout switch test**: seed `useCartStore` with items → render `PaymentModal` → switch EN→বাংলা→EN → cart intact, quoted `finalTotal` display unchanged, payments state unchanged.
5. Regression: the full suite must stay at **290 passing + the 4 pre-existing `terminalBinding` failures** (no new failures, no new skips); build passes; worktree-diff tsc method shows **no new diagnostics** (normalized error list — file+code+message, line numbers stripped — must be identical to the 119-error baseline, since inserting lines above `CartItems.tsx:1007`/`PosPage.tsx:315` may shift those two known errors' line numbers but not add/remove any).
6. Bundle evidence: post-build grep confirming no key-shaped string appears outside the resource JSON blobs, plus the empty dev missing-log (§2.2 layer 3).

### 2.7 Scope inclusion (flagged for approval)

- **Hotkey cheatsheet**: `hotkeyBus.ts` `SHORTCUT_GROUPS` (4 group titles + 11 label/description pairs) is rendered directly on PosPage via `PosHotkeyManager` — included in the `pos` namespace (cheapest high-visibility win, same screen). Recommend: include.
- **`MOVEMENT_LABELS` dedup**: one key set in `register` backs both RegisterDialog select options and the toast compositions in `registers.api.ts` (labels consumed via `t()` at call time — no case folding needed for Bangla).
- **PaymentModal method-label dedup**: one key set backs `options` (L450-459) and `SPLIT_METHODS`/`methodLabel` (L733-745).

### 2.8 Phase 5 acceptance criteria (mirrors master §5.7)

1. EN → বাংলা → EN flips every visible label on all five screens (verified by the bn render tests + manual switch pass, screenshots in the phase report).
2. Complete a sale end-to-end in Bangla with the quoted total unchanged (mid-checkout test + manual).
3. Dialogs, validation errors, empty states render in Bangla; no raw key paths (three-layer evidence in §2.2 + DOM-scan test helper).
4. Dates render per active locale; money unchanged (BDT, Latin digits).
5. Language switch mid-checkout: cart not cleared, quote not altered, charged total identical.
6. Gates: backend tsc unchanged (1 pre-existing error), frontend tsc normalized error list identical to the 119 baseline, build pass, Vitest 290 + 4 pre-existing, backend full suite at program end.
7. All existing tests pass unchanged; new tests per §2.6.

### 2.9 Phase 5 commit plan (one concern per commit; no push)

| # | Commit | Contents |
|---|---|---|
| 1 | `feat(pos): i18n infrastructure — react-i18next init, en/bn resources, language toggle` | deps, `pos/src/i18n/*`, main.tsx import, LanguageToggle + persistence + cross-tab, init/persistence tests |
| 2 | `feat(pos): bangla localization — PosPage, CartItems` | both files + `pos`/`common` keys + hotkey labels + bn render tests |
| 3 | `feat(pos): bangla localization — PaymentModal, SaleSuccessDialog` | both files + `payment`/`saleSuccess` keys (incl. validator factories, method-label dedup) + bn render + mid-checkout tests |
| 4 | `feat(pos): bangla localization — RegisterDialog` | dialog + `register` keys (incl. MOVEMENT_LABELS dedup) + bn render tests |
| 5 | `feat(pos): locale-aware date formatting` | `format.ts` additive locale param + `setActiveFormatLocale` + tests |

Gates run before each commit (master PART 7). After commit 5: phase-5 report at `docs/p3-advanced-features/phase-5-report.md` (implemented functionality, files changed, API/DB/permission changes = none, terminology table + full bn string surface for user review, test results with actual counts, commit hashes, remaining issues). **STOP — user reviews bn strings; Phase 6 starts only on explicit instruction.**

---

## 3. Phase 6 — Platform Maintenance & Refactoring (SEPARATE APPROVAL REQUIRED)

**Defining requirement: zero behavior change.** Existing tests pass unchanged at every commit. No new deps, no visual changes, no prop-drilling redesigns beyond extraction.

### 3.1 Feature 1 — TanStack Query migration (one domain per commit)

House pattern to mirror (verified): `useBarcodes.ts` key factories + `useQuery({ queryKey, queryFn, enabled, placeholderData: keepPreviousData })` + `useMutation` `onSuccess` invalidations; defaults from `lib/queryClient.ts`.

**Query keys (scoped per master §6.F1.2):** keys include the session business/location scope read from the session store. Location switching is a full `window.location.reload()` today (verified), so cross-scope staleness cannot occur, but keys are scoped anyway for future business switching:

- `customerKeys = { all: ["customers"], list: (b) => ["customers", b, "list"] }`
- `productKeys = { all: ["products"], catalog: (b, l) => ["products", b, l, "catalog"], selectOptions: (b, l) => […, "select-options"], variantOptions: (b, l) => […, "variant-options"] }`
- `saleKeys = { all: ["sales"], list: (b, l, filters?) => ["sales", b, l, "list", filters?] }`
- Page domains: `["users", b]`, `["roles", b]`, `["permissions-catalog"]`, `["coupons", b, filters]`, `["quotations", b, filters]`, `["audit-logs", b, filters]`

**Offline fallback preservation (master §6.F1.3):** the products/customers `queryFn` **is** the existing wrapper — `loadProductsWithCache(getProductsApi)` / `loadCustomersWithCache(getCustomersApi)` — so the IndexedDB fallback and `offlineMode` flag behave identically (verified two call sites, §0.4). The existing offline tests must pass untouched.

**Realtime invalidation mapping (master §6.F1.1 — every existing store reload call mapped before removal):**

| Signal → today's effect | Target after migration |
|---|---|
| `sale.created` / `product.changed` → PosPage refetches products | `invalidateQueries(productKeys.catalog)` |
| `customer.changed` → PosPage refetches customers | `invalidateQueries(customerKeys.list)` |
| `held_sales.changed` → `useHoldCartStore.refreshHolds()` | unchanged — cart domain excluded |
| `notification.created` → bell revision | unchanged |
| `register.changed` / `terminal.changed` → unconsumed | unchanged (still unconsumed) |
| `sale.created` → sales list | **NOT invalidates sales today — stays that way** (zero behavior change; noted in Deferred registry) |
| Post-mutation: `createSale` refetches sales list + `refreshStockAfterTransaction` (products + `sellUnitsKeys.all`) | mutations invalidate `saleKeys.list` + `productKeys.catalog` + existing `sellUnitsKeys.all` |

**Bootstrap (master §6.F1.2):** `useInitializeApp` keeps its exact position in startup; migrated store loads are replaced by `queryClient.prefetchQuery(...)` for the same domains so the POS hot path stays warm; purchases/purchase-items/purchase-returns stores are **not** in the migration candidate list and keep their bootstrap calls.

**Optimistic stock** (`returnVariantStock`/`takeVariantStock`/`adjustVariantStock`): become `queryClient.setQueryData` updates over `productKeys.catalog` with identical math — the one place semantics must be test-pinned.

**Commit order (9 commits, each with regression tests: load → render → invalidate-on-signal → refetch, plus offline path where applicable):**

1. **Customers** — `store/useCustomerStore.ts` + `api/customer.api.ts` consumers (CustomersPage, CartHeader, CartItems, PaymentModal, PosPage, CustomerDialog, SaveQuotationDialog) move to `useCustomersQuery` + mutations; PosPage `customerRevision` consumer → invalidate. Replaces the local array patch on create/update with invalidate-refetch (same visible end state; documented).
2. **Products catalog** — `useProductStore.getProducts` → catalog query with offline queryFn; all refetch sites (ProductsPage scan, StockAdjustment, ProductList, Purchases flows, PosPage revisions, useSalesStore refresh) → invalidate.
3. **Products select/variant options + store removal** — the remaining two loaders + the ~9 store actions mutate options via setQueryData; `useProductStore.ts` deleted. (Also pins the dual-cache situation instead of silently unifying it — see Deferred registry.)
4. **Sales list** — `getSales` → query (list only; **return/refund ACTIONS stay in `useSalesStore`** per master §6.F1.3 candidate note); ExchangeDialog/void refresh sites → invalidate.
5–9. **Users → Roles → Coupons → Quotations → Audit logs** pages: each manual `load()`/`useEffect` triad (verified manual in §0.4 D4; CouponsPage uses raw axios in-component) → `useQuery` (+ `useMutation` + `keepPreviousData` for filterable lists), one commit per page.

**Explicit exclusion:** `useCartStore` + `useHoldCartStore` (cart, payments, holds) are checkout state, not data-fetch — **not migrated** (verified: in-memory cart + IDB `active_cart`/`outbox` persistence).

### 3.2 Feature 2 — Large-file refactoring (zero behavior change; one file per commit)

Seams below come from the line-level recon (structure maps with ranges verified today). Extraction = verbatim-lift of self-contained components/hooks with explicit props; shared state (`busySaleId`, `actionError`, `selectedSaleId`) is injected as callbacks, never duplicated.

1. **`Dashboard.tsx` (1398)** — extract: `dashboardNormalizer.ts` (pure response→data incl. `readRows`/`normalizeDashboard`/formatters), `dashboardCsv.ts` (`exportCsv`+`csvCell`), `DashboardPrimitives.tsx` (`MetricCard`/`SectionHeading`/`EmptyState`), `useDashboardSummary.ts` (state + race-guarded `loadDashboard` + 60s polling/`visibilitychange` effect + memos), `SalesOverviewChart.tsx` (recharts), `RecentSalesTable`+`TopPerformersCard`, `SlowMovingStockSection` (select handlers stay props). No tests exist today → add unit tests for the pure seams (normalizer, csv) only (allowed: "where a refactor uncovers an untested seam").
2. **`Sales.tsx` (1056)** — extract: `salesListUtils.ts` (pure consts/guards/labels/`summarizeSales`/refund helpers), `useSaleReceipt.ts`, `VoidSaleFlow` (dialog + approval + `submitVoid`), `RefundDialog` (controlled; ~380 lines), `SaleDetailsDialog`, `SalesActionDialogs` mounts. `hasPermission("sales.return"/"sales.void")` checks move byte-identically. Component tests: none today (store-level only; Playwright e2e covers flows) → pure-utils unit tests only.
3. **`PaymentModal.tsx` (1046)** — extract: `paymentHelpers.ts` (pure `buildPayments`/`getMode`/`money`/`QR_NUMBER`), `useTenderBalances.ts`, `paymentValidation.ts` (`storeCreditIssue`/`loyaltyIssue`/`isPaymentValid`), `SplitPayment.tsx`, `PaymentMethodPanels.tsx`, `DuePanel.tsx`. **Export signature untouched** — the 17-test harness pins it; all 17 must pass unchanged. (If Phase 5 ran first, these files are already i18n-wrapped — extraction is mechanical.) If Phase 6 runs before Phase 5 by owner choice, same seams apply.
4. **`PurchasesReturn.tsx` (811)** — extract: `useDebouncedValue` (→ shared hook), `usePurchaseReturnLines` (UOM/serial state cluster — refs move together), `usePurchaseReturnPreviewData`, clamp helpers (pure), `usePurchaseReturnScan` (riskiest: batched-scan ref-mirroring moves verbatim), `ReturnGuards`, `ReturnSummaryCards`. 6 page tests must pass unchanged. Drop the verified dead import (`scanStepInLineUnit`) in the same commit.

### 3.3 Phase 6 commit plan & gates

10 commits (9 migration + 4 refactor files → 13 total; each one domain/file). Before each: backend tsc (1-error floor), frontend tsc (normalized list identical), build, Vitest (290 + 4 pre-existing; no new failures/skips), touched integration suites if any backend file were touched (none expected). Full backend suite at program end.

---

## 4. Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | i18n edits touch files holding pre-existing tsc errors (`CartItems`, `PosPage`) | Gate = **normalized error list identical** (line-insensitive), not just total count; per-file counts tracked in each phase report |
| R2 | Bangla word order breaks interpolated compositions | Full-sentence keys with `{{var}}`; terminology review by user before push; `defaultValue` guarantees EN fallback |
| R3 | Bundle size grows (i18next + react-i18next ≈ 15–20 kB gzip, resources a few kB) | Static imports only; measured before/after in the report; no lazy-loading (SW auto-busts hashed chunks) |
| R4 | `format.ts` change ripples to 81 importing files | Additive optional param only; default output byte-identical (test-pinned); no reorganization |
| R5 | TanStack migration changes offline behavior | Wrapper **is** the queryFn; offline tests must pass untouched; scoping in keys; bootstrap preserved via prefetchQuery |
| R6 | Realtime invalidation missed → stale registers | Every existing reload call mapped (table §3.1) before removal; invalidate-on-signal regression tests per domain |
| R7 | Sales.tsx / PurchasesReturn.tsx extractions break shared-state flows | Callback injection for shared state; test-pinned seams (6+6 tests); riskiest seam (`usePurchaseReturnScan`) moved with its refs verbatim |
| R8 | Backend suite on Node 26 (`.nvmrc` 22) | Recorded now; full suite run at program end; if Node-26-only failures appear → attribute via clean-HEAD protocol, report honestly, do not fix silently |
| R9 | Server-authored messages stay English in bn UI | Documented limitation (master §5.6); mapping layer deferred |

---

## 5. Explicit non-goals (mirrors master PART 5 + §5.6)

Receipt/invoice paper renderers (backend `sales.service.ts`/`receiptShare.ts`, frontend `receipt-settings/renderers/*`, `usePrintReceipt`, `escpos`) stay English/as-configured; backend strings/messages; A4 invoice renderer; other modules (contacts, purchases, reports, due-management…); Bangla numerals; RTL; `useCartStore` migration; P2 findings (offline hardening, catalog pagination, coupon-in-header-discount, POS profit-base, provider-refund retry, comms reliability, customer archive columns, money-formatter reorg, POS hot-path memoization); `POS_GAP_CLOSURE_TRACKER.md` (root-level; untouched); future verticals.

## 6. Deferred registry (observed during recon, NOT in scope — listed so nothing is silently expanded)

1. `/due_by_customers` double-fetch (CustomersPage + CartItems raw axios) — TQ dedupe candidate.
2. Product select-options dual cache (Zustand + TQ `["product","select-options"]`) — Phase 6 commit 3 pins, does not unify.
3. Full-catalog refetch churn: `getProducts()` re-fires from 9 sites with no per-key granularity.
4. Roles fetched by two pages independently; UsersPage re-fetches locations the session already holds.
5. `sale.created` never refreshes the sales list today (may be intended — preserved, noted).
6. `register.changed` / `terminal.changed` revisions unconsumed.
7. Raw `৳{n.toFixed(2)}` renderings in SaleSuccessDialog bypass `formatCurrency` (money-render consolidation is out of scope).
8. Server-side Bangla (error messages, comms templates) — later phase.
9. Backend tsc `receiptShare.integration.test.ts` error + `terminalBinding` vitest setup failure + pos 119-error cleanup + 3 MB index chunk — separate maintenance candidates.
10. `ezpos-shell-v2` → v3 SW bump only if a Phase 5/6 release ever needs to purge stale shells (not expected — all new resources are hashed).

## 7. Open decisions for the user (defaults apply if unanswered)

- **D1 — backend tsc baseline**: record today's 1 pre-existing error as the gate floor (recommended), or authorize a separate one-commit fix of `receiptShare.integration.test.ts(283)` first (never mixed into feature commits).
- **D2 — vitest baseline**: record 290-pass + 4 documented pre-existing `terminalBinding` failures as the operative floor on this machine (recommended), or authorize a separate test-setup fix commit (jsdom localStorage shim) before Phase 5.
- **D3 — "customer" term**: কাস্টমার (recommended) vs ক্রেতা.
- **D4 — "Cash" term**: ক্যাশ (recommended; avoids Nagad-brand collision) vs নগদ.
- **D5 — hotkey cheatsheet labels** included in Phase 5 scope (recommended: yes).

## 8. Final program report (end of program, per master PART 9)

Per-phase/feature summary; DB changes (expected: none); API changes (none); permission changes (none); frontend changes; test results actual vs §0.2 baselines; git history (local commits; push only if instructed); remaining issues and deferred items. No completion claim without §2.8 acceptance evidence.
