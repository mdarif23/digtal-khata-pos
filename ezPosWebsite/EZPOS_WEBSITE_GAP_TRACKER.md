# ezPos Website — Gap Tracker

> Living document. Updated at the end of every phase.
> Statuses: ✅ Complete · 🟡 Partial · 🔴 Missing · ⛔ Blocked (external dependency)
> API dep: backend endpoint status. UI: frontend implementation status.
> Last updated: 2026-11-02 (after approved backend batch 1 + frontend-only P2 batch).

## Foundation

| Feature | Prev | Current | UI | API dep | Security | Tests | Notes |
|---|---|---|---|---|---|---|---|
| Auth (sign-in/up/out, refresh, reset, verify) | ✅ | ✅ | ✅ | ✅ | ✅ memory token + HttpOnly cookie | ✅ 9 unit tests (lib/api) | |
| Protected portal routes | ✅ | ✅ | ✅ | ✅ backend authoritative | ✅ | ⛔ | |
| Protected admin routes | ✅ | ✅ | ✅ | ✅ requirePlatformAdmin | ✅ | ✅ backend-tested | |
| Business switcher | 🔴 | ✅ | ✅ | ✅ | ✅ | ⛔ | reload-on-switch pattern |
| Pagination (orders/billing) | 🔴 | ✅ | ✅ | ✅ | ✅ | ⛔ | support list pending (backend proposal #6) |
| robots/sitemap/404 | 🔴 | ✅ | ✅ | n/a | n/a | n/a | |

## Customer portal

| Feature | Prev | Current | UI | API dep | Security | Tests | Remaining issues |
|---|---|---|---|---|---|---|---|
| Overview (plan/usage/recent) | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔ | respects active business |
| Orders (unified, filters, detail) | ✅ | ✅ | ✅ | ✅ | ✅ isolation tested | ⛔ | pagination ✅; detail Close affordance ✅ |
| Subscription mgmt (upgrade/downgrade/cancel/renew) | ✅ | ✅ | ✅ | ✅ | ✅ audit-logged | ✅ backend | |
| Billing history + invoices + pay-now | ✅ | ✅ | ✅ | ✅ | ✅ server-verified payments | ✅ backend | invoice CSV export ✅ (loaded data) |
| Settings (business/profile/password) | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔ | |
| Logo upload | 🔴 | ✅ | ✅ | ✅ | ✅ data-URL, no upload surface | ⛔ | |
| Data export (JSON) | 🔴 | ✅ | ✅ | ✅ | ✅ read-mode OK | ⛔ | |
| Notifications (bell) | 🔴 | ✅ | ✅ | ✅ | ✅ business-scoped | ⛔ | unread-count polling ✅ (60s, tab-visibility aware); preferences ⛔ blocked on backend |
| Active sessions | 🔴 | ✅ | ✅ | ✅ | ✅ ownership-scoped revoke | ✅ backend | last-active ✅ (`refresh_tokens.last_used_at`) |
| Support tickets + threads | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ backend | category/priority ✅; list pagination ⛔ backend proposal #6 |
| Integrations (WooCommerce) | ✅ | ✅ | ✅ | ✅ | ✅ encrypted creds | ✅ backend | |
| Storefront API keys | ✅ | ✅ | ✅ | ✅ | ✅ one-time secret | ✅ backend | env selection P3 |
| Webhooks management | ✅ | ✅ | ✅ | ✅ | ✅ signed | ✅ backend | |

## SaaS admin

| Feature | Prev | Current | UI | API dep | Security | Tests | Notes |
|---|---|---|---|---|---|---|---|
| Overview metrics (MRR/ARR/statuses) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ backend | definitions documented |
| Businesses list + suspend/reactivate | ✅ | ✅ | ✅ | ✅ | ✅ audited | ✅ backend | |
| Business detail drill-down | 🔴 | ✅ | ✅ | ✅ | ✅ admin-gated | ⛔ | |
| Subscriptions (change/extend/suspend/cancel) | ✅ | ✅ | ✅ | ✅ | ✅ audited | ✅ backend | grant-trial ✅ |
| Payments (+filters) | 🟡 | ✅ | ✅ | ✅ | ✅ | ⛔ | CSV export ✅ (loaded data) |
| Invoices | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔ | |
| Plans CRUD | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ backend | feature/limit editor ✅ (inline editor; backend replaces objects wholesale) |
| Support (all tickets, reply, status) | ✅ | ✅ | ✅ | ✅ | ✅ notifies owner | ✅ backend | triage via category/priority ✅ |
| Audit-log viewer | 🔴 | ✅ | ✅ | ✅ `GET /api/saas/audit-logs` | ✅ rows written | ✅ backend (batch 1) | entity-type filter |
| Customers view (person-centric) | 🔴 | 🟡 | 🟡 | ⛔ backend proposal #7 | ✅ | ⛔ | P2 |

## Marketing site

| Feature | Prev | Current | UI | API dep | Security | Tests | Notes |
|---|---|---|---|---|---|---|---|
| Home/features/industries/about/contact/faq | ✅ | ✅ | ✅ | ✅ tickets + plans | ✅ | ⛔ | |
| Pricing (live plans, yearly toggle) | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔ | yearly seeded |
| Legal: terms/privacy/refund | ✅ | ✅ | ✅ | n/a | ✅ | n/a | wording aligned to UI |
| Cookie policy | 🔴 | ✅ | ✅ | n/a | n/a | n/a | Phase C |
| Subscription & billing policy page | 🔴 | ✅ | ✅ | n/a | n/a | n/a | Phase C |
| Developers docs | ✅ | ✅ | ✅ | n/a | ✅ | n/a | |
| robots/sitemap/404 | 🔴 | ✅ | ✅ | n/a | ✅ | n/a | |
| JSON-LD structured data | 🔴 | ✅ | ✅ | n/a | ✅ honest data only | n/a | Organization + WebSite (layout); SoftwareApplication offers on pricing built from real backend plans only |
| Canonical URLs | 🔴 | ✅ | ✅ | n/a | n/a | n/a | `publicMetadata()` helper across all 12 indexable public pages + home |
| Sign-up terms checkbox | 🔴 | ✅ | ✅ | ✅ `terms_accepted_at` | ✅ | ⛔ | batch 1 |
| Blog/resources | 🔴 | 🔴 | 🔴 | n/a | n/a | n/a | P3, "if appropriate" |

## Cross-cutting

| Item | Prev | Current | Status | Notes |
|---|---|---|---|---|
| ESLint | 🔴 | ✅ 0 errors | 16 warnings (unused vars, one location-assign) remain | React-Compiler setState class fixed |
| Test framework (Vitest) | 🔴 | ✅ | 13 tests, `npm test` | unit: auth client, portal client, CSV util |
| TanStack Query adoption | 🔴 | 🔴 | fetch + useState pattern | P2: dedupes requests; would also remove remaining effect-loading patterns |
| Axios | 🔴 | n/a | deliberate: typed fetch clients | deviation documented |
| npm audit (deps) | 🔴 | ✅ run | 16 moderate, all `minimatch` via dev-only ESLint toolchain | accepted: no runtime exposure; `audit fix --force` would downgrade eslint to v4 |
| Lighthouse/a11y pass | 🔴 | 🔴 | not yet run | P2, next |
| Loading/empty/error states | 🟡 | ✅ | present across portal | |
| Responsive layouts | 🟡 | ✅ | nav mobile menu, grids collapse | |

## Open backend proposals (require approval)

| # | Change | Why | Size |
|---|---|---|---|
| 6 | support-ticket list pagination param (`?page=&limit=` on portal + admin ticket lists) | ticket volume growth; UI pager ready | small, additive |
| 7 | person-centric customers view (`GET /api/saas/customers` — users with business memberships) | admin customer management P2 | small, additive |
