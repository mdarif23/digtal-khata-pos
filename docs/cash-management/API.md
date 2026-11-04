# API documentation — cash management, registers, terminals, bridge

All endpoints require `Authorization: Bearer <access token>` and
`X-Business-Id` (server-verified membership). Location-scoped endpoints use
`X-Location-Id` (or the business default). Errors: `{ success: false, message }`
with 400/401/403/404/409. Foreign entities are 404-masked.

## Registers & sessions (location-scoped)

| Method & path | Permission | Purpose |
|---|---|---|
| GET `/api/registers` | (any member of location) | Registers + open sessions |
| POST `/api/registers` | `settings.edit` + full access | Create register |
| PATCH `/api/registers/:registerId` | `settings.edit` + full access | Rename / activate / deactivate |
| POST `/api/registers/:registerId/open` | full access | Open session `{ openingCash ≥ 0 }` — one per register, one per user |
| GET `/api/sessions/current` | auth | Caller's open session + live expected cash |
| GET `/api/sessions/:sessionId` | owner, owner-account, or `settings.view` | Session detail + transaction ledger |
| POST `/api/sessions/:sessionId/cash-movement` | full access (session owner) | `{ type: cash_in\|cash_out\|safe_deposit\|safe_withdrawal\|adjustment_in\|adjustment_out, amount > 0, note? }` |
| POST `/api/sessions/:sessionId/close` | full access (session owner) | `{ countedCash ≥ 0, notes? }` → stores expected/counted/difference, notifies on discrepancy |

## Reports

| Method & path | Permission | Purpose |
|---|---|---|
| GET `/api/reports/financial/register-close` | `reports.sales.view` | Z-report: per-session ledger (opening, cash sales, non-cash, cash in/out, **cash refunds**, safe movements, adjustments, expected/counted/difference), period aggregates |
| GET `/api/reports/registers` | `reports.financial.view` | Register shift summaries + totals |

## POS terminals (user-facing)

| Method & path | Permission | Purpose |
|---|---|---|
| GET `/api/terminals` | `pos_terminal.view` **or** drawer operator (`cash_drawer.open*`) — POS needs the list to target a drawer | Terminals at the caller's location |
| GET `/api/terminals/:terminalId` | `pos_terminal.view` | Terminal detail |
| POST `/api/terminals/pairing-code` | `pos_terminal.manage` | Mint one-time code (10 min, single use) |
| PATCH `/api/terminals/:terminalId` | `pos_terminal.manage` | Rename / activate / deactivate |
| DELETE `/api/terminals/:terminalId` | `pos_terminal.manage` | Delete (refused if command history exists — deactivate instead) |
| POST `/api/terminals/:terminalId/rotate-secret` | `pos_terminal.manage` | New bridge secret (returned once; old dies immediately) |
| GET `/api/terminals/:terminalId/commands` | `pos_terminal.view` | Command history |

## Hardware commands (POS → backend → bridge)

| Method & path | Permission | Purpose |
|---|---|---|
| POST `/api/hardware/commands` | sale-linked: `cash_drawer.open`; no-sale: `cash_drawer.open_without_sale` (per-payload check) + full access; rate limit 30/min/user | `{ terminalId, type: "drawer_open", saleId?, reason? }` → command with 15 s TTL |
| GET `/api/hardware/commands/:commandId` | drawer operator or `pos_terminal.view` | Status + result detail (poll sweeps expiry) |

## Bridge endpoints (terminal-secret auth, outbound-only)

Auth: `Authorization: Bearer ezpos_tb_<secret>` + `X-Terminal-Id: <id>`.
Rate limit 240/min/terminal.

| Method & path | Auth | Purpose |
|---|---|---|
| POST `/api/bridge/pair` | one-time code (IP rate-limited) | `{ code, deviceName?, deviceInfo? }` → `{ terminalId, terminalName, locationId, secret }` — secret shown once |
| GET `/api/bridge/terminal` | terminal | Self info + heartbeat (last_seen) |
| POST `/api/bridge/commands/claim` | terminal | Atomically receive pending commands (marks `received`) |
| POST `/api/bridge/commands/:commandId/ack` | terminal | `{ status: validated\|executing\|completed\|failed\|unknown_outcome, detail? }` — one-way machine |

## Legacy audit sink

| Method & path | Permission | Purpose |
|---|---|---|
| POST `/api/hardware/drawer-kick` | `pos.create_sale` + full access | WebUSB-path audit record (`hardware.drawer_opened`) — writes no command, touches no device |

## Audit actions written by this subsystem

`sale.create`, `sale.refund_item/sale`, `sale.exchange` (existing) ·
`hardware.command_created`, `hardware.command_completed`,
`hardware.command_failed`, `hardware.drawer_opened` ·
`pos_terminal.paired`, `pos_terminal.updated`, `pos_terminal.deleted`,
`pos_terminal.secret_rotated` · register discrepancy notifications via the
notification service on close.
