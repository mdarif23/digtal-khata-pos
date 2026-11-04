# ezPos Hardware Bridge

A small local service that runs on the **Windows POS terminal** and opens
cash drawers for ezPos. It pairs with the ezPos backend using a one-time
code, polls for authorized drawer commands, fires the ESC/POS drawer-kick
pulse through a receipt printer, and reports the outcome back.

## Architecture

```
ezPos Backend  ◄──── outbound HTTPS ────►  this bridge  ──►  receipt printer  ──►  cash drawer (RJ11)
  (authorizes,      claim / ack loop         (executes          ESC p m t1 t2      24 V pulse on
   audits, relays)                           kick bytes)                          pin 2 or 5
```

**The bridge is outbound-only.** It never listens on a port. The web POS
never talks to it directly — it asks the backend, which relays. That removes
the whole localhost attack surface (CORS abuse, DNS rebinding, CSRF on local
APIs, Chrome Local-Network-Access prompts) by design: there is no local API.

**The bridge is never the financial system of record.** It moves no money
and stores no business data beyond its own identity. Drawer-open events are
audit records in the backend, not ledger entries.

## Requirements

- Windows 10/11 (any edition) — or Linux for development (raw TCP only)
- Node.js 22 LTS
- Network access to the ezPos backend (outbound HTTPS)

## Install

```powershell
# on the Windows terminal
npm install          # optionalDependencies pull koffi (winspool FFI) on Windows
```

## Pair (once per terminal)

1. In ezPos: **Hardware → Pair a terminal** → a one-time code (10 minutes).
2. On the Windows machine:

```powershell
npm run pair -- --backend https://api.your-ezpos.com --name "Front Counter"
# paste the 8-character code when prompted
```

The bridge receives its secret **directly from the backend** — it is stored
hashed server-side and is never displayed again in ezPos. Local state lives
in `%USERPROFILE%\.ezpos-bridge\` (override with `EZPOS_BRIDGE_DATA_DIR`):
`credentials.json` (0600) and `config.json`.

## Configure a printer

Edit `~\.ezpos-bridge\config.json`:

```json
{
  "backendUrl": "https://api.your-ezpos.com",
  "pollIntervalMs": 2000,
  "printers": [
    { "kind": "rawTcp",  "name": "Counter thermal", "host": "192.168.1.50", "port": 9100, "pin": 2, "onMs": 50, "offMs": 500 },
    { "kind": "spooler", "name": "USB thermal",     "printerName": "POS-80",         "pin": 2, "onMs": 50, "offMs": 500 }
  ]
}
```

- `rawTcp` — network printers; the kick bytes go straight to TCP 9100. Most
  reliable transport; use this when the printer is on the network.
- `spooler` — USB printers via the Windows print spooler (RAW job). The
  exact `printerName` is the one Windows shows; `doctor` lists them.
- `pin` — drawer connector pin **2** (drawer 1) or **5** (drawer 2). Some
  clones wire the solenoid to pin 5 — try the other pin if nothing happens.
- `onMs`/`offMs` — pulse times, clamped to 2–510 ms on the wire (2 ms units).

The **first** printer in the list is the drawer (a drawer is one device).

## Run

```powershell
npm run doctor          # config, credentials, backend auth, adapters
npm start               # claim + execute loop (Ctrl+C to stop)
npm run doctor -- --test-tcp   # one deliberate kick through the printer
```

### Run as a Windows service

The bridge is a plain long-running console process. Either:

- **Task Scheduler** (no extra software): create a task, "Start a program",
  `node.exe`, arguments `<bridge path>\dist\index.js run` (after `npm run
  build`), trigger "At startup", run under the POS user account, restart on
  failure; or
- **NSSM**: `nssm install ezpos-bridge "C:\Program Files\nodejs\node.exe" "<bridge>\dist\index.js run"`.

## How commands flow

1. A cashier's POS (or an automatic post-cash-sale rule) asks the backend to
   open the drawer. The backend **authorizes** the request (permissions
   `cash_drawer.open` / `cash_drawer.open_without_sale`, terminal in the
   caller's location, sale in the terminal's location), stores a command
   with a short TTL (15 s), and returns its id.
2. This bridge claims pending commands (a command is delivered exactly
   once), acks `validated` → `executing`, fires the kick, and acks
   `completed` / `failed` / `unknown_outcome`.
3. The POS polls the command status and shows the cashier the result.

**Outcome honesty** (no drawer sensor is assumed — most drawers have none):

- TCP connect refused / printer missing → `failed` (nothing was sent; the
  cashier may deliberately retry).
- Bytes handed to the socket or spooler → `completed`, with the detail
  *"no open-sensor feedback"* — the printer accepted the job; whether the
  coil physically fired cannot be sensed through this transport.
- Anything ambiguous → `unknown_outcome`.

**Never retried automatically.** A drawer kick that may already have fired
is never repeated by the bridge; a new kick is a new, explicit,
user-visible command.

## Hardware compatibility (expected — verify on your device)

| Printer family | Connection | Drawer kick | Status sensing |
|---|---|---|---|
| Epson TM-T88/TM-T20/TM-M30 | USB / Ethernet | ✅ reference implementation | ✅ if drawer has monitor switch (pin 3) |
| Star TSP100 / SP700 (ESC/POS mode) | USB / Ethernet | ✅ | partial |
| Xprinter XP-N/58/80 series | USB / Ethernet | ✅ (verify pin 2 vs 5) | usually |
| Rongta RP326/332/336 | USB / Ethernet | ✅ | usually |
| Gprinter / Zjiang clones | USB (BT unsupported) | ✅ mostly (test both pins) | unreliable |
| Native-serial drawers (APG) | COM | not implemented yet | — |

This matrix is compiled from vendor command documentation, not from physical
testing — **run `doctor --test-tcp` on your actual device before go-live**.
Bluetooth printers are deliberately unsupported (unreliable on Windows).

## Security model

- **Outbound-only client** — no local HTTP listener, no local API to attack.
- Terminal secret: 48 hex chars from the backend, stored locally in a 0600
  file, hashed (SHA-256) server-side, rotated from ezPos, revoked
  immediately on terminal deactivation/deletion (per-request re-read).
- Commands: authorized server-side per request; the bridge executes only
  what the backend delivers, only through fixed, validated ESC/POS builders
  (never arbitrary bytes), and reports outcome truthfully.
- Logs: secrets are never logged (redacted to prefix + last 4).

## Development & testing

```bash
npm run typecheck
npm test            # 21 tests: ESC/POS bytes, config store, command loop
```

Hardware-dependent tests run against **mock adapters**; the loop tests use a
mock backend implementing the claim/ack state machine. One test exercises a
real refused TCP connection to pin down the `failed` vs `unknown_outcome`
split. The koffi/winspool binding is **implemented but unverified** on
physical Windows hardware — verify with `doctor` before relying on it.

Physical verification checklist (document for your deployment):

1. `doctor` shows backend OK and the configured printer.
2. `doctor --test-tcp` opens the drawer.
3. A cash sale in ezPos opens the drawer automatically (terminal chosen in
   Hardware settings).
4. Deactivating the terminal in ezPos locks the bridge out within one poll.
5. Rotating the secret locks out the old credentials immediately.
