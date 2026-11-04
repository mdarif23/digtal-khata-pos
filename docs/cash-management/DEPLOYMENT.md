# Deployment & update instructions

## 1. Backend (ezPos)

```bash
cd ezPosBackend
npm ci
npm run build          # optional for tsx-based dev start
DATABASE_URL=<prod-url> npm run db:migrate    # applies 0042 + 0043 (additive)
npm run start          # or your process manager (docker-compose exists)
```

- Migrations 0042/0043 are **additive** (enum values, new tables, one
  partial unique index). Existing data is untouched. If the reference
  idempotency index ever collides with duplicate historical rows, migration
  fails loudly — reconcile those rows first (never delete them blindly).
- New permission keys seed themselves at startup (`ensureRbacSeed`).
- Env: no new required variables. `AUTH_JWT_SECRET` etc. unchanged.
- Rollback: forward-only is supported. If you must revert code, the new
  tables can be dropped and the enum reverted only via a type-recreate —
  prefer rolling code forward.

## 2. Web POS (pos)

```bash
cd pos
npm ci
npm run build          # static bundle → your CDN/nginx
```

New routes: `/register`, `/settings/hardware`. No breaking API changes;
existing screens keep working (the drawer kick now prefers terminal relay,
falling back to WebUSB exactly as before).

## 3. Windows hardware bridge (ezPosHardwareBridge)

First install per terminal (details: `ezPosHardwareBridge/README.md`):

```powershell
# Node 22 LTS required
npm install            # includes koffi on Windows
npm run pair -- --backend https://api.your-ezpos.com --name "Front Counter"
# paste the one-time code from ezPos → Hardware → Pair a terminal
notepad %USERPROFILE%\.ezpos-bridge\config.json   # printer config
npm run doctor         # verify backend + adapter
npm start              # or install as a Task Scheduler / NSSM service
```

Update procedure:

```powershell
git pull (or redeploy the bundle)
npm install
npm run build
nssm restart ezpos-bridge      # or restart the scheduled task
npm run doctor                 # post-update check
```

The bridge stores only its identity + printer config in
`%USERPROFILE%\.ezpos-bridge\` — safe to rebuild the machine around it.
Rotating the terminal secret from ezPos immediately revokes any lost copy.

## 4. Recovery procedures

| Situation | Procedure |
|---|---|
| Bridge secret lost / machine replaced | Rotate secret (or delete terminal + re-pair with a new code) |
| Terminal decommissioned | Deactivate in Hardware settings (bridge locks out next poll), delete if no history |
| Drawer discrepancy at close | Session stores expected vs counted; investigate the session ledger; Z-report prints the variance |
| Migration 0042 fails on duplicates | Reconcile duplicate source-attributed rows manually (never delete blindly), re-run migrate |
| Bridge down mid-shift | Kicks report `unknown_outcome`/`expired` in the POS; sales are unaffected; restart the service and retry deliberately |

## 5. Go-live verification checklist (per store)

1. Migrations applied; `ensureRbacSeed` ran (new permissions visible in Roles).
2. Terminal paired; `doctor` all-OK; `doctor --test-tcp` opens the drawer.
3. A cash sale auto-opens the drawer; a card sale does not.
4. Cash refund decreases expected cash; card refund does not.
5. Safe deposit/withdrawal and adjustments reflect in expected cash and the Z-report.
6. Closing with a deliberate ৳10 short triggers the discrepancy notification.
7. Deactivating the terminal locks the bridge out within one poll interval.
