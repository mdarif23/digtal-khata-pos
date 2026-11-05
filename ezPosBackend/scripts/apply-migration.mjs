#!/usr/bin/env node
/**
 * Manual migration applier — the reliable path on this repo.
 *
 * `drizzle-kit migrate` has a silent no-op failure mode here (bookkeeping row
 * written, DDL never executed — hit on 0037 and 0039). This script applies a
 * migration file statement-by-statement (tolerating "already exists" errors),
 * then appends the drizzle bookkeeping row so the migrator stays in sync.
 *
 * Usage:
 *   node scripts/apply-migration.mjs <migration-file.sql> [--both]
 *
 *   default : applies to the DATABASE_URL database (dev DB from .env)
 *   --both  : also applies to ezpos_test (dev URL with /ezpos_test)
 *
 * Reads DATABASE_URL from ezPosBackend/.env — never prints credentials.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";

const [migPath, flag] = process.argv.slice(2);
if (!migPath) {
  console.error("Usage: node scripts/apply-migration.mjs <migration-file.sql> [--both]");
  process.exit(1);
}

const raw = readFileSync(migPath, "utf8");
const hash = createHash("sha256").update(raw).digest("hex");

// Journal-derived bookkeeping timestamp: the migrator orders by its own
// count, but keep the `when` monotonic with the journal.
const journal = JSON.parse(
  readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
);
const entry = journal.entries.find((e) => migPath.endsWith(`${e.tag}.sql`));
if (!entry) {
  console.error(
    `Migration ${migPath} has no journal entry — append it to drizzle/meta/_journal.json first.`,
  );
  process.exit(1);
}
const WHEN = String(entry.when);
const expectedCount = entry.idx + 1; // bookkeeping rows that must exist BEFORE applying

// Split preferring drizzle's `--> statement-breakpoint` markers when the
// file uses them — semicolon-splitting shreds plpgsql bodies ($$ blocks
// contain semicolons; hit on 0050). Legacy fallback: strip -- comment lines
// first (comments may contain ';'), then split on ';'.
const hasMarkers = raw.includes("--> statement-breakpoint");
const statements = hasMarkers
  ? raw
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean)
  : raw
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);

const TOLERATED = new Set(["42P07", "42710", "42701", "42723", "23505", "42P16"]);

async function apply(url, label) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const db = (await client.query("SELECT current_database() AS d")).rows[0].d;
  const applied = (
    await client.query("SELECT COUNT(*)::int AS n FROM drizzle.__drizzle_migrations")
  ).rows[0].n;
  if (applied >= expectedCount) {
    console.log(
      `--- ${label} (${db}): bookkeeping already at ${applied} (need < ${expectedCount}) — nothing to do`,
    );
    await client.end();
    return;
  }
  if (applied !== expectedCount - 1) {
    throw new Error(
      `${label}: bookkeeping at ${applied}, expected ${expectedCount - 1} — out of order migration?`,
    );
  }
  console.log(`--- ${label} (${db}): running ${statements.length} statements`);
  let ok = 0;
  let skipped = 0;
  for (const stmt of statements) {
    const head = stmt.replace(/\s+/g, " ").slice(0, 60);
    try {
      await client.query(stmt);
      ok++;
    } catch (err) {
      if (TOLERATED.has(err.code)) {
        skipped++;
        console.log(`  SKIP [${err.code}] ${head}`);
      } else {
        console.error(`  FAIL [${err.code}] ${head}\n  ${err.message.split("\n")[0]}`);
        throw err;
      }
    }
  }
  console.log(`  applied=${ok} skipped=${skipped}`);
  const cols = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='__drizzle_migrations' AND table_schema='drizzle' ORDER BY ordinal_position",
  );
  const shape = cols.rows.map((r) => r.column_name).join(",");
  if (shape !== "id,hash,created_at") {
    throw new Error(`Unexpected bookkeeping shape: ${shape}`);
  }
  await client.query(
    "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
    [hash, WHEN],
  );
  const newCount = (
    await client.query("SELECT COUNT(*)::int AS n FROM drizzle.__drizzle_migrations")
  ).rows[0].n;
  console.log(`  bookkeeping now=${newCount}`);
  await client.end();
}

const envFile = readFileSync(new URL("../.env", import.meta.url), "utf8");
const line = envFile.split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
if (!line) throw new Error("DATABASE_URL not found in .env");
const devUrl = line.slice("DATABASE_URL=".length).trim().replace(/^['"]|['"]$/g, "");

await apply(devUrl, "DEV");
if (flag === "--both") {
  const testUrl = new URL(devUrl);
  testUrl.pathname = "/ezpos_test";
  await apply(testUrl.href, "TEST");
}
console.log("DONE");
