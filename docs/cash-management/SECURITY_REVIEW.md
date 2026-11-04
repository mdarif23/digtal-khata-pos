# Security review — cash management & hardware bridge program

Scope: Phases 1–4 of the cash-drawer program + the surrounding cash domain.
Reviewed 2026-11-05. Statuses: ✅ done · 🟡 recommended follow-up · 🔴 must
decide/act (owner decision required).

## Findings

### S1 — Git history contains a real JWT secret 🔴
The repo previously tracked `ezPosBackend/.env` with a real
`AUTH_JWT_SECRET` (identified in the 2026-11 codebase analysis). The file is
**no longer tracked** (gitignore covers it; verified `git ls-files`), but the
secret remains in git history and therefore on every clone/remote.
**Action required:** rotate `AUTH_JWT_SECRET` (and any other credentials that
ever landed in history) and, if the remote is shared, purge history
(`git filter-repo`) + force-push — a coordinated, destructive operation that
needs the team's sign-off, hence deliberately not done automatically.
Rotation alone neutralizes the leaked value.

### S2 — Drawer-command authorization ✅
Sale-linked kicks require `cash_drawer.open`; no-sale kicks require
`cash_drawer.open_without_sale` (server-side, per-payload). Terminal must be
paired + active + in the caller's location; a sale-linked command must target
the sale's own location. Foreign terminals/commands are 404-masked.

### S3 — Drawer-command rate limiting ✅ (added this phase)
`POST /api/hardware/commands`: 30/min per user. Bridge poll endpoints:
240/min per terminal. Pairing: the same strict limiter as auth endpoints.

### S4 — Terminal identity & secret handling ✅
Secrets: 48-hex, generated server-side, SHA-256-hashed at rest, shown exactly
once, constant-time comparison, per-request re-read (rotation/deactivation/
deletion take effect on the next call), redacted in every log path.
Pairing codes: hashed at rest, 10-minute TTL, atomic single-use claim.
Bridge credentials file: 0600, isolated data dir, never echoed.

### S5 — Bridge attack surface ✅ (by design)
No local listener at all → no local CSRF/rebinding/CORS surface, no LNA
friction. All bridge traffic is outbound TLS to the backend with terminal
credentials. The bridge executes only fixed, validated ESC/POS builders —
arbitrary printer bytes are impossible.

### S6 — Drawer commands are never financial ✅
`hardware_commands` is audit-only; a successful/failed kick never creates,
modifies, or deletes a financial record. Financial movements bind 1:1 to
source records via the reference unique index.

### S7 — Multi-tenancy ✅
All new tables follow the composite-FK tenant chain; cross-business access is
404-masked (verified by tests). Terminal identity comes from the secret, not
client headers; user context comes from server-verified membership.

### S8 — Pre-existing platform notes 🟡 (documented, unchanged scope)
- Money math uses float rounding at the edges (`roundMoney`), with
  integer-cent validation on inputs. No decimal library. Acceptable at POS
  magnitudes; revisit if aggregations over large sums become hot paths.
- Rate limiting is in-memory per instance (documented platform-wide
  limitation) — a shared store is required before horizontal scaling.
- `hardware_commands` rows accumulate indefinitely; a retention/archival job
  is a future need, not a current risk.

### S9 — WebUSB legacy path 🟡
The browser WebUSB drawer/print path requires an explicit user gesture per
session and is Chrome-only; it stays as a fallback. It cannot silently open
hardware without the operator noticing, and the backend audit endpoint it
calls remains permission-gated.

## Testing evidence

Automated: backend suite 531 tests (incl. terminals, cash-management,
reporting-consistency, isolation suites) · bridge 21 tests · POS 125 unit
tests. End-to-end: `ezPosHardwareBridge/scripts/e2e-check.mts` exercises the
full chain (pair → authorize → claim → physical bytes → ack → audit) and
asserts a forged secret is rejected — all green (2026-11-05).
