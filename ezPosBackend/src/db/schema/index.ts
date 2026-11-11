import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Pin the session timezone to UTC: raw report/finance SQL compares UTC
  // wall-clock strings via ::timestamp, which Postgres interprets in the
  // SESSION timezone. Without this, a host that inherits Asia/Dhaka shifts
  // every report window 6h and evening sales vanish from all reports.
  options: "-c timezone=UTC",
});

export const db = drizzle(pool);