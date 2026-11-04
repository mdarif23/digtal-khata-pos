import { defineConfig } from "@playwright/test";

/**
 * E2E for the POS SPA. Playwright manages BOTH dev servers:
 *  - backend (ezPosBackend) on :3000, pointed at a disposable `ezpos_test`
 *    database (default: a throwaway Postgres on :5433 — never the dev DB);
 *  - frontend (vite) on :5173 talking to that backend.
 * Sessions are seeded by API (register → login → refresh cookie), because
 * the SPA keeps its access token in memory only.
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 45_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run dev -- --strictPort",
      url: "http://localhost:5173",
      cwd: ".",
      env: {
        ...process.env,
        VITE_API_URL: "http://localhost:3000/api",
      },
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: "npm run dev",
      url: "http://localhost:3000/healthz",
      cwd: "../ezPosBackend",
      env: {
        ...process.env,
        DATABASE_URL:
          process.env.E2E_DATABASE_URL ??
          "postgresql://postgres@localhost:5433/ezpos_test",
        AUTH_RATE_LIMIT_MAX: "10000",
        CORS_ORIGINS: "http://localhost:5173",
      },
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
