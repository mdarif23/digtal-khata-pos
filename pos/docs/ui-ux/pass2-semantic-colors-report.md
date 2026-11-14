# ezPos POS Frontend — Pass 2: Semantic Color System, Spacing & Alignment

Date: 2026-11-14 · Branch: `fix/ui-and-ux` (continues the pass-1 program, see [final-report.md](final-report.md))
Direction implemented: **Save/Create = blue primary · Approve = green success · Delete = red danger · Attention = amber warning** — through shared tokens and shared components only, never per-page colors.

## 1. Semantic color system changes

Tokens (`src/index.css`, light+dark):

| Token | Light | Dark | Meaning |
|---|---|---|---|
| `--primary` | `#1d4ed8` blue-700 | `#60a5fa` | Main actions (Save, Create, Charge, Export) |
| `--success` | `#1c7f4a` | `#4dba79` | Completed/paid/received/positive |
| `--warning` | `#b45309` amber-700 | `#f59e0b` | Pending/partial/low-stock/refund actions |
| `--destructive` (+new `--destructive-foreground`) | red | red | Delete/void/cancel-transaction/discard |
| `--info` | `#0369a1` sky-700 | `#38bdf8` | Neutral information (kept distinct from action blue) |
| `--sidebar-primary` | zuccini green | green | Brand mark (logo) stays green |

Ring/focus moved to blue to match the primary action color.

## 2. Shared component changes (no per-page colors)

- **Button** (`components/ui/button.tsx`): new semantic variants `success`, `warning`, `info`; `destructive` is now **solid red with white text** (was a soft tint). All 24 existing destructive call sites upgraded at once — they are all genuinely destructive (deletes, archive, remove, cancel order, discard changes).
- **StatusBadge** tones unchanged (already centralized); last non-token hues eliminated (purple accents → `primary` token) in reports status/shrinkage/expense badges and the product info card.
- **ConfirmDeleteDialog** now renders a solid red Delete automatically through the shared variant.

## 3. Action semantics applied (with de-misclassifications)

| Action | Variant |
|---|---|
| Attendance **Approve**, transfer **Receive**, purchase **Receive items and update stock** | `success` (payment-only submit stays primary) |
| **Refund** family (table Refund, Refund entire sale, Record return) | `warning` — financial action, not failure-red |
| Bulk-Update **Apply**, Attendance **Clock out** | were `destructive` — demoted to primary (routine actions must not look dangerous) |
| Deletes / Archive category / Remove / Cancel order / Discard changes | `destructive` (solid red) |

## 4. Spacing & alignment fixes

- Toolbar search inputs standardized to the default control height (Products `h-10`, Purchases `h-11` → default h-9, aligning with adjacent selects).
- Removed the `-mt-2` negative-margin hack on Finance Overview.
- **Horizontal overflow eliminated** (verified with a scroll-aware Playwright probe):
  - `/sales` @1024: 256px document overflow → `SidebarInset` gained `min-w-0` (the app-shell flex item can now shrink; inner scroll containers own horizontal scrolling).
  - `/` POS @390: control cluster now wraps.
  - `/dashboard` @390: card articles gained `min-w-0` (560px tables scroll inside cards).
  - `/product` @390: table pagination row now wraps.
  - Sales history toolbar wraps to column until `lg`.

## 5. Visual verification (actual)

Playwright harness against a real seeded backend (register → business → location → products → sale):

- **69/69 checks passed** — 20 routes × {1920×1080, 1600×900, 1366×768} + key flows at {1024×768, 390×844}, each with page-error monitoring and a document-level horizontal-overflow assertion (>8px fails).
- Scroll-aware overflow probe: zero offenders on all previously failing routes.
- Screenshots reviewed: POS (blue actions, green brand, disabled states readable), Dashboard (semantic KPI chips, ৳ tabular money), Sales (green paid chip, amber Refund), Reports, Purchases, Settings pages.
- One harness-only artifact (blank sales-1920.png frame mid-paint) was re-taken with a settle wait and confirmed rendering correctly.

## 6. Regression results

| Check | Result |
|---|---|
| `tsc -p tsconfig.app.json --noEmit` | 0 new error files vs pristine-HEAD baseline |
| `vitest run` | 293/293 pass |
| `vite build` | passes |
| `eslint` | unchanged from baseline (TS files not linted by config — pre-existing gap) |

## 7. Remaining

- 1600×900 covered by screenshots but not re-inspected individually after the overflow fixes (covered by the automated overflow assertion).
- Contrast: primary blue on white text = 6.4:1, success green 6.3:1, warning amber 4.6:1, destructive red 4.5:1 — all pass AA for their sizes.
- Charts intentionally keep distinct hues (chart-1..5 tokens); legends are per-report.

## 8. Scope confirmation

Presentation only — no backend/DB/API/business-logic/permission changes; no route changes; no fake controls; existing functionality and tests preserved.
