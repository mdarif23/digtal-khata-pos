# ezPos Website — Complete Audit (Phase 0)

> Date: 2026-11-02 · Branch: `feature/ezposwebsite` · Commit audited: `b992fce`..HEAD
> Scope: `ezPosWebsite` only. `ezPosBackend`, `pos`, and DB are inspected
> only as API-contract references, per the governing policy (backend
> changes allowed when genuinely necessary, with approval for
> significant/database changes — see EZPOS_WEBSITE_IMPLEMENTATION_PLAN.md §0).

## 1. Architecture

- **Next.js 16.4.3** (App Router, Turbopack, Cache Components enabled),
  React 19.3, TypeScript 5, Tailwind CSS 4, lucide icons.
- **Data fetching**: typed `fetch` clients in `src/lib/api/*` (auth,
  account, orders, portal, integrations, webhooks, notifications,
  sessions, saas-admin). No Axios; no TanStack Query — server state is
  `useState` + `useEffect`/`useCallback` per component.
- **Forms**: react-hook-form + zod v4 (`@hookform/resolvers`).
- **Auth**: memory access token + HttpOnly refresh cookie (backend-set),
  `bootstrapSession`-style refresh in `AuthProvider`.
- **Route map** (35 routes): public (home, features, pricing, industries,
  about, contact, faq, developers, terms, privacy, refund-policy,
  sign-in/up/forgot/reset/verify-email), portal (`/account/*` ×10 +
  `/dashboard` + `/onboarding` + `/payment/*` ×3), admin (`/saas-admin/*`
  ×7).
- **Governing policy note**: two governing documents were provided. The
  backend-modification policy (controlled changes, approval for DB) is
  treated as the operative amendment to the master prompt's
  "do not modify backend" rule. Current state: **no missing-API blockers**
  — every website feature calls an existing, verified backend endpoint.

## 2. Completed functionality (verified by implementation, not file presence)

| Feature | Implementation | Verified behavior |
|---|---|---|
| Marketing site | home, features, industries, about, contact, faq, legal ×3 | contact form → tickets; live pricing on home+pricing |
| Pricing | `pricing/page.tsx` + server fetch | monthly+yearly plans from backend, yearly toggle populated |
| Auth UI | sign-in/up, forgot/reset, verify-email | all flows hit live endpoints; one-time secrets handled |
| Onboarding | 4-step wizard | business → location → prefs → plan; skippable; mode-aware |
| Portal overview | `/account` | plan, status, usage bars, recent invoices/payments |
| Orders | `/account/orders` | unified channels, filters, detail, COD mark-paid, fulfillment transitions, pagination |
| Subscription | `/account/subscription` | plan grid, upgrade w/ proration, cancel (scheduled/immediate), reactivate, renew, history |
| Billing | `/account/billing` + `/account/invoices/[id]` | invoices/payments tables, pay-now → gateway, print invoice, pagination |
| Settings | `/account/settings` | business fields, logo picker, export JSON, profile, password, sessions, resend verification |
| Integrations | `/account/integrations` | WooCommerce connect/sync/disconnect, business-mode selector, API keys (one-time secret) |
| Webhooks | `/account/webhooks` | endpoint CRUD, delivery history, test events |
| Support | `/account/support` | tickets + threads, admin replies visible |
| Admin | `/saas-admin/*` ×7 | metrics, businesses (+detail), subscriptions (+actions), payments w/ filters, plans CRUD, support |
| Payments | `/payment/success|failed|canceled` | server-side verification flow, pending state, retry |

Backend endpoints consumed: 40+ live endpoints, all built and tested in
`ezPosBackend` (251/251 backend tests at audit time).

## 3. Missing functionality

1. **Automated tests** — no test runner configured in `ezPosWebsite`
   (no Vitest/Jest/Playwright). Backend has 251 tests; the website has
   zero. Spec Phase 13 requires auth/subscription/billing/admin tests.
2. **Cookie Policy page** — spec §4 lists it; not built.
3. **Subscription & Billing Policy page** — spec §4 lists it; refund
   policy exists but this separate page does not.
4. **Admin audit-log viewer** — `saas_admin_audit` rows exist in the DB
   but there is no read endpoint or UI page.
5. **Admin customers view** — spec suggests a customer-centric list;
   currently only business-centric (owner data is embedded).
6. **Onboarding progress persistence** — wizard state is in-memory;
   backend has no progress storage (documented dependency).
7. **Email change** — by design email is the verification anchor and is
   not editable in Settings (backend has no email-change endpoint).
8. **Notification preferences** (spec §6 "where supported") — backend
   has no preferences storage.
9. **Payment method selection UI** — checkout redirects to the gateway,
   which hosts method selection (SSLCommerz). bKash/Nagad/ShurjoPay are
   not configured server-side; per spec, none are displayed.
10. **Blog/resources** — "if appropriate"; deliberately not built yet.

## 4. Defective functionality

1. **16 ESLint errors** (`npm run lint`): all React-Compiler rule
   "setState synchronously within an effect" in the data-loading effects
   of portal/admin components. Functionally the pages work, but the
   rule exists to prevent cascading-render bugs and the spec requires a
   clean lint. Fix = async setter pattern or TanStack Query migration.
2. **Two local checkouts** — `D:\ezposzcode\digtal-khata-pos` (no
   `ezPosWebsite/.env`) and `D:\digtal-khata-pos` (has `.env`). This
   mismatch caused the earlier "pricing unavailable" report. Both track
   the same remote; consolidate before further work.
3. **`useSearchParams` Suspense boundaries** — previously caused
   build failures; audited pages are covered, but any new page using
   search params must wrap in `<Suspense>` (Next 16 requirement).

## 5. UI/UX gaps

- Orders/billing/support lists: pagination added for orders + billing;
  support ticket list still unpaginated (≤100).
- Overview page: no link to Orders from the overview body (nav covers it).
- Empty states exist across lists; loading states present; error states
  present via Alert. Success feedback via inline messages.
- Accessibility: labels, aria-current, aria-invalid wired; contrast uses
  slate/indigo palette; not yet formally audited (axe/Lighthouse pass
  pending — see plan).

## 6. Frontend security posture

- Access token memory-only; refresh in HttpOnly cookie scoped to
  `/api/auth`. No secrets in `NEXT_PUBLIC_*`.
- Admin routes gated client-side on `platform_admin` **and** by backend
  `requirePlatformAdmin` on every endpoint.
- Prices/totals/status always rendered from backend responses; no
  client-computed trust.
- Payment flow treats redirects as unverified; success page calls the
  server-verify endpoint.
- Inputs validated with zod client-side and server-side.
- Pending: CSP headers (Next config), formal dependency audit.

## 7. API integration gaps / backend dependencies

All consumed endpoints exist. Remaining **backend-dependent items**
(require approval per the backend modification policy — none block
current UI):

| Dependency | Needed for | Status |
|---|---|---|
| `GET /api/saas/audit-logs` | admin audit-log viewer | not built (backend+UI) |
| `PATCH /api/auth/email` (+ verification) | email change | not built |
| Onboarding progress storage | resumable onboarding | not built |
| Notification preferences storage | per-user notification settings | not built |
| Support ticket category/priority fields | richer support UI | not built |
| `refresh_tokens.last_used_at` | "last active" on sessions card | not built |

## 8. Testing gaps

- No unit tests for `src/lib/api/*` clients (auth refresh race, portal
  unwrap logic — the `{success,data}` envelope bug class).
- No component tests (forms, paginators, permission gating).
- No E2E for auth → onboarding → subscribe → pay → cancel.
- Backend integration suites cover the API side (251/251 green).

## 9. External dependencies

- Backend running (ports 3000) for any authenticated page.
- SSLCommerz production credentials for real payments (sandbox code
  complete, untested against live store).
- Resend API key for transactional email delivery.

## 10. Implementation priorities

- **P0**: test framework (Vitest) + lint-error cleanup; consolidate
  checkouts; `.env` setup documentation.
- **P1**: missing policy pages (cookie + subscription/billing); terms
  acceptance checkbox at registration; global `error.tsx`; admin
  audit-log viewer (backend endpoint + page).
- **P2**: TanStack Query adoption for server state (resolves the lint
  error class); canonical URLs + JSON-LD; support pagination; admin
  payment export (CSV); customers view.
- **P3**: blog/resources; onboarding progress (blocked on backend);
  email change (blocked on backend); notification preferences (blocked
  on backend).
