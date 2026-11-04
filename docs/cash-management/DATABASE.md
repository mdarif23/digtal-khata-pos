# Database documentation — cash management & terminals

All tables are business-scoped. The tenant pattern is a composite
`unique(id, business_id)` candidate key plus composite FKs chaining child →
parent → business, so a child row cannot point at another business's parent.
Foreign entities are 404-masked in queries.

## Cash domain (migration 0005 base, extended by 0042)

### `registers`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| business_id | FK businesses | |
| location_id | int, composite FK (location_id, business_id) → locations | drawer belongs to one location |
| name | varchar(100) | `unique(location_id, name)` |
| status | `register_status`: active / inactive | deactivation blocked while a session is open |

### `register_sessions`
| Column | Type | Notes |
|---|---|---|
| id, business_id, register_id, user_id | | user FK `ON DELETE RESTRICT` (cash history outlives users) |
| status | `register_session_status`: open / closed | |
| opening_cash / expected_cash / counted_cash / difference | numeric(10,2) | expected/counted/difference set at close |
| opened_at / closed_at | timestamptz | |

Integrity (the core of the subsystem):
- partial unique `register_sessions_one_open_per_register` ON `(register_id) WHERE status='open'`
- partial unique `register_sessions_one_open_per_user` ON `(user_id, business_id) WHERE status='open'`

### `register_transactions` (the drawer ledger)
| Column | Type | Notes |
|---|---|---|
| session_id | composite FK → sessions | |
| user_id | FK users RESTRICT | who moved the cash |
| type | `register_transaction_type` | extended by 0042 |
| amount | numeric(10,2), CHECK ≥ 0 | direction carried by type |
| reference_type / reference_id | varchar(50) / int | `sale`, `sale_refund`, `sale_payment`, `expense_payment`, `manual` |

0042 additions:
- enum values `cash_refund`, `safe_deposit`, `safe_withdrawal`, `adjustment_in`, `adjustment_out`
- **partial unique `register_transactions_reference_uq`** ON
  `(business_id, reference_type, reference_id) WHERE reference_type IS NOT NULL
  AND reference_id IS NOT NULL AND reference_type <> 'manual'` — one drawer
  movement per source financial record (idempotency). If production data
  ever contained duplicates, migration 0042 fails visibly rather than
  deleting history.

## Terminal domain (migration 0043)

### `pos_terminals`
| Column | Type | Notes |
|---|---|---|
| location_id | composite FK → locations | terminals are location-scoped, `unique(location_id, name)` |
| status | `terminal_status`: active / inactive | deactivation locks the bridge out on its next request |
| secret_hash | varchar(64) NULL | SHA-256 of the bridge secret; NULL until paired |
| paired_at, last_seen_at, device_info | | last_seen updated on every authenticated call (heartbeat) |
| created_by | FK users SET NULL | the pos_terminal.manage holder who minted the code |

### `terminal_pairing_codes`
`code_hash` unique (SHA-256 of the one-time code), `expires_at` (10 min),
`used_at` (set by an atomic single-use claim — concurrent redemptions race
on this UPDATE).

### `hardware_commands`
| Column | Type | Notes |
|---|---|---|
| terminal_id | composite FK → pos_terminals | |
| type | `hardware_command_type`: drawer_open | extensible |
| status | `hardware_command_status` | pending/received/validated/executing/completed/failed/expired/unknown_outcome |
| requested_by | FK users SET NULL | who asked |
| sale_id | FK sales SET NULL | sale-linked kicks |
| reason / note / result | | result = adapter detail JSON |
| expires_at | timestamptz | TTL 15 s (clamped 5–60 s); swept server-side |
| claimed_at / settled_at | | |

Indexes: `(terminal_id, status)` for claims, `(business_id, created_at)` for
history. Command rows are audit evidence — a terminal with command history
cannot be deleted, only deactivated.

## Related financial tables (pre-existing, referenced by the drawer ledger)

- `sale_payments` — `payment_method` CHECK cash/bangla_qr/card/store_credit/
  loyalty_points/gift_card/sslcommerz; `tendered` stores cash tendered
  (change is derived: tendered − amount); unique `(business_id, payment_method, reference)`
- `sale_refunds` — `refund_method` cash / original_payment / store_credit
- `expense_payments` — `Cash`/`Mobile`/`Card`; unique `client_uuid`
- `purchase_payments` — pgEnum cash/bank_transfer/cheque/card/other;
  **not** register-scoped (supplier payments are not drawer movements —
  purchases have no location/session)

## Migrations

| Migration | Contents |
|---|---|
| 0005_cash_registers | registers, sessions, transactions |
| 0042_register_cash_management | movement enum extension + reference idempotency index |
| 0043_pos_terminals | terminals, pairing codes, hardware commands |

Apply with `npm run db:migrate` (drizzle-kit) against `DATABASE_URL`.
Rollback: 0042/0043 are additive — dropping the new tables/columns restores
the previous schema; the movement enum extension requires type recreation
(never done in place on production data; forward-only is the supported path).
