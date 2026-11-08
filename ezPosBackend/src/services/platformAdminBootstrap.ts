// Startup platform-admin bootstrap: when PLATFORM_ADMIN_EMAIL is configured
// and that user exists with platform_role 'none', promote them to
// platform_admin. This gives fresh installs a declarative way to create the
// first SaaS admin (npm run admin:promote handles the imperative path).
// Failures are logged; the server still starts.
import { and, eq } from "drizzle-orm";
import { db } from "../db/schema/index.js";
import { users } from "../db/schema/users.js";
import { env } from "../config/env.js";

export async function bootstrapPlatformAdmin(): Promise<void> {
  if (!env.platformAdminEmail) return;
  const updated = await db
    .update(users)
    .set({ platformRole: "platform_admin" })
    .where(
      and(
        eq(users.email, env.platformAdminEmail),
        eq(users.platformRole, "none"),
      ),
    )
    .returning({ email: users.email });
  if (updated.length > 0) {
    const promoted = updated[0];
    if (promoted) {
      console.log(
        `PLATFORM_ADMIN_EMAIL: promoted ${promoted.email} to platform admin.`,
      );
    }
  }
}
