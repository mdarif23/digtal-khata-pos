# Automated test report — cash management & hardware program

All runs executed locally on 2026-11-05 against migration set 0001–0043
(database `ezpos_test`), Node 22.23.4. Reproduce with the commands shown.

## Backend (ezPosBackend) — 531 pass / 0 fail / 1 skipped

`DATABASE_URL=postgresql://…ezpos_test INTEGRATION_TESTS=1 AUTH_RATE_LIMIT_MAX=10000 npm test`

- 84 suites, 532 tests (1 skip = the fail-closed integration guard when
  `INTEGRATION_TESTS` is absent).
- Includes the program's new suites:
  - `cashManagement.integration.test.ts` (8): counter cash refunds post
    `cash_refund`; provider/store-credit refunds never touch drawer cash;
    exchange surplus vs collected difference math; safe deposit/withdrawal +
    adjustments; cash due collections vs card; DB-level idempotency
    (duplicate source reference → 23505); close variance.
  - `terminals.integration.test.ts` (10): pairing single-use + invalid codes,
    terminal-secret auth (incl. swapped ids), cashier permission split
    (list yes, pairing-code no, history no), cross-business isolation, full
    command lifecycle + immutability, expiry sweep, late true outcome on a
    swept limbo command, secret rotation, deactivation lockout, delete guard.
  - `reportingConsistency.integration.test.ts` — expected cash matches the
    transaction ledger end-to-end (1000 + 780 − 280 refunds + 100 = 1600);
    Z-report row parity.
  - Pre-existing suites (sales, refunds, exchanges, expenses, due
    management, isolation, RBAC, …) all green — no regressions.

## Windows bridge (ezPosHardwareBridge) — 21 pass / 0 fail

`npm run typecheck && npm test`

- ESC/POS builders: exact `1B 70 m t1 t2` bytes, defaults, 2–510 ms clamps,
  DLE EOT status query.
- Config/credentials store: round-trip, invalid-printer rejection (rawTcp
  without host, spooler without printerName), secret redaction, pairing-code
  alphabet validation.
- Command loop (against a mock backend): full lifecycle
  validated→executing→completed; unsupported type → failed without
  execution; pre-send failure → `failed`; post-send ambiguity →
  `unknown_outcome`; a real refused TCP connection classified as `failed`;
  claim-once semantics; 401 → AuthError; stop predicate.

## End-to-end chain check — ALL GREEN

`DATABASE_URL=… npm run e2e` (`scripts/e2e-check.mts`)

Real backend + real bridge client + real command loop + mock printer TCP
socket, asserting every hop:
pairing code → bridge pair (secret shown once) → POS drawer command
authorized → bridge claim/execute → printer received exactly
`1b 70 00 19 fa` → POS poll shows `completed` with the no-sensor caveat →
audit rows (`hardware.command_created`, `hardware.command_completed`,
`pos_terminal.paired`) → forged bridge secret rejected (401).

## Web POS (pos) — 125 pass / 0 fail (unit) + build OK

`npm test && npm run build`

- 125 vitest unit tests pass. The 3 "failed" *files* are Playwright E2E
  specs collected by vitest — the pre-existing repository issue (fix sits on
  the `feature/testing` branch per the testing program; unrelated to this
  program).
- Production build succeeds.
- Frontend typecheck: zero net-new errors versus the pre-change baseline
  (measured by error-list diff; the codebase has ~75 pre-existing strictness
  errors, unchanged).

## Not covered by automation (physical, documented)

- Physical drawer kick through real printers (see bridge README checklist
  and DEPLOYMENT.md go-live verification).
- The koffi/winspool binding on a real Windows machine (raw TCP path is
  exercised by the E2E check).
- Drawer-open sensing (requires drawers with monitor switches).
