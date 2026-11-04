# Known limitations

Honest boundaries of the implemented cash-management & hardware system.

## Physical hardware

1. **Drawer-open sensing is not claimed.** Most drawers have no monitor
   switch; where one exists it is only readable on bidirectional transports.
   The bridge reports what it *knows*: bytes delivered (`completed`),
   nothing sent (`failed`), or ambiguity (`unknown_outcome`) — never "the
   drawer is physically open".
2. **Windows spooler binding is unverified on physical hardware.** The
   koffi/winspool implementation follows the documented API but was built
   without a Windows printer attached. Run `doctor` / `doctor --test-tcp`
   on the target machine before go-live. Raw TCP 9100 is the primary,
   best-tested transport.
3. **The hardware compatibility matrix is expectation-based** (vendor
   command documentation), not a test lab result. Epson TM-series is the
   reference implementation; clones may wire the solenoid to pin 5 — try
   both pins. Bluetooth printers are unsupported by design.
4. **One drawer per bridge.** The first printer in the bridge config is the
   drawer; multi-drawer counters need one bridge terminal per drawer.

## Accounting model

5. **Movements only post to OPEN sessions.** An actor without an open
   session at the relevant location makes no drawer movement (consistent
   cash-sale behavior since the original design). Businesses should require
   open sessions before processing cash-affecting workflows at a counter.
6. **Refunds on partially-due sales** post the full cash refund the
   business declares; the paper due reduction happens first, but the drawer
   cannot know how much of a mixed-payment sale originally came in cash —
   the business chooses the refund method truthfully.
7. **Purchases are not register-scoped.** Supplier payments (even cash)
   never touch drawer expected cash; they are business-level records.
8. **Legacy register endpoints keep their original gates** (settings/full
   access). The new `cash_register.*` / `cash_movement.create` keys are
   seeded and enforced on NEW surfaces (commands, terminals) but not yet
   retro-gated onto the legacy register routes — planned once role management
   UI covers them (see PERMISSIONS.md).

## Platform

9. **Rate limits and realtime are in-memory, single-instance** (existing
   platform-wide stance). Horizontal scaling needs shared stores.
10. **Command TTL is short by design (15 s).** A bridge that is offline for
    a minute misses kicks; the cashier sees `expired`/`unknown_outcome` and
    can retry explicitly. Offline drawer opening does not queue.
11. **Bridge ↔ backend is pull-based (≈2 s poll).** Drawer opens have up to
    one poll interval of latency; a push channel (WebSocket) is a possible
    future upgrade.
12. **ESC/POS printing of Bengali receipts degrades to `?`** — Bengali
    receipts stay on the browser-print path (pre-existing behavior,
    unchanged by this program).
13. **`register_transactions` manual movements carry no client idempotency
    key** — double-tapping the movement button could double-post. The UI
    disables the button while in flight; a client-generated key is a cheap
    future hardening.
14. **No X-report document.** The live `GET /api/sessions/current` and the
    session detail ledger serve as the intra-shift view; a printable X slip
    was deferred.
