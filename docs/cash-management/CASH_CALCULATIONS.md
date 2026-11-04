# Cash calculations — authoritative reference

Money conventions: Postgres `numeric(10,2)`; application math rounds via
`roundMoney` (2 dp half-up-ish via EPSILON bump); payment validation uses
integer cents (`toPoisha`) to avoid float drift. Never store non-cash
methods as drawer cash.

## Expected drawer cash

```
expected = opening_cash
         + Σ(type = sale)              -- net cash retained, change already deducted
         + Σ(type = cash_in)
         + Σ(type = safe_withdrawal)
         + Σ(type = adjustment_in)
         - Σ(type = cash_out)
         - Σ(type = cash_refund)
         - Σ(type = safe_deposit)
         - Σ(type = adjustment_out)
```

Implementation: `computeExpectedCash` in
`ezPosBackend/src/modules/cashRegisters/cashRegisters.service.ts` — a single
SQL SUM over the session's ledger with a direction CASE. The same rule is
duplicated *deliberately* in the Z-report SQL (open-session live expected)
and both are covered by the reporting-consistency test.

## Movement → source-record mapping

| Source | Movement | When |
|---|---|---|
| Sale with cash payment(s) | `sale` + Σ cash payment amounts | in the sale transaction (`recordCashSaleInTx`); net of change because only the payment amount posts and `tendered` carries the rest |
| Sale without cash (card/QR/gift/credit/due) | none | never counted as drawer cash |
| Exchange, replacement more expensive | `sale` on the collected difference | via the replacement sale's cash payments |
| Exchange, replacement cheaper (cash surplus) | `cash_refund` of the surplus only | the returned value nets against the replacement and is NOT a cash movement |
| Refund `refundMethod: cash` (or unspecified — defaults to cash) | `cash_refund` of refundTotal | in the refund transaction (`recordCashRefundInTx`) |
| Refund `original_payment` | none | gateway payout, not drawer cash |
| Refund `store_credit` | none | becomes customer credit |
| Expense paid `Cash` | `cash_out` ref `expense_payment` | on create/settle; void deletes the movement (reversal, not erasure) |
| Expense paid `Mobile`/`Card`/unpaid | none | |
| Due collection `cash` | `cash_in` ref `sale_payment` | same transaction as the payment row |
| Due collection `card`/`bangla_qr` | none | |
| Supplier/purchase payments | none (out of scope) | purchases are not location/session-scoped |
| Drawer-open hardware command | none | hardware events are audit, never money |

All of the above are **no-ops when the actor has no open session at the
sale's/refund's location** — the drawer ledger only tracks movements made
during an open shift (consistent with the original cash-sale design).

## Split payments & change

A sale's cash portion = Σ `sale_payments.amount` where method = cash.
`sale_payments.tendered` records what the customer handed over; change =
`tendered − amount` and never enters the drawer. Split (cash + QR + due)
posts only the cash slice.

## Idempotency & integrity

- One open session per register and per user — enforced by partial unique
  indexes (DB-level, race-proof).
- One drawer movement per source record — partial unique
  `(business_id, reference_type, reference_id)` (manual movements exempt).
- Duplicate gateway references rejected at `sale_payments` level
  (translated to 409).
- Sales idempotency key + exchange replay path; expense `client_uuid`.
- Session close recomputes expected from the ledger (never trusts a cached
  value), stores expected/counted/difference; |difference| > 0.01 triggers a
  discrepancy notification.
- Failed sales create no movements (sale insert and payments are one
  transaction); hardware failures never roll back a committed sale (drawer
  commands are post-commit, audit-only).

## Rounding rules

- All stored amounts: 2 dp.
- Refund allocation: cart-level delta (VAT − discount) distributed pro rata
  over line totals; per-refund cap = remaining un-refunded sale value.
- Due refunds reduce `due_amount` first (paper), drawer cash follows the
  refund method the business actually used.
