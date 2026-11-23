import { Router } from "express";
import { q, qRead } from "../db.js";
import { getObject } from "../storage.js";

const r = Router();
const mediaUrl = (key) => (key ? `${process.env.API_PUBLIC_URL}/api/events/media/${key}` : null);
const LIVE = `e.status IN ('published','postponed')`;

// GET /api/events/public?q=&category=&city=&date_from=&date_to=&featured=1&upcoming=1&page=&limit=
r.get("/public", async (req, res, next) => {
  try {
    const p = []; const w = [LIVE];
    const add = (sql, v) => { p.push(v); w.push(sql.replace("?", `$${p.length}`)); };
    if (req.query.q) add(`(e.title ILIKE ?)`, `%${String(req.query.q).slice(0, 80).replace(/[%_\\]/g, "\\$&")}%`);
    if (req.query.category) add(`c.slug = ?`, String(req.query.category));
    if (req.query.city) add(`v.city ILIKE ?`, `%${String(req.query.city).slice(0, 60).replace(/[%_\\]/g, "\\$&")}%`);
    if (req.query.date_from && !isNaN(Date.parse(req.query.date_from))) add(`e.starts_at >= ?`, req.query.date_from);
    if (req.query.date_to && !isNaN(Date.parse(req.query.date_to))) add(`e.starts_at < (?::date + 1)`, req.query.date_to);
    if (req.query.date && !isNaN(Date.parse(req.query.date))) add(`e.starts_at::date = ?::date`, req.query.date);
    if (req.query.featured === "1") w.push(`e.is_featured`);
    if (!req.query.date && !req.query.date_from) w.push(`coalesce(e.ends_at, e.starts_at) >= now()`); // hide past events unless a date is asked for
    const limit = Math.min(Number(req.query.limit) || 12, 50), page = Math.max(Number(req.query.page) || 1, 1);
    const where = w.join(" AND ");
    const { rows } = await qRead(
      `SELECT e.id, e.slug, e.title, e.status, e.starts_at, e.ends_at, e.is_featured, e.poster_key, v.name AS venue, v.city, c.slug AS category, c.name AS category_name,
              (SELECT min(price_paise) FROM ticket_categories t WHERE t.event_id=e.id AND t.total_qty - t.sold_qty - t.held_qty > 0) AS from_price_paise,
              NOT EXISTS (SELECT 1 FROM ticket_categories t WHERE t.event_id=e.id AND t.total_qty - t.sold_qty - t.held_qty > 0) AS sold_out
         FROM events e LEFT JOIN venues v ON v.id=e.venue_id LEFT JOIN event_categories c ON c.id=e.category_id
        WHERE ${where} ORDER BY e.is_featured DESC, e.starts_at ASC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, p);
    const { rows: [t] } = await qRead(`SELECT count(*)::int AS n FROM events e LEFT JOIN venues v ON v.id=e.venue_id LEFT JOIN event_categories c ON c.id=e.category_id WHERE ${where}`, p);
    res.json({ events: rows.map(({ poster_key, ...e }) => ({ ...e, poster_url: mediaUrl(poster_key) })), page, total: t.n });
  } catch (e) { next(e); }
});

r.get("/public/categories", async (_req, res) => {
  const { rows } = await qRead(`SELECT c.slug, c.name, count(e.id)::int AS events FROM event_categories c LEFT JOIN events e ON e.category_id=c.id AND ${LIVE} AND coalesce(e.ends_at,e.starts_at) >= now() GROUP BY c.id ORDER BY c.sort_order, c.name`);
  res.json({ categories: rows });
});

// Calendar: which days of a month have events. GET /public/calendar?month=2026-12
r.get("/public/calendar", async (req, res) => {
  const m = /^\d{4}-\d{2}$/.test(req.query.month || "") ? req.query.month : new Date().toISOString().slice(0, 7);
  const { rows } = await qRead(`SELECT e.starts_at::date AS day, count(*)::int AS events FROM events e WHERE ${LIVE} AND to_char(e.starts_at,'YYYY-MM')=$1 GROUP BY 1 ORDER BY 1`, [m]);
  res.json({ month: m, days: rows });
});

r.get("/public/:slug", async (req, res, next) => {
  try {
    const { rows: [e] } = await q(
      `SELECT e.id, e.slug, e.title, e.description, e.status, e.status_note, e.starts_at, e.ends_at, e.capacity, e.is_featured, e.poster_key, e.video_url,
              v.name AS venue, v.address, v.city, v.state, v.latitude, v.longitude, v.google_maps_url, c.slug AS category, c.name AS category_name, o.org_name AS organiser
         FROM events e LEFT JOIN venues v ON v.id=e.venue_id LEFT JOIN event_categories c ON c.id=e.category_id JOIN organisers o ON o.id=e.organiser_id
        WHERE e.slug=$1 AND (${LIVE} OR e.status IN ('cancelled','completed'))`, [req.params.slug]);
    if (!e) return res.status(404).json({ error: "Event not found." });
    const { rows: cats } = await q(
      `SELECT id, kind, name, price_paise, admits, max_per_booking, sale_starts_at, sale_ends_at, greatest(total_qty - sold_qty - held_qty, 0) AS available FROM ticket_categories WHERE event_id=$1 ORDER BY price_paise`, [e.id]);
    const { rows: sched } = await q(`SELECT starts_at, title, details FROM event_schedule WHERE event_id=$1 ORDER BY starts_at`, [e.id]);
    const { rows: gal } = await q(`SELECT object_key FROM event_media WHERE event_id=$1 AND kind='image' ORDER BY sort_order`, [e.id]);
    const { poster_key, id, ...pub } = e;
    const open = ["published"].includes(e.status);
    const now = Date.now();
    res.json({ event: { ...pub, id, poster_url: mediaUrl(poster_key), gallery: gal.map((g) => mediaUrl(g.object_key)), booking_open: open },
      tickets: cats.map((t) => ({ ...t, on_sale: open && t.available > 0 && (!t.sale_starts_at || new Date(t.sale_starts_at) <= now) && (!t.sale_ends_at || new Date(t.sale_ends_at) >= now) })), schedule: sched });
  } catch (e) { next(e); }
});

// Public images only: event posters and galleries. KYC, QR-claim screenshots etc. live under other prefixes and are never served here.
r.get("/media/events/:file", async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}\.(webp|png)$/.test(req.params.file)) return res.status(404).end();
    const obj = await getObject(`events/${req.params.file}`);
    res.set({ "Content-Type": obj.ContentType || "image/webp", "Cache-Control": "public, max-age=86400, immutable" });
    obj.Body.pipe(res);
  } catch (e) { e.status === 404 || e.name === "NoSuchKey" ? res.status(404).end() : next(e); }
});
export default r;
