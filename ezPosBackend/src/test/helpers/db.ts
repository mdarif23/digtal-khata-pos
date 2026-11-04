import { Client } from "pg";

/**
 * Shared integration-suite database connection with the same fail-closed
 * guard every suite enforces: tests may only ever touch `ezpos_test`.
 */
export async function connectTestDb(): Promise<Client> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query("SELECT current_database() AS db");
  if (rows[0]?.db !== "ezpos_test") {
    await client.end();
    throw new Error(
      `SAFETY ABORT: connected to "${rows[0]?.db}" — integration tests may only run against ezpos_test.`,
    );
  }
  return client;
}
