# Cash Drawer, Cash Management & Windows Hardware Bridge — Final Architecture

Status: implemented (Phases 1–5 of the cash-management program, 2026-11).

## 1. System overview

```
ezPos Backend (Express + TS + Drizzle + Postgres)
├── Financial records — the ONLY system of record
│   ├── registers / register_sessions / register_transactions
│   ├── sale_payments, sale_refunds, expense_payments
│   └── hardware_commands (audit trail — never financial)
├── AuthZ/RBAC, multi-tenancy (X-Business-Id / X-Location-Id, server-verified)
├── Terminal registry + pairing + targeted command relay
│        ▲ HTTPS claim/ack (outbound from bridge)      ▲ HTTPS (POS UI)
└────────┼────────────────────────────────────────────┘
         │
ezPos Hardware Bridge (Windows, Node 22)
└── outbound-only client — no local listener, no local API
    ├── claim pending drawer commands (atomic, delivered once)
    ├── ESC/POS drawer kick via raw TCP 9100 or Windows spooler RAW
    └── ack completed / failed / unknown_outcome (honest outcomes)

React POS (pos/)
├── /register workstation (open, movements, count, close, ledger)
├── /settings/hardware (terminal registry, pairing, printer mode)
└── drawer flow: backend command first, WebUSB fallback, browser last
```

### Deviation from the original proposal

The master prompt suggested a local HTTP bridge API (`GET /health`,
`POST /devices/:id/open-drawer`). The implemented design makes the bridge an
**outbound-only client**: the browser only ever talks to the backend, which
relays commands to the bridge's poll channel. This removes the entire
localhost attack surface (CORS abuse, DNS rebinding, CSRF against local
APIs, Chrome Local-Network-Access friction) by removing the attack target.

## 2. Responsibilities

| Concern | Owner |
|---|---|
| Financial records, cash math, session state | Backend (exclusively) |
| Authorization (user permissions, terminal identity, location binding) | Backend |
| Audit trail (sessions, movements, terminal lifecycle, commands) | Backend (`audit_log`) |
| Physical drawer kick | Bridge (through printers) |
| Reporting physical state | Nobody (see KNOWN_LIMITATIONS — drawers have no universal sensor) |
| UX (forms, toasts, status polling) | React POS |

## 3. Command lifecycle (drawer open)

1. **Authorize** — `POST /api/hardware/commands`: sale-linked kicks need
   `cash_drawer.open`; no-sale kicks need `cash_drawer.open_without_sale`;
   the terminal must be paired, active, and in the caller's location; a
   sale-linked command must target the sale's own location. Per-user rate
   limit (30/min). TTL 15 s (clamped 5–60 s).
2. **Deliver** — bridge claims pending commands; the claim atomically marks
   them `received` so a command is delivered exactly once.
3. **Execute** — bridge acks `validated` → `executing`, fires `ESC p m t1 t2`
   (parameters clamped 2–510 ms; pin 2 or 5).
4. **Settle** —
   - bytes delivered → `completed` (detail records *"no open-sensor feedback"*);
   - failure before any bytes left the machine → `failed` (cashier may
     deliberately retry);
   - anything ambiguous → `unknown_outcome`.
   Settled commands are immutable; a swept limbo command may still receive
   its true late outcome from the bridge. **Never auto-retried.**
5. **Observe** — POS polls `GET /api/hardware/commands/:id` (poll also
   sweeps expiry) and reports to the cashier.

Terminal states (backend-enforced one-way machine):
`pending → received → validated → executing → completed | failed | unknown_outcome`,
with `expired` set server-side for unclaimed commands.

## 4. Cash accounting model

Movement types on `register_transactions` (amount always ≥ 0; the type
carries the sign):

| Type | Drawer effect | Source record | Written by |
|---|---|---|---|
| `sale` | + (net cash portion after change) | sale | sale path, transactional |
| `cash_in` | + | manual or `sale_payment` (due collection) | UI / due-management |
| `cash_out` | − | manual or `expense_payment` | UI / expenses |
| `cash_refund` | − | `sale_refund` (counter payout) | refund path, transactional |
| `safe_deposit` | − | manual (drop to safe) | UI |
| `safe_withdrawal` | + | manual (safe → drawer) | UI |
| `adjustment_in` / `adjustment_out` | ± | manual (count corrections) | UI |

Expected cash = opening float + sales + cash in + safe withdrawals +
adjustments in − cash out − cash refunds − safe deposits − adjustments out.
Idempotency: partial unique index `(business_id, reference_type,
reference_id)` — one drawer movement per source financial record; manual
movements are exempt.

Full formulas and edge cases: [CASH_CALCULATIONS.md](CASH_CALCULATIONS.md).

## 5. Multi-tenancy & authorization

- Every request resolves `businessId` from the `X-Business-Id` header against
  server-side membership, and `locationId` from `X-Location-Id` (or the
  business default) against active location + user assignment.
- Tables follow the composite-FK tenant chain (child → parent → business);
  foreign entities are 404-masked, never 403-revealed.
- Terminals authenticate with their own secret (`requireTerminalAuth`,
  constant-time compare, per-request re-read → instant revocation); a
  terminal's authority extends only to its own commands.
- New permission families: `cash_register.*`, `cash_movement.create`,
  `cash_drawer.open(.open_without_sale)`, `pos_terminal.view/manage` — see
  [PERMISSIONS.md](PERMISSIONS.md).

## 6. Implementation map

| Area | Files |
|---|---|
| Register/session engine | `ezPosBackend/src/modules/cashRegisters/` |
| Drawer movement schema | `ezPosBackend/src/db/schema/registers.ts` (+ migration 0042) |
| Terminal/command schema | `ezPosBackend/src/db/schema/posTerminals.ts` (+ migration 0043) |
| Terminal management + relay | `ezPosBackend/src/modules/hardware/` |
| Terminal auth | `ezPosBackend/src/middleware/terminalAuth.ts` |
| Refund/due integration | `src/modules/sales/sales.service.ts`, `src/modules/dueManagement/` |
| Z-report | `GET /api/reports/financial/register-close` |
| POS register UI | `pos/src/features/cashRegisters/RegisterPage.tsx` (+ header dialog) |
| POS hardware UI | `pos/src/features/hardware/` |
| Windows bridge | `ezPosHardwareBridge/` (see its README) |
| E2E chain check | `ezPosHardwareBridge/scripts/e2e-check.mts` (`npm run e2e`) |
