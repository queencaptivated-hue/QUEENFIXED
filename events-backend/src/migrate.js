import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});
await client.connect();
await client.query("CREATE TABLE IF NOT EXISTS public.qc_events_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())");
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  const done = await client.query("SELECT 1 FROM public.qc_events_migrations WHERE name=$1", [f]);
  if (done.rowCount) { console.log("skip", f); continue; }
  console.log("apply", f);
  await client.query(fs.readFileSync(path.join(dir, f), "utf8")); // each file has its own BEGIN/COMMIT
  await client.query("INSERT INTO public.qc_events_migrations(name) VALUES ($1)", [f]);
}
await client.end();
