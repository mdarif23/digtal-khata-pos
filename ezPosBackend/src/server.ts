// Imported for its startup-validation side effects: fails fast with a clear
// message when required configuration (e.g. AUTH_JWT_SECRET) is missing.
import "./config/env.js";
import { buildApp } from "./app.js";
import { pool } from "./config/db.js";
import { ensureRbacSeed } from "./rbac/seed.js";
import { startScheduler, stopScheduler } from "./jobs/scheduler.js";
import {
  isSyncEnabled,
  startSyncAgent,
  stopSyncAgent,
} from "./sync/sync.agent.js";

const app = buildApp();

// Seeds the permission catalog (idempotent) so role creation can reference
// permission rows at any time. Failures are logged; the server still starts.
ensureRbacSeed().catch((err) => {
  console.error("RBAC permission seed failed:", err);
});

// Subscription lifecycle sweeps (trial expiry, reminders, grace suspension)
// on a fixed interval — disabled with JOBS_ENABLED=false.
startScheduler();

// LAN sync agent (Phase 2): only runs when EZPOS_SYNC_ENABLED=true with a
// cloud URL + sync-agent terminal credential configured (never on cloud).
if (isSyncEnabled()) {
  console.log("LAN sync agent enabled — syncing with the cloud backend.");
  startSyncAgent();
}

// Configurable for local development so the website (3001), POS frontend,
// and a second backend instance can run alongside the default port.
const PORT = Number(process.env.PORT) || 3000;

// Number of trusted reverse-proxy hops in front of this server. Requests'
// client IPs (used by the rate limiter) are derived from X-Forwarded-For
// only up to this hop count — set to 1 behind nginx/a load balancer, leave
// unset when the server is exposed directly.
const TRUST_PROXY = Number(process.env.TRUST_PROXY);
if (Number.isInteger(TRUST_PROXY) && TRUST_PROXY > 0) {
  app.set("trust proxy", TRUST_PROXY);
}

const server = app.listen(PORT, () =>
  console.log(`server is running on PORT ${PORT}`),
);

// Graceful shutdown: stop accepting connections, let in-flight requests (and
// their database transactions) finish, then close the connection pool.
async function shutdown(signal: string) {
  console.log(`${signal} received — shutting down gracefully.`);
  stopScheduler();
  stopSyncAgent();
  server.close(async () => {
    try {
      await pool.end();
      process.exit(0);
    } catch (err) {
      console.error("Error while closing the database pool:", err);
      process.exit(1);
    }
  });
  // Failsafe: do not hang forever if a connection refuses to drain.
  setTimeout(() => {
    console.error("Timed out waiting for connections to drain — forcing exit.");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
