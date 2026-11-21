import { Router } from "express";
import multer from "multer";
import sharp from "sharp";
import jsQR from "jsqr";
import { z } from "zod";
import { q, tx } from "../db.js";
import { requireAuth, requireRole, isAdmin, audit } from "../auth.js";
import { gateways } from "../payments/index.js";
import { putImage, getObject, sniffImage } from "../storage.js";
import { confirmPayment } from "../services/fulfil.js";

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });

// ---------- Which payment options are switched on ----------
r.get("/admin/payment-providers", requireAuth, requireRole("admin", "super_admin"), async (_req, res) => {
  const { rows } = await q(`SELECT code, display_name, is_enabled, sort_order FROM payment_providers ORDER BY sort_order`);
  res.json({ providers: rows.map((p) => ({ ...p, credentials_set: p.code === "upi_qr" ? null : !!gateways[p.code]?.configured() })) });
});
r.patch("/admin/payment-providers/:code", requireAuth, requireRole("admin", "super_admin"), async (req, res, next) => {
  try {
    const b = z.object({ is_enabled: z.boolean().optional(), sort_order: z.number().int().min(0).max(99).optional() }).parse(req.body);
    const code = req.params.code;
    if (b.is_enabled && gateways[code] && !gateways[code].configured()) throw Object.assign(new Error(`Add the ${code} API keys to the server environment before enabling it.`), { status: 400 });
    if (b.is_enabled && code === "upi_qr") {
      const { rowCount } = await q(`SELECT 1 FROM payment_qr_codes WHERE is_active LIMIT 1`);
      if (!rowCount) throw Object.assign(new Error("Upload a UPI QR code before enabling UPI QR payments."), { status: 400 });
    }
    const { rows: [p] } = await q(`UPDATE payment_providers SET is_enabled=coalesce($2,is_enabled), sort_order=coalesce($3,sort_order), updated_by=$4, updated_at=now() WHERE code=$1 RETURNING *`,
      [code, b.is_enabled ?? null, b.sort_order ?? null, req.user.sub]);
    if (!p) return res.status(404).json({ error: "Unknown provider." });
    await audit(null, req.user.sub, "payment_provider.update", "payment_provider", code, null, b);
    res.json({ provider: p });
  } catch (e) { next(e); }
});

// ---------- UPI QR upload ----------
// Reads the uploaded picture, confirms it really is a UPI payment QR, and takes the UPI ID from the QR itself.
export async function readUpiQr(buf) {
  const { data, info } = await sharp(buf).rotate().resize({ width: 1200, withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const hit = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  if (!hit || !/^upi:\/\/pay\?/i.test(hit.data)) throw Object.assign(new Error("We couldn’t find a UPI payment QR in that image. Upload a clear screenshot of your UPI app’s QR."), { status: 400 });
  const p = new URLSearchParams(hit.data.split("?")[1]);
  const vpa = p.get("pa") || "";
  if (!/^[\w.\-]{2,256}@[A-Za-z]{2,64}$/.test(vpa)) throw Object.assign(new Error("The QR doesn’t contain a valid UPI ID."), { status: 400 });
  if (p.get("am")) throw Object.assign(new Error("This QR has a fixed amount. Upload your general (any-amount) UPI QR."), { status: 400 });
  return { vpa, name: p.get("pn") || null };
}

async function saveQr(req, ownerType, organiserId) {
  if (!req.file) throw Object.assign(new Error("Choose an image to upload."), { status: 400 });
  if (!sniffImage(req.file.buffer)) throw Object.assign(new Error("Upload a JPG, PNG or WebP image."), { status: 400 });
  const { vpa, name } = await readUpiQr(req.file.buffer);
  const key = await putImage(req.file.buffer, "payment-qr", { maxWidth: 1200, lossless: true });
  return tx(async (c) => {
    if (ownerType === "platform") await c.query(`UPDATE payment_qr_codes SET is_active=false WHERE owner_type='platform' AND is_active`);
    else await c.query(`UPDATE payment_qr_codes SET is_active=false WHERE organiser_id=$1 AND is_active`, [organiserId]);
    const { rows: [row] } = await c.query(
      `INSERT INTO payment_qr_codes(owner_type, organiser_id, upi_id, payee_name, image_key, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, upi_id, payee_name, owner_type, is_active, created_at`,
      [ownerType, organiserId ?? null, vpa, (req.body.payee_name || name || "").slice(0, 80) || null, key, req.user.sub]);
    await audit(c, req.user.sub, "payment_qr.upload", "payment_qr", row.id, null, { owner_type: ownerType, upi_id: vpa });
    return row;
  });
}

r.post("/admin/payment-qr", requireAuth, requireRole("admin", "super_admin"), upload.single("image"), async (req, res, next) => {
  try { res.status(201).json({ qr: await saveQr(req, "platform") }); } catch (e) { next(e); }
});
r.post("/organiser/payment-qr", requireAuth, requireRole("organiser"), upload.single("image"), async (req, res, next) => {
  try {
    const { rows: [o] } = await q(`SELECT id FROM organisers WHERE profile_id=$1 AND status='approved'`, [req.user.sub]);
    if (!o) throw Object.assign(new Error("Your organiser account isn’t approved yet."), { status: 403 });
    res.status(201).json({ qr: await saveQr(req, "organiser", o.id) });
  } catch (e) { next(e); }
});
r.delete("/admin/payment-qr/:id", requireAuth, requireRole("admin", "super_admin"), async (req, res) => {
  await q(`UPDATE payment_qr_codes SET is_active=false WHERE id=$1`, [req.params.id]);
  await audit(null, req.user.sub, "payment_qr.deactivate", "payment_qr", req.params.id);
  res.json({ ok: true });
});
// Customers see the QR through this route (the bucket itself stays private).
r.get("/payment-qr/:id/image", async (req, res, next) => {
  try {
    const { rows: [k] } = await q(`SELECT image_key FROM payment_qr_codes WHERE id=$1 AND is_active`, [req.params.id]);
    if (!k) return res.status(404).end();
    const obj = await getObject(k.image_key);
    res.set({ "Content-Type": obj.ContentType || "image/png", "Cache-Control": "public, max-age=300" });
    obj.Body.pipe(res);
  } catch (e) { next(e); }
});

// ---------- Reviewing "I paid" claims ----------
const claimScope = (req) => (isAdmin(req) ? { sql: "TRUE", args: [] } : { sql: "q.organiser_id = (SELECT id FROM organisers WHERE profile_id=$1)", args: [req.user.sub] });

r.get("/claims", requireAuth, requireRole("admin", "super_admin", "organiser"), async (req, res) => {
  const s = claimScope(req);
  const { rows } = await q(
    `SELECT m.id, m.status, m.utr, m.created_at, b.reference, b.total_paise, m.screenshot_key IS NOT NULL AS has_screenshot
       FROM manual_payment_claims m JOIN bookings b ON b.id=m.booking_id JOIN payment_qr_codes q ON q.id=m.qr_code_id
      WHERE ${s.sql} AND m.status = coalesce($${s.args.length + 1}, m.status) ORDER BY m.created_at DESC LIMIT 200`,
    [...s.args, req.query.status || null]);
  res.json({ claims: rows });
});

r.post("/claims/:id/approve", requireAuth, requireRole("admin", "super_admin", "organiser"), async (req, res, next) => {
  try {
    // The reviewer must type the amount that actually reached the bank account, so approvals can’t be blind.
    const { amount_received_paise } = z.object({ amount_received_paise: z.number().int().positive() }).parse(req.body);
    const s = claimScope(req);
    const { rows: [m] } = await q(
      `SELECT m.*, b.total_paise FROM manual_payment_claims m JOIN bookings b ON b.id=m.booking_id JOIN payment_qr_codes q ON q.id=m.qr_code_id
        WHERE m.id=$${s.args.length + 1} AND m.status='pending' AND ${s.sql}`, [...s.args, req.params.id]);
    if (!m) return res.status(404).json({ error: "Claim not found or already reviewed." });
    if (amount_received_paise !== m.total_paise) return res.status(400).json({ error: `Amount received must equal the booking total (₹${(m.total_paise / 100).toFixed(2)}).` });
    await q(`UPDATE manual_payment_claims SET status='approved', reviewed_by=$2, reviewed_at=now(), review_note=$3 WHERE id=$1`, [m.id, req.user.sub, req.body.note || null]);
    const out = await confirmPayment(m.payment_id, { gatewayPaymentId: `upi:${m.utr.toUpperCase()}`, amountPaise: m.total_paise, method: "upi_qr", raw: { utr: m.utr, reviewed_by: req.user.sub } });
    await audit(null, req.user.sub, "upi_claim.approve", "claim", m.id, null, out);
    res.json({ ok: true, result: out });
  } catch (e) { next(e); }
});

r.post("/claims/:id/reject", requireAuth, requireRole("admin", "super_admin", "organiser"), async (req, res, next) => {
  try {
    const { note } = z.object({ note: z.string().trim().min(3).max(300) }).parse(req.body);
    const s = claimScope(req);
    const { rows: [m] } = await q(
      `UPDATE manual_payment_claims m SET status='rejected', reviewed_by=$${s.args.length + 2}, reviewed_at=now(), review_note=$${s.args.length + 3}
         FROM payment_qr_codes q WHERE q.id=m.qr_code_id AND m.id=$${s.args.length + 1} AND m.status='pending' AND ${s.sql} RETURNING m.id, m.payment_id`,
      [...s.args, req.params.id, req.user.sub, note]);
    if (!m) return res.status(404).json({ error: "Claim not found or already reviewed." });
    await q(`UPDATE payments SET status='failed' WHERE id=$1`, [m.payment_id]);
    await audit(null, req.user.sub, "upi_claim.reject", "claim", m.id, null, { note });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
