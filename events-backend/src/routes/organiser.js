import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { q, tx } from "../db.js";
import { requireAuth, audit } from "../auth.js";
import { putImage, putDocument } from "../storage.js";
import { encryptJson, slugWithSuffix, csvCell } from "../lib/crypto.js";

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 3 } });
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const KINDS = ["general", "premium", "vip", "couple", "group", "early_bird", "student", "complimentary"];

// ---------- Registration ("Publish Your Event") ----------
const regSchema = z.object({
  org_name: z.string().trim().min(2).max(120), contact_name: z.string().trim().min(2).max(80),
  mobile: z.string().regex(/^[6-9]\d{9}$/, "Enter a 10-digit mobile number."), email: z.string().email().max(254),
  address: z.string().trim().min(5).max(300), business_info: z.string().trim().max(1500).optional(),
  bank_holder: z.string().trim().min(2).max(80), bank_account: z.string().regex(/^\d{9,18}$/, "Account number must be 9 to 18 digits."),
  bank_ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Enter a valid IFSC code."),
});
r.post("/organiser/register", requireAuth, upload.array("kyc", 3), async (req, res, next) => {
  try {
    const b = regSchema.parse(req.body);
    if (!req.files?.length) throw bad("Upload at least one identity or business document (JPG, PNG, WebP or PDF).");
    const keys = [];
    for (const f of req.files) keys.push(await putDocument(f.buffer, "kyc")); // private prefix, never served publicly
    const enc = encryptJson({ holder: b.bank_holder, account: b.bank_account, ifsc: b.bank_ifsc });
    const { rows: [ex] } = await q(`SELECT id, status FROM organisers WHERE profile_id=$1`, [req.user.sub]);
    if (ex && ex.status !== "rejected") throw bad("You already have an organiser application.", 409);
    const vals = [req.user.sub, b.org_name, b.contact_name, b.mobile, b.email, b.address, b.business_info ?? null, keys, enc, b.bank_account.slice(-4)];
    const { rows: [o] } = ex
      ? await q(`UPDATE organisers SET org_name=$2, contact_name=$3, mobile=$4, email=$5, address=$6, business_info=$7, kyc_doc_keys=$8, bank_account_ref=$9, bank_last4=$10, status='pending', review_note=NULL WHERE profile_id=$1 RETURNING id,status`, vals)
      : await q(`INSERT INTO organisers(profile_id, org_name, contact_name, mobile, email, address, business_info, kyc_doc_keys, bank_account_ref, bank_last4, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING id,status`, vals);
    await audit(null, req.user.sub, "organiser.register", "organiser", o.id);
    res.status(201).json({ organiser: o, message: "Application received. We’ll review it and let you know." });
  } catch (e) { next(e); }
});

// Only an APPROVED organiser may use anything below.
async function approvedOrganiser(req, res, next) {
  const { rows: [o] } = await q(`SELECT id, org_name FROM organisers WHERE profile_id=$1 AND status='approved'`, [req.user.sub]);
  if (!o) return res.status(403).json({ error: "Your organiser account isn’t approved yet." });
  req.org = o; next();
}
const guard = [requireAuth, approvedOrganiser];
async function ownEvent(req, id) {
  const { rows: [e] } = await q(`SELECT * FROM events WHERE id=$1 AND organiser_id=$2`, [id, req.org.id]);
  if (!e) throw bad("Event not found.", 404);
  return e;
}

// ---------- Create / edit events ----------
const venueSchema = z.object({ name: z.string().trim().min(2).max(120), address: z.string().trim().min(3).max(300), city: z.string().trim().min(2).max(80), state: z.string().trim().max(80).optional(),
  latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(), google_maps_url: z.string().url().max(500).optional() });
const catSchema = z.object({ kind: z.enum(KINDS), name: z.string().trim().min(2).max(60), price_paise: z.number().int().min(0).max(100000000), total_qty: z.number().int().min(1).max(1000000),
  admits: z.number().int().min(1).max(100).optional(), sale_starts_at: z.string().datetime().optional(), sale_ends_at: z.string().datetime().optional(), max_per_booking: z.number().int().min(1).max(20).optional() });
const eventSchema = z.object({
  title: z.string().trim().min(3).max(120), description: z.string().trim().max(5000).optional(), category_slug: z.string(),
  venue: venueSchema, starts_at: z.string().datetime(), ends_at: z.string().datetime().optional(), capacity: z.number().int().min(1).optional(),
  video_url: z.string().url().max(500).refine((u) => u.startsWith("https://"), "Video link must start with https://").optional(),
  schedule: z.array(z.object({ starts_at: z.string().datetime(), title: z.string().trim().min(1).max(120), details: z.string().max(500).optional() })).max(40).optional(),
  ticket_categories: z.array(catSchema).max(10).optional(),
});

r.post("/organiser/events", ...guard, async (req, res, next) => {
  try {
    const b = eventSchema.parse(req.body);
    if (b.ends_at && new Date(b.ends_at) <= new Date(b.starts_at)) throw bad("The end time must be after the start time.");
    const ev = await tx(async (c) => {
      const { rows: [cat] } = await c.query(`SELECT id FROM event_categories WHERE slug=$1`, [b.category_slug]);
      if (!cat) throw bad("Unknown category.");
      const v = b.venue;
      const { rows: [ven] } = await c.query(`INSERT INTO venues(name,address,city,state,latitude,longitude,google_maps_url,capacity) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [v.name, v.address, v.city, v.state ?? null, v.latitude ?? null, v.longitude ?? null, v.google_maps_url ?? null, b.capacity ?? null]);
      const { rows: [e] } = await c.query(
        `INSERT INTO events(organiser_id, category_id, venue_id, slug, title, description, starts_at, ends_at, capacity, video_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, slug, status`,
        [req.org.id, cat.id, ven.id, slugWithSuffix(b.title), b.title, b.description ?? null, b.starts_at, b.ends_at ?? null, b.capacity ?? null, b.video_url ?? null]);
      for (const s of b.schedule ?? []) await c.query(`INSERT INTO event_schedule(event_id, starts_at, title, details) VALUES ($1,$2,$3,$4)`, [e.id, s.starts_at, s.title, s.details ?? null]);
      for (const t of b.ticket_categories ?? []) await insertCategory(c, e.id, t);
      await audit(c, req.user.sub, "event.create", "event", e.id);
      return e;
    });
    res.status(201).json({ event: ev });
  } catch (e) { next(e); }
});
async function insertCategory(c, eventId, t) {
  if (t.kind === "complimentary" && t.price_paise !== 0) throw bad("Complimentary tickets must be free.");
  await c.query(`INSERT INTO ticket_categories(event_id, kind, name, price_paise, admits, total_qty, sale_starts_at, sale_ends_at, max_per_booking) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [eventId, t.kind, t.name, t.price_paise, t.admits ?? 1, t.total_qty, t.sale_starts_at ?? null, t.sale_ends_at ?? null, t.max_per_booking ?? 10]);
}

r.patch("/organiser/events/:id", ...guard, async (req, res, next) => {
  try {
    const e = await ownEvent(req, req.params.id);
    const live = ["published", "postponed"].includes(e.status);
    if (e.status === "pending_approval") throw bad("This event is waiting for review and can’t be edited right now.", 409);
    if (["cancelled", "completed"].includes(e.status)) throw bad("This event can no longer be edited.", 409);
    const full = eventSchema.partial().omit({ venue: true, ticket_categories: true, schedule: true, category_slug: true });
    const b = full.parse(req.body);
    // Once live, date/title/venue are locked (buyers rely on them). Use postpone/cancel instead.
    if (live && (b.title || b.starts_at || b.ends_at || b.capacity)) throw bad("Date and title can’t be changed on a live event. Use postpone or cancel.", 409);
    const { rows: [u] } = await q(`UPDATE events SET title=coalesce($2,title), description=coalesce($3,description), starts_at=coalesce($4,starts_at), ends_at=coalesce($5,ends_at), capacity=coalesce($6,capacity), video_url=coalesce($7,video_url) WHERE id=$1 RETURNING id,status`,
      [e.id, b.title ?? null, b.description ?? null, b.starts_at ?? null, b.ends_at ?? null, b.capacity ?? null, b.video_url ?? null]);
    await audit(null, req.user.sub, "event.update", "event", e.id);
    res.json({ event: u });
  } catch (e) { next(e); }
});

const imgUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024, files: 1 } });
r.post("/organiser/events/:id/poster", ...guard, imgUpload.single("image"), async (req, res, next) => {
  try {
    const e = await ownEvent(req, req.params.id);
    if (!req.file) throw bad("Choose an image.");
    const key = await putImage(req.file.buffer, "events", { maxWidth: 1600 });
    await q(`UPDATE events SET poster_key=$2 WHERE id=$1`, [e.id, key]);
    res.json({ poster_key: key });
  } catch (e) { next(e); }
});
r.post("/organiser/events/:id/gallery", ...guard, imgUpload.single("image"), async (req, res, next) => {
  try {
    const e = await ownEvent(req, req.params.id);
    if (!req.file) throw bad("Choose an image.");
    const { rows: [n] } = await q(`SELECT count(*)::int AS n FROM event_media WHERE event_id=$1`, [e.id]);
    if (n.n >= 12) throw bad("Gallery is full (12 photos).");
    const key = await putImage(req.file.buffer, "events", { maxWidth: 1600 });
    await q(`INSERT INTO event_media(event_id, kind, object_key, sort_order) VALUES ($1,'image',$2,$3)`, [e.id, key, n.n]);
    res.status(201).json({ object_key: key });
  } catch (e) { next(e); }
});

// ---------- Ticket categories ----------
r.post("/organiser/events/:id/ticket-categories", ...guard, async (req, res, next) => {
  try {
    const e = await ownEvent(req, req.params.id);
    if (["cancelled", "completed"].includes(e.status)) throw bad("This event is closed.", 409);
    await tx((c) => insertCategory(c, e.id, catSchema.parse(req.body)));
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});
r.patch("/organiser/ticket-categories/:id", ...guard, async (req, res, next) => {
  try {
    const b = catSchema.pick({ name: true, price_paise: true, total_qty: true, sale_starts_at: true, sale_ends_at: true, max_per_booking: true }).partial().parse(req.body);
    const { rows: [t] } = await q(`SELECT c.id FROM ticket_categories c JOIN events e ON e.id=c.event_id WHERE c.id=$1 AND e.organiser_id=$2 AND e.status NOT IN ('cancelled','completed')`, [req.params.id, req.org.id]);
    if (!t) throw bad("Ticket type not found.", 404);
    try {
      await q(`UPDATE ticket_categories SET name=coalesce($2,name), price_paise=coalesce($3,price_paise), total_qty=coalesce($4,total_qty), sale_starts_at=coalesce($5,sale_starts_at), sale_ends_at=coalesce($6,sale_ends_at), max_per_booking=coalesce($7,max_per_booking) WHERE id=$1`,
        [t.id, b.name ?? null, b.price_paise ?? null, b.total_qty ?? null, b.sale_starts_at ?? null, b.sale_ends_at ?? null, b.max_per_booking ?? null]);
    } catch (e) { if (e.code === "23514") throw bad("You can’t set the quantity below the tickets already sold or reserved.", 409); throw e; }
    res.json({ ok: true });
  } catch (e) { next(e); }
});
r.delete("/organiser/ticket-categories/:id", ...guard, async (req, res, next) => {
  try {
    const { rowCount } = await q(`DELETE FROM ticket_categories c USING events e WHERE c.id=$1 AND e.id=c.event_id AND e.organiser_id=$2 AND c.sold_qty=0 AND c.held_qty=0`, [req.params.id, req.org.id]);
    if (!rowCount) throw bad("Can’t delete: tickets of this type are already sold or reserved.", 409);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Submit for approval / postpone / cancel ----------
r.post("/organiser/events/:id/submit", ...guard, async (req, res, next) => {
  try {
    const e = await ownEvent(req, req.params.id);
    if (e.status !== "draft") throw bad("Only draft events can be submitted.", 409);
    if (new Date(e.starts_at) <= new Date()) throw bad("The event date must be in the future.");
    const { rows: [n] } = await q(`SELECT count(*)::int AS n FROM ticket_categories WHERE event_id=$1`, [e.id]);
    if (!n.n) throw bad("Add at least one ticket type before submitting.");
    await q(`UPDATE events SET status='pending_approval', status_note=NULL WHERE id=$1`, [e.id]);
    await audit(null, req.user.sub, "event.submit", "event", e.id);
    res.json({ status: "pending_approval", message: "Submitted. It will go live once an admin approves it." });
  } catch (e) { next(e); }
});
r.post("/organiser/events/:id/postpone", ...guard, async (req, res, next) => {
  try {
    const b = z.object({ new_starts_at: z.string().datetime(), note: z.string().trim().min(3).max(300) }).parse(req.body);
    const e = await ownEvent(req, req.params.id);
    if (!["published", "postponed"].includes(e.status)) throw bad("Only live events can be postponed.", 409);
    await q(`UPDATE events SET status='postponed', starts_at=$2, ends_at=NULL, status_note=$3 WHERE id=$1`, [e.id, b.new_starts_at, b.note]);
    await audit(null, req.user.sub, "event.postpone", "event", e.id, { starts_at: e.starts_at }, b);
    res.json({ status: "postponed" });
  } catch (e) { next(e); }
});
r.post("/organiser/events/:id/cancel", ...guard, async (req, res, next) => {
  try {
    const { note } = z.object({ note: z.string().trim().min(3).max(300) }).parse(req.body);
    const e = await ownEvent(req, req.params.id);
    if (["cancelled", "completed"].includes(e.status)) throw bad("Already closed.", 409);
    const out = await tx(async (c) => {
      await c.query(`UPDATE events SET status='cancelled', status_note=$2 WHERE id=$1`, [e.id, note]);
      // Un-paid reservations are released; paid bookings are cancelled and a refund is queued for each payment.
      const { rows: pend } = await c.query(`SELECT b.id FROM bookings b WHERE b.event_id=$1 AND b.status='pending_payment' FOR UPDATE`, [e.id]);
      for (const p of pend) {
        const { rows: its } = await c.query(`SELECT category_id, qty FROM booking_items WHERE booking_id=$1`, [p.id]);
        for (const it of its) await c.query(`SELECT release_tickets($1,$2,false)`, [it.category_id, it.qty]);
        await c.query(`UPDATE bookings SET status='expired' WHERE id=$1`, [p.id]);
      }
      const { rows: paid } = await c.query(`SELECT b.id AS booking_id, p.id AS payment_id, p.amount_paise FROM bookings b JOIN payments p ON p.ref_id=b.id AND p.service='ticket' AND p.status='captured' WHERE b.event_id=$1 AND b.status='confirmed'`, [e.id]);
      for (const x of paid) {
        await c.query(`INSERT INTO refunds(payment_id, booking_id, amount_paise, reason, status) VALUES ($1,$2,$3,$4,'requested')`, [x.payment_id, x.booking_id, x.amount_paise, "Event cancelled by organiser"]);
        await c.query(`UPDATE bookings SET status='cancelled' WHERE id=$1`, [x.booking_id]);
        await c.query(`UPDATE tickets SET status='cancelled' WHERE booking_id=$1 AND status='valid'`, [x.booking_id]);
      }
      await audit(c, req.user.sub, "event.cancel", "event", e.id, null, { note, refunds_queued: paid.length });
      return paid.length;
    });
    res.json({ status: "cancelled", refunds_queued: out });
  } catch (e) { next(e); }
});

// ---------- My events, sales, attendees ----------
r.get("/organiser/events", ...guard, async (req, res) => {
  const { rows } = await q(
    `SELECT e.id, e.slug, e.title, e.status, e.status_note, e.starts_at, e.is_featured,
            coalesce(sum(c.sold_qty),0)::int AS sold, coalesce(sum(c.total_qty),0)::int AS total
       FROM events e LEFT JOIN ticket_categories c ON c.event_id=e.id WHERE e.organiser_id=$1 GROUP BY e.id ORDER BY e.starts_at DESC`, [req.org.id]);
  res.json({ events: rows });
});
r.get("/organiser/events/:id/sales", ...guard, async (req, res, next) => {
  try {
    const e = await ownEvent(req, req.params.id);
    const { rows: cats } = await q(`SELECT id, name, kind, price_paise, total_qty, sold_qty, held_qty FROM ticket_categories WHERE event_id=$1 ORDER BY price_paise`, [e.id]);
    const { rows: [m] } = await q(
      `SELECT count(DISTINCT b.id)::int AS bookings, coalesce(sum(l.gross_paise),0)::int AS gross, coalesce(sum(l.commission_paise),0)::int AS platform_commission,
              coalesce(sum(l.gateway_fee_paise),0)::int AS gateway_fees, coalesce(sum(l.net_payable_paise),0)::int AS net_earnings
         FROM bookings b JOIN payments p ON p.ref_id=b.id AND p.status='captured' JOIN ledger_entries l ON l.payment_id=p.id WHERE b.event_id=$1 AND b.status='confirmed'`, [e.id]);
    res.json({ event: { id: e.id, title: e.title, status: e.status }, categories: cats, totals: m });
  } catch (e) { next(e); }
});
r.get("/organiser/events/:id/attendees.csv", ...guard, async (req, res, next) => {
  try {
    const e = await ownEvent(req, req.params.id);
    const { rows } = await q(
      `SELECT b.reference, c.name AS category, t.status, p.full_name, p.mobile, p.email FROM tickets t JOIN bookings b ON b.id=t.booking_id JOIN ticket_categories c ON c.id=t.category_id
         LEFT JOIN profiles p ON p.id=b.profile_id WHERE t.event_id=$1 ORDER BY b.created_at`, [e.id]);
    const head = "Booking,Ticket type,Status,Name,Mobile,Email";
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="attendees-${e.slug}.csv"` });
    res.send([head, ...rows.map((x) => [x.reference, x.category, x.status, x.full_name, x.mobile, x.email].map(csvCell).join(","))].join("\n"));
  } catch (e) { next(e); }
});
export default r;
