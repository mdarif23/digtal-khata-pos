# Permission documentation — cash management & hardware

Naming convention: `<module>[.<submodule>].<action>`, seeded idempotently at
startup from `PERMISSION_CATALOG` (`ezPosBackend/src/rbac/permissions.ts`).
The business owner always holds the wildcard (`*`).

## New keys (this program)

| Key | Grants |
|---|---|
| `cash_register.view` | See registers and register sessions |
| `cash_register.open` | Open a register session |
| `cash_register.close` | Close and reconcile a session (counted cash + variance) |
| `cash_register.manage` | Create, rename, deactivate registers |
| `cash_movement.create` | Record cash in/out, safe deposits/withdrawals, adjustments |
| `cash_drawer.open` | Open the physical drawer (e.g. after a cash sale) |
| `cash_drawer.open_without_sale` | Open the drawer without a sale (stronger; also unlocks no-sale manual kicks) |
| `pos_terminal.view` | Full terminal registry detail + per-terminal command history |
| `pos_terminal.manage` | Pair, rename, activate/deactivate, rotate secrets, delete terminals |

## Role defaults (applied to NEW businesses' role templates)

| Key family | Owner | Manager | Cashier | Accountant |
|---|---|---|---|---|
| cash_register.view / open / close | ✅ (wildcard) | ✅ | ✅ | ✅ |
| cash_register.manage | ✅ | ✅ | — | — |
| cash_movement.create | ✅ | ✅ | ✅ | — |
| cash_drawer.open | ✅ | ✅ | ✅ | — |
| cash_drawer.open_without_sale | ✅ | ✅ | — | — |
| pos_terminal.view | ✅ | ✅ | — | ✅ |
| pos_terminal.manage | ✅ | ✅ | — | — |

Existing businesses' custom roles are untouched — assign the new keys from
Roles → permissions matrix when wanted.

## Enforcement points

- **Register endpoints** keep their existing gates (`settings.edit` for
  management, full access + session ownership for open/movement/close) —
  the new keys exist for assignment and for the NEW enforcement surfaces
  below; re-gating the legacy register endpoints is deliberately deferred
  so no existing workflow breaks without a UI to manage the roles.
- **`POST /api/hardware/commands`** — per-payload: sale-linked →
  `cash_drawer.open`; no-sale → `cash_drawer.open_without_sale` (checked in
  the controller via `callerHasPermission`; rate-limited 30/min/user).
- **`GET /api/terminals`** — `pos_terminal.view` OR drawer operator (the POS
  must list terminals to target a drawer).
- **Terminal management** (pairing codes, rename, status, rotate, delete,
  command history) — `pos_terminal.manage` / `pos_terminal.view`.
- **Bridge endpoints** — terminal-secret auth, not user permissions; a
  terminal can only see and settle its own commands.
- Frontend guards mirror these for UX only (`RequirePermission`,
  `PermissionButton`); the backend re-verifies every call.
