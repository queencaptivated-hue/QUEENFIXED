// Shared connection settings. Works with any PostgreSQL 13+ provider (Render, Neon, Supabase, AWS RDS/Aurora,
// Google Cloud SQL, Azure, DigitalOcean, Railway, or your own server). Everything is controlled by environment variables.
export function sslFor(url) {
  const mode = (process.env.DATABASE_SSL || "").toLowerCase();
  if (mode === "off" || (!mode && /@(localhost|127\.0\.0\.1)(:|\/|$)/.test(url || ""))) return false;
  if (mode === "verify") return { rejectUnauthorized: true, ca: process.env.DATABASE_CA_CERT || undefined }; // strict: checks the server certificate
  return { rejectUnauthorized: false }; // "require" (default): encrypted connection
}
// "startup": send search_path with every connection (default).
// "database": rely on the database default set by `npm run migrate` (needed behind poolers such as PgBouncer / Neon / Supabase pooled URLs).
export const searchPathMode = () => (process.env.DB_SEARCH_PATH_MODE === "database" ? "database" : "startup");
export const SCHEMA = "qc_events";
