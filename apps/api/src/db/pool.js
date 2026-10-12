import pg from "pg";

export function createPool(config) {
  if (!config.DATABASE_URL) return null;
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_MAX, connectionTimeoutMillis: config.DATABASE_POOL_ACQUIRE_TIMEOUT_MS, idleTimeoutMillis: 30000 });
  pool.on("connect", (client) => client.query("SET statement_timeout = '10s'; SET lock_timeout = '2s'; SET idle_in_transaction_session_timeout = '30s';"));
  return pool;
}

export async function databaseReady(pool) {
  if (!pool) return false;
  const client = await pool.connect();
  try { await client.query("SELECT 1"); return true; } finally { client.release(); }
}
