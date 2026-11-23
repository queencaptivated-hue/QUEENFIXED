// Pre-flight check for ANY PostgreSQL provider: `npm run db:check` (uses DATABASE_URL, and DATABASE_READ_URL if set).
import "dotenv/config";
import pg from "pg";
import { sslFor } from "./dbconfig.js";

let bad = 0;
const line = (ok, msg) => { if (!ok) bad++; console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); };

async function check(label, url) {
  console.log(`\n== ${label} ==`);
  const c = new pg.Client({ connectionString: url, ssl: sslFor(url), connectionTimeoutMillis: 10_000 });
  try { await c.connect(); } catch (e) { line(false, `Cannot connect: ${e.message}`); return; }
  line(true, "Connected");
  const { rows: [v] } = await c.query("SHOW server_version_num");
  line(Number(v.server_version_num) >= 130000, `PostgreSQL version ${v.server_version_num} (needs 13 or newer)`);
  try { const { rows: [s] } = await c.query("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()"); if (!sslFor(url)) console.log("INFO  SSL is off (local server or DATABASE_SSL=off). Use SSL for any remote database."); else line(!!s?.ssl, "Connection is encrypted (SSL)"); }
  catch { console.log("INFO  Could not read SSL status (provider hides it)"); }
  const { rows: ext } = await c.query("SELECT name FROM pg_available_extensions WHERE name = ANY($1)", [["citext", "pgcrypto", "btree_gist"]]);
  for (const n of ["citext", "pgcrypto", "btree_gist"]) line(ext.some((e) => e.name === n), `Extension available: ${n}`);
  try { await c.query("BEGIN"); await c.query("CREATE SCHEMA qc_events_precheck"); await c.query("ROLLBACK"); line(true, "This user can create schemas"); }
  catch (e) { await c.query("ROLLBACK").catch(() => {}); line(false, `This user cannot create schemas: ${e.message}`); }
  try { const { rows: [x] } = await c.query("SELECT to_regclass('qc_events.bookings') AS t"); console.log(`INFO  Events tables ${x.t ? "already exist (migrations applied)" : "not created yet (run: npm run migrate)"}`); } catch {}
  await c.end();
}
await check("Main database (DATABASE_URL)", process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL);
if (process.env.DATABASE_READ_URL) await check("Read replica (DATABASE_READ_URL)", process.env.DATABASE_READ_URL);
console.log(bad ? `\n${bad} problem(s) found. Fix them before switching.` : "\nAll checks passed. This database is ready.");
process.exit(bad ? 1 : 0);
