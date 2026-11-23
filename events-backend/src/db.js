import pg from "pg";
import { sslFor, searchPathMode, SCHEMA } from "./dbconfig.js";

const make = (url) => {
  const p = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX || 10),
    ssl: sslFor(url),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...(searchPathMode() === "startup" ? { options: `-c search_path=${SCHEMA},public` } : {}),
  });
  p.on("error", (e) => console.error("db pool error:", e.message)); // a dropped idle connection must not crash the server
  return p;
};

// Main database: all writes, payments, bookings, inventory.
export const pool = make(process.env.DATABASE_URL);
// Optional read replica (DATABASE_READ_URL) for public browsing. Falls back to the main database when not set.
export const readPool = process.env.DATABASE_READ_URL ? make(process.env.DATABASE_READ_URL) : pool;

export const q = (text, params) => pool.query(text, params);
export const qRead = (text, params) => readPool.query(text, params);

// Run fn inside a transaction on the main database; commits on success, rolls back on any error.
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
