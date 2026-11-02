# ezPos Website — Implementation Plan

> Companion to EZPOS_WEBSITE_AUDIT.md and EZPOS_WEBSITE_GAP_TRACKER.md.
> Executed phase-by-phase (A–J per the master prompt), with per-phase
> verification (typecheck, lint, build, affected-workflow testing) and
> gap-tracker updates.

## §0 Governing policy (operative)

Two documents govern this work:

1. **Backend modification policy** (provided first): `ezPosBackend`
   changes are allowed when genuinely necessary for the website —
   extending existing modules, backward-compatible only, with a written
   proposal (problem, endpoints, DB changes, impact, tests) and explicit
   approval before significant or database-level changes.
2. **Master prompt** §2.4/§18: website-only scope, no backend changes.

Resolution: the policy block amends the master prompt. Concretely —
website features are built first; if a feature is blocked on a missing
backend capability, the dependency is documented and a proposal is
presented; nothing in `ezPosBackend` changes without approval. Current
audit finding: **no blocked features** — all existing UI calls verified
endpoints. Two P1 items (audit-log viewer) and three P2/P3 items will
require backend proposals when scheduled.

## Phase A — Audit ✅ (this document set)

Deliverables: AUDIT / GAP_TRACKER / IMPLEMENTATION_PLAN. No source code
changed.

## Phase B — Foundation

1. **Consolidate checkouts** (operator action, not code): keep one of
   `D:\ezposzcode\digtal-khata-pos` / `D:\digtal-khata-pos`, create
   `ezPosWebsite/.env` from `.env.example` (API_BASE_URL etc.).
2. **Vitest setup** (P0): `vitest` + `@testing-library/react` +
   `jsdom`; unit tests for `src/lib/api/*` clients (auth refresh race,
   `{success,data}` unwrap, portal/notifications/sessions clients) and
   form validation schemas. Add `npm test`.
3. **Lint cleanup** (P0, 16 errors): fix the React-Compiler
   setState-in-effect violations — extract async data loading into
   awaited callbacks (or, with the TanStack Query adoption below, the
   pattern disappears entirely).
4. **Global `error.tsx`** (P1): branded error boundary with retry.
5. **npm audit** (P1) and dependency bump pass.

## Phase C — Public website completion

1. ~~Cookie Policy page (P1) + link in footer.~~ ✅
2. ~~Subscription & Billing Policy page (P1) + link.~~ ✅
3. ~~Canonical URLs + JSON-LD (P2).~~ ✅ `publicMetadata()` helper on all
   indexable public pages; Organization + WebSite JSON-LD in the root
   layout; SoftwareApplication offers on pricing built only from plans
   served by the backend.
4. Homepage copy pass after SSLCommerz go-live (remove "not open yet"
   caveats) — content task, gated on operator.

## Phase D — Auth & onboarding

1. ~~Terms-acceptance checkbox on sign-up.~~ ✅ (approved batch 1:
   `businesses.terms_accepted_at` stamped server-side on registration.)
2. ~~Onboarding resume.~~ ✅ (approved batch 1:
   `businesses.onboarding_step`, wizard saves progress per step and
   resumes.)
3. Duplicate-submission guards already in place (isSubmitting) — verify
   in tests.

## Phase E — Customer portal

1. Support ticket list pagination (⛔ backend proposal #6: list param;
   UI pager ready).
2. Settings: polish logo crop hints, per-session labels.
3. ~~Session "last active".~~ ✅ (approved batch 1:
   `refresh_tokens.last_used_at` stamped at issue and on rotation.)
4. ~~Orders detail close affordance~~ ✅.

## Phase F — Subscription & billing

1. Already complete: grid, proration, cancel/reactivate/renew, invoices,
   pay-now, print view.
2. ~~CSV export of invoices~~ ✅ (frontend-only, from loaded data; shared
   `src/lib/csv.ts` util with unit tests).
3. Payment-method display once providers are configured server-side
   (⛔ backend config, not code).

## Phase G — Admin portal

1. ~~Audit-log viewer~~ ✅ (approved batch 1: `GET /api/saas/audit-logs`
   with entity filter + `/saas-admin/audit-logs` page).
2. Customers (person-centric) view (⛔ backend proposal #7: new endpoint
   + page).
3. ~~Admin payments CSV export~~ ✅ (frontend-only, from loaded data).
4. ~~Plans feature/limit full editor~~ ✅ (inline editor per plan row;
   sends complete limits/features objects — the backend replaces them
   wholesale).

## Phase H — Notifications & support

1. Notification preferences (⛔ blocked — backend proposal:
   preferences storage; defer until requested).
2. Support categories/priority (⛔ blocked — backend proposal: columns +
   validation; defer).
3. ~~Unread-count polling on the portal bell~~ ✅ (60s interval, skipped
   while the tab is hidden).

## Phase I — Production readiness

1. Lighthouse + axe accessibility pass, fix findings (P2).
2. Performance review: bundle analysis, server/client component split
   (P2).
3. Security review: CSP headers in next.config, referrer policies,
   dependency audit (P1). npm audit ✅ run 2026-11-02: 16 moderate
   findings, all `minimatch` via the dev-only ESLint toolchain — accepted
   (no runtime exposure; the `--force` fix would downgrade eslint to v4).
   CSP headers still pending.
4. SSLCommerz sandbox smoke test checklist (operator, gated on keys).

## Phase J — Final gap verification

Update EZPOS_WEBSITE_GAP_TRACKER.md with per-feature evidence; blocked
features remain marked ⛔ with their backend proposals attached.

## Backend change proposals requiring approval

**Batch 1 — approved and shipped 2026-11-02** (proposals 1–5: audit-log
endpoint, `terms_accepted_at`, `onboarding_step`, `last_used_at`,
ticket category/priority).

| # | Change | Why | Size |
|---|---|---|---|
| 6 | support-ticket list pagination params | portal + admin ticket lists | small, additive |
| 7 | `GET /api/saas/customers` (person-centric view over business memberships) | admin customer management (P2) | small, additive |

All are additive: no existing POS behavior touched, no destructive
operations, backward-compatible. Approval will be requested per-item
when its phase is scheduled.

## Verification cadence (every phase)

`npx tsc --noEmit` → `npm run lint` → `npm test` (once configured) →
`npm run build` → affected-workflow manual test → gap-tracker update →
commit.
