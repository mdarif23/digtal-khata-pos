# Cash register user guide (cashiers & managers)

## Start of shift — open the drawer

1. On the POS screen, tap **Register** (header) or open **Register** in the
   sidebar.
2. If you have no open session: choose your register, enter the **opening
   cash** (counted float), and tap **Open register**.
3. Only one session can be open per register and per cashier — if a drawer
   is already open you'll see who has it.

## During the shift

- **Cash sales** land in your drawer automatically (the net cash after
  change). Card, QR, gift-card and credit payments never touch the drawer.
- **Cash refunds** (counter payouts) are deducted from your drawer
  automatically when the refund is paid in cash. "Original payment" and
  "store credit" refunds don't touch the drawer.
- **Cash in / Cash out / Safe / Adjustments** — use the Cash movement row
  (POS header dialog) or the Register page:
  - *Cash in* — change fund top-ups and cash collected on customer dues.
  - *Cash out* — petty cash, paid-out expenses (cash expenses deduct
    automatically too).
  - *Safe deposit* — move cash from the drawer into the safe.
  - *Safe withdrawal* — bring cash from the safe into the drawer.
  - *Adjustment + / −* — count corrections; always add a note.
  Every movement needs an amount; notes are strongly recommended (they show
  in the session ledger and Z-report).

## Open the physical drawer

- **Automatically** after every cash sale (default; toggle in Hardware
  settings).
- **Manually** — Hardware settings → *Kick drawer*. Without an attached
  sale this needs the `cash_drawer.open_without_sale` permission.
- The drawer opens through your paired terminal / receipt printer. If the
  kick fails you'll get a message — the **sale is already safe**; fix the
  printer and retry deliberately.

## End of shift — close and reconcile

1. Register page → **Close register** section shows the **expected** drawer
   cash (opening + sales + cash in + safe withdrawals + adjustments − cash
   out − refunds − safe deposits).
2. Count the physical drawer, enter the **counted** amount, check the
   difference preview, then **Close register**.
3. A short/over difference is stored on the session; the owner/manager gets
   a discrepancy notification for any variance over ৳0.01.
4. The **Z-report** (Reports → Shift & Cash Drawer Close) prints the full
   ledger: per-shift opening, cash sales, refunds, cash in/out, safe
   movements, expected vs counted, and the over/short.

## Managers — hardware

- **Hardware** (sidebar): pair a Windows terminal with a one-time code,
  rename/activate/deactivate terminals, rotate a bridge secret (shown once),
  delete a terminal (only when it has no command history).
- Pick which terminal's drawer this counter uses via "Use as this counter"
  (or the Drawer terminal selector inside the POS hardware panel).
- Register management (create/rename registers) sits with the existing
  settings permissions.

## Recoveries

- **Wrong session open?** Close it (count honestly) and open the right one.
- **Bridge lost its secret?** Rotate it in Hardware settings and paste the
  new secret into the bridge, or re-pair with a fresh code.
- **Terminal replaced?** Deactivate the old one, pair a new one.
- **Drawer short?** Investigate the session ledger (Register page) and the
  Z-report — every movement is traceable to the user and the source record
  (sale, refund, expense payment, due collection).
