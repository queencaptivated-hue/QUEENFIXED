import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { q, tx } from "../db.js";
import { requireAuth, audit } from "../auth.js";
import { normaliseTarget, newCode, hashCode, safeEq, deliver } from "../otp.js";
import QRCode from "qrcode";
import { makeTicketQr } from "../lib/ticketqr.js";

const r = Router();
const devMode = () => process.env.OTP_MODE === "console" && process.env.NODE_ENV !== "production";

r.post("/auth/otp/request", async (req, res, next) => {
  try {
    const t = normaliseTarget(req.body?.target);
    if (!t) return res.status(400).json({ error: "Enter a valid email address or 10-digit mobile number." });
    const { rows: [n] } = await q(`SELECT count(*)::int AS n FROM otp_codes WHERE target=$1 AND created_at > now() - interval '1 hour'`, [t.value]);
    if (n.n >= 5) return res.status(429).json({ error: "Too many codes requested. Please try again in an hour." });
    const code = newCode();
    await deliver(t, code); // deliver first so a failed send doesn’t burn a code
    await q(`INSERT INTO otp_codes(target, code_hash, expires_at) VALUES ($1,$2, now() + interval '10 minutes')`, [t.value, hashCode(t.value, code)]);
    res.json({ sent: true, ...(devMode() ? { dev_code: code } : {}) }); // identical reply whether or not the account exists
  } catch (e) { next(e); }
});

r.post("/auth/otp/verify", async (req, res, next) => {
  try {
    const b = z.object({ target: z.string(), code: z.string().regex(/^\d{6}$/), full_name: z.string().trim().min(2).max(80).optional() }).parse(req.body);
    const t = normaliseTarget(b.target);
    if (!t) return res.status(400).json({ error: "Invalid email or mobile number." });
    // The attempt is counted in its own statement, so a wrong guess can never be rolled back.
    const { rows: [o] } = await q(
      `UPDATE otp_codes SET attempts = attempts + 1
        WHERE id = (SELECT id FROM otp_codes WHERE target=$1 AND consumed_at IS NULL AND expires_at > now() AND attempts < 5 ORDER BY created_at DESC LIMIT 1)
        RETURNING id, code_hash`, [t.value]);
    if (!o) return res.status(400).json({ error: "That code has expired or was used too many times. Request a new one." });
    if (!safeEq(o.code_hash, hashCode(t.value, b.code))) return res.status(400).json({ error: "Incorrect code." });

    const out = await tx(async (c) => {
      const col = t.kind === "email" ? "email" : "mobile";
      let { rows: [p] } = await c.query(`SELECT id, full_name FROM profiles WHERE ${col}=$1`, [t.value]);
      if (!p && !b.full_name) return { needs_name: true }; // code stays valid; ask for the name and try again
      const used = await c.query(`UPDATE otp_codes SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL`, [o.id]);
      if (!used.rowCount) throw Object.assign(new Error("That code was already used."), { status: 400 });
      if (!p) {
        ({ rows: [p] } = await c.query(`INSERT INTO profiles(full_name, ${col}, ${col}_verified_at) VALUES ($1,$2, now()) RETURNING id, full_name`, [b.full_name, t.value]));
        await c.query(`INSERT INTO profile_roles(profile_id, role_id) SELECT $1, id FROM roles WHERE code='customer' ON CONFLICT DO NOTHING`, [p.id]);
      } else {
        await c.query(`UPDATE profiles SET ${col}_verified_at = coalesce(${col}_verified_at, now()) WHERE id=$1`, [p.id]);
      }
      // First super admin: an email listed in ADMIN_BOOTSTRAP_EMAILS, proven by OTP. No default passwords exist.
      const boot = (process.env.ADMIN_BOOTSTRAP_EMAILS || "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
      if (t.kind === "email" && boot.includes(t.value)) {
        await c.query(`INSERT INTO profile_roles(profile_id, role_id) SELECT $1, id FROM roles WHERE code='super_admin' ON CONFLICT DO NOTHING`, [p.id]);
        await audit(c, p.id, "admin.bootstrap", "profile", p.id);
      }
      return { profile: p };
    });
    if (out.needs_name) return res.json({ needs_name: true });
    res.json({ token: jwt.sign({ sub: out.profile.id }, process.env.EVENTS_JWT_SECRET, { expiresIn: "30d" }), profile: out.profile });
  } catch (e) { next(e); }
});

r.get("/me", requireAuth, async (req, res) => {
  const { rows: [p] } = await q(`SELECT id, full_name, email, mobile FROM profiles WHERE id=$1 AND is_active`, [req.user.sub]);
  if (!p) return res.status(401).json({ error: "Account not found." });
  const { rows: roles } = await q(`SELECT r.code FROM profile_roles pr JOIN roles r ON r.id=pr.role_id WHERE pr.profile_id=$1`, [p.id]);
  const { rows: [org] } = await q(`SELECT id, status, org_name FROM organisers WHERE profile_id=$1`, [p.id]);
  res.json({ profile: p, roles: roles.map((x) => x.code), organiser: org || null });
});

// My Tickets: every booking with its QR-ready tickets.
r.get("/me/bookings", requireAuth, async (req, res) => {
  const { rows: bs } = await q(
    `SELECT b.id, b.reference, b.status, b.total_paise, b.created_at, e.title, e.slug, e.starts_at, v.name AS venue, v.city
       FROM bookings b JOIN events e ON e.id=b.event_id LEFT JOIN venues v ON v.id=e.venue_id
      WHERE b.profile_id=$1 ORDER BY b.created_at DESC LIMIT 100`, [req.user.sub]);
  const ids = bs.map((b) => b.id);
  const { rows: ts } = ids.length ? await q(`SELECT t.id, t.booking_id, t.status, c.name AS category FROM tickets t JOIN ticket_categories c ON c.id=t.category_id WHERE t.booking_id = ANY($1)`, [ids]) : { rows: [] };
  res.json({ bookings: bs.map((b) => ({ ...b, tickets: ts.filter((t) => t.booking_id === b.id).map((t) => ({ id: t.id, status: t.status, category: t.category, qr: makeTicketQr(t.id) })) })) });
});
// QR image for one of MY tickets (rendered server-side so the signed code never needs a browser library).
r.get("/me/tickets/:id/qr.svg", requireAuth, async (req, res, next) => {
  try {
    const { rows: [t] } = await q(`SELECT t.id FROM tickets t JOIN bookings b ON b.id=t.booking_id WHERE t.id=$1 AND b.profile_id=$2 AND t.status IN ('valid','checked_in')`, [req.params.id, req.user.sub]);
    if (!t) return res.status(404).json({ error: "Ticket not found." });
    res.set({ "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=300" }).send(await QRCode.toString(makeTicketQr(t.id), { type: "svg", margin: 1, errorCorrectionLevel: "M" }));
  } catch (e) { next(e); }
});
export default r;
