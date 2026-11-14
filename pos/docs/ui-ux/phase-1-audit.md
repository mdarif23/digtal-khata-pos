# ezPos POS Frontend — UI/UX Audit (Phase 1)

Date: 2026-11-14 · Branch: `fix/ui-and-ux` · Scope: `pos/` frontend only.
This document is the audit + implementation plan for the UI/UX program. Backend, DB, API contracts and business logic are out of scope and untouched.

## 1. Application surface

- **84 routes** discovered in `src/routes/AppRoutes.tsx` (78 inside `AppLayout`; POS `/`, add/edit product, `/403`, `/cfd`, `/payment/return` are standalone by design).
- **~95 page files** under `src/features/*/pages/` + `src/pages/`; the Reports hub alone mounts **34 tabs**.
- ~60 dialogs/drawers; permission gating via `RequirePermission` on 80/84 routes (permission keys only, admin wildcard supported).
- Verified healthy baseline: production build ✓ (18s), unit tests 293/293 ✓, dev server ✓.

## 2. Design-system state

- Tailwind v4 CSS-first tokens in `src/index.css`; shadcn-style primitives in `src/components/ui` (33 files, best-behaved layer).
- **All semantic tokens are grayscale** (`--primary` is near-black; `--chart-1..5` are shades of gray → flat charts app-wide). The brand-green `zuccini` scale is defined but referenced by only 3 legacy class usages.
- **Dark mode is unreachable scaffolding** — `.dark` palette exists, nothing toggles it; 72 `dark:` variants are dead code.
- **daisyUI is wired in but ~dead** — full plugin cost for 4 `btn` classes in a file that nothing imports.
- **`index.html` is wrong**: entry points at `/src/main.jsx` (real file is `main.tsx`; it only works via Vite extension fallback), a dead `/src/style.css` link 404s, title is `pos`, favicon is the Vite logo.
- Raw palette classes outnumber token classes ~2280 : 1395. Dashboard is the extreme (166 raw, 0 tokens); repeated bespoke shadow recipe `shadow-slate-950/[0.02]` ×21.
- **Three icon libraries** ship (lucide 179 files, react-icons 6, hugeicons installed but 0 usages).

## 3. Page-level inconsistencies (ranked)

1. **Page headers**: no shared component; ≥15 different `h1` class recipes; 11 finance pages hand-duplicate the exact `ReportHeader` pattern that 23 report pages share; Users/Locations/Products/Contacts pages have no readable title/description at all.
2. **Page containers**: 6 competing conventions — `max-w-5xl`, `max-w-6xl`, `max-w-7xl`, `max-w-[1600px]`, `max-w-[1800px]`, full-width/no padding (`AppLayout`'s `<main>` sets none).
3. **Status badges free-for-all**: 15 files with hard-coded `bg-*-100` chips, 17 per-page `getStatusColor` helpers, 35 files with inline color ternaries vs 37 files using ui `Badge` — the same status renders in 3+ visual languages.
4. **Tables**: raw `<table>` in 24 pages vs ui `<Table>` in 13 vs tanstack in warranty — pricing module is 100% raw; numeric right-alignment uneven.
5. **Currency**: two competing `formatCurrency` implementations (reports `reportUtils.ts` ×23 pages, purchases `formatCurrency.ts` ×5) + duplicated `formatMoney`; 45 files use raw `toFixed`, 71 hard-code `৳`. Even the Intl formatter renders `BDT 1,234.50` in some ICU builds — money has no single presentation.
6. **Toolbars**: 17 files hand-build the same Search-icon input; `EntityListLayout` adopted by only 3 pages; toolbar placement lives in 4 different containers.
7. **Dialogs**: ~7 width conventions, 8 hand-rolled `max-h-[85vh] overflow-y-auto` wrappers, 20/35 dialogs skip `DialogFooter` (ad-hoc button rows).
8. **Destructive confirms**: `window.confirm` in 5 files (all of pricing + barcodes) vs `ConfirmDeleteDialog` in 5 files.
9. **Empty/loading states**: 4 local `EmptyState` copies + ~36 files of ad-hoc "No X found" markup; loading alternates Skeleton / spinner strings / conditional JSX.
10. **Native `<button>` leaks** in 20 files (worst: OnlineOrderDetails ×10, PurchasesList ×8), including `ReportHeader`'s Print button used by all 23 report pages.
11. **Dashboard** (`pages/Dashboard/Dashboard.tsx`, 1403 lines) is the single most inconsistent file: hand-rolled cards, raw tables, own badge colors, own EmptyState — and it's the landing page.
12. **Toast double API**: two calling conventions for the same `toast.add` (title-style vs description-style). Both work; migrating 33+ files is churn — documented, not changed.

## 4. Navigation issues (UX bugs)

- **Unreachable pages**: `/register` (cash register) and `/settings/hardware` are routed+guarded but missing from `navigation.ts` — only reachable by typing the URL. `/loyalty-settings` likewise has no nav entry.
- **Permission mismatches (nav shows → page 403s)**: "Messages" allows `comms.view` but the route demands `comms.manage`; "Expense Budgets" (Finance group) demands `budget.view` but `/expense` demands `expenses.view`; Reports group doesn't list `warranty.reports.view` which the route accepts.
- Duplicate "Expense" entry (top-level + Finance group → same page).
- Dead legacy files: `features/Contacts/pages/Customer.tsx` + `components/layout/Sidebar.tsx` (import each other, imported by nothing live).

## 5. Implementation plan (approved-in-scope changes only)

| Phase | Work |
|---|---|
| 2 — Foundation | Brand tokens (primary=zuccini green, success/warning/info, real chart colors) in light+dark; canonical `lib/format.ts` formatters; shared `PageHeader`, `PageContainer`, `StatusBadge`, `EmptyState`, `SearchInput`; `AppLayout` header bar; `index.html` hygiene + favicon; remove daisyUI; lucide-only nav icons; nav fixes (Settings group, unreachable pages, permission mismatches) |
| 3 — Priority modules | POS checkout (PaymentModal, cart, totals), Products (list/add-edit/variants/taxonomies), Sales, Purchases, Inventory (adjustment/transfers/counts), Finance + Expenses, Dashboard retokenization, Contacts |
| 4 — Remaining | Reports hub, Quotations, Online orders, Loyalty, Gift cards, Register, Users, Roles, Locations, Pricing module, Coupons/Promotions, Warranty, Procurement, Settings (receipt/backup/comms/hardware), Attendance, Audit |
| 5 — Regression | tsc + lint + tests + build; browser visual pass on key screens at 1920/1366/1024 widths |

Constraints honored: no business-logic/API/DB changes, no route-path changes, permissions untouched (nav visibility fixes only align the sidebar with existing route guards), no fake functionality, existing keyboard shortcuts preserved.
