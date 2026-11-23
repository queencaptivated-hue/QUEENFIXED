import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { sslFor, SCHEMA } from "./dbconfig.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
// Use MIGRATION_DATABASE_URL (a direct, non-pooled connection) when your provider has a pooler; otherwise DATABASE_URL.
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
const client = new pg.Client({ connectionString: url, ssl: sslFor(url) });
await client.connect();
await client.query("CREATE TABLE IF NOT EXISTS public.qc_events_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())");
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  const done = await client.query("SELECT 1 FROM public.qc_events_migrations WHERE name=$1", [f]);
  if (done.rowCount) { console.log("skip", f); continue; }
  console.log("apply", f);
  await client.query(fs.readFileSync(path.join(dir, f), "utf8")); // each file has its own BEGIN/COMMIT
  await client.query("INSERT INTO public.qc_events_migrations(name) VALUES ($1)", [f]);
}
// Make the events schema the default for this database, so pooled connections need no per-connection setting.
const { rows: [d] } = await client.query("SELECT quote_ident(current_database()) AS n");
try { await client.query(`ALTER DATABASE ${d.n} SET search_path = ${SCHEMA}, public`); }
catch (e) { console.warn("Note: could not set the database default search_path (needs owner rights):", e.message); }
await client.end();
