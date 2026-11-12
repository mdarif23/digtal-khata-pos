// ============================================================================
// PLATFORM-ADMIN BOOTSTRAP (promote a registered user to SaaS admin)
// ============================================================================
// There is no self-service path to platform_admin — the role only exists as a
// DB column (users.platform_role). This script is the supported way to create
// the first SaaS admin on a fresh install:
//
//   npm run admin:promote -- you@example.com        promote
//   npm run admin:promote -- you@example.com --revoke  demote back to none
//
// The user must already exist (register through the website first). Takes
// effect immediately — requireAuth re-reads the user on every request.
// ============================================================================
import "dotenv/config";
import { pool } from "../src/config/db.js";

function fail(message: string): never {
  console.error(message);
  void pool.end();
  process.exit(1);
}

const args = process.argv.slice(2).map((a) => a.toLowerCase());
const revoke = args.includes("--revoke");
const email = args.find((a) => a.includes("@"));

if (!email) {
  fail(
    "Usage: npm run admin:promote -- <email> [--revoke]\n" +
      "The email must belong to an existing user (register via the website first).",
  );
}

const role = revoke ? "none" : "platform_admin";

const updated = await pool.query(
  `UPDATE users SET platform_role = $1 WHERE lower(email) = $2 RETURNING id, email, full_name, platform_role`,
  [role, email],
);

if (updated.rowCount === 0) {
  fail(
    `No user found with email "${email}". Register that account via the website first, then run this again.`,
  );
}

const user = updated.rows[0];
console.log(
  revoke
    ? `Revoked platform admin: ${user.email} (platform_role = none)`
    : `Promoted ${user.email} to platform admin. Sign in at /saas-admin to open the SaaS admin panel.`,
);
await pool.end();
