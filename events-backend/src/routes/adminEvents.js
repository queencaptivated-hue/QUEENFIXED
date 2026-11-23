import { Router } from "express";
import { z } from "zod";
import { q, tx } from "../db.js";
import { requireAuth, requireRole, audit } from "../auth.js";
import { getObject } from "../storage.js";
import { decryptJson } from "../lib/crypto.js";

const r = Router();
const admin = [requireAuth, requireRole("admin", "super_admin")];
const noteSchema = z.object({ note: z.string().trim().min(3).max(300) });

// ---------- Organiser applications ----------
r.get("/admin/organisers", ...admin, async (req, res) => {
  const { rows } = await q(`SELECT o.id, o.org_name, o.contact_name, o.mobile, o.email, o.address, o.business_info, o.status, o.review_note, o.bank_last4, coalesce(array_length(o.kyc_doc_keys,1),0) AS documents, o.created_at
    FROM organisers o WHERE o.status = coalesce($1, o.status) ORDER BY o.created_at DESC LIMIT 200`, [req.query.status || null]);
  res.json({ organisers: rows });
});
// Documents are streamed to admins only; the storage bucket is never public.
r.get("/admin/organisers/:id/documents/:n", ...admin, async (req, res, next) => {
  try {
    const { rows: [o] } = await q(`SELECT kyc_doc_keys FROM organisers WHERE id=$1`, [req.params.id]);
    const key = o?.kyc_doc_keys?.[Number(req.params.n)];
    if (!key) return res.status(404).json({ error: "Document not found." });
    await audit(null, req.user.sub, "organiser.view_document", "organiser", req.params.id);
    const obj = await getObject(key);
    res.set({ "Content-Type": obj.ContentType || "application/octet-stream", "Content-Disposition": "attachment", "Cache-Control": "private, no-store" });
    obj.Body.pipe(res);
  } catch (e) { next(e); }
});
// Full bank details are shown only when a super admin asks, and every view is audit-logged.
r.get("/admin/organisers/:id/bank", requireAuth, requireRole("super_admin"), async (req, res, next) => {
  try {
    const { rows: [o] } = await q(`SELECT bank_account_ref FROM organisers WHERE id=$1`, [req.params.id]);
    if (!o?.bank_account_ref) return res.status(404).json({ error: "Not found." });
    await audit(null, req.user.sub, "organiser.view_bank", "organiser", req.params.id);
    res.set("Cache-Control", "no-store").json({ bank: decryptJson(o.bank_account_ref) });
  } catch (e) { next(e); }
});
r.post("/admin/organisers/:id/approve", ...admin, async (req, res, next) => {
  try {
    await tx(async (c) => {
      const { rows: [o] } = await c.query(`UPDATE organisers SET status='approved', reviewed_by=$2, reviewed_at=now(), review_note=NULL WHERE id=$1 AND status IN ('pending','rejected','suspended') RETURNING profile_id`, [req.params.id, req.user.sub]);
      if (!o) throw Object.assign(new Error("Application not found or already approved."), { status: 404 });
      await c.query(`INSERT INTO profile_roles(profile_id, role_id) SELECT $1, id FROM roles WHERE code='organiser' ON CONFLICT DO NOTHING`, [o.profile_id]);
      await c.query(`INSERT INTO notifications(profile_id, channel, template, payload) VALUES ($1,'email','organiser_approved','{}')`, [o.profile_id]);
      await audit(c, req.user.sub, "organiser.approve", "organiser", req.params.id);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
r.post("/admin/organisers/:id/reject", ...admin, async (req, res, next) => {
  try {
    const { note } = noteSchema.parse(req.body);
    const { rows: [o] } = await q(`UPDATE organisers SET status='rejected', reviewed_by=$2, reviewed_at=now(), review_note=$3 WHERE id=$1 AND status='pending' RETURNING profile_id`, [req.params.id, req.user.sub, note]);
    if (!o) return res.status(404).json({ error: "Application not found or already reviewed." });
    await audit(null, req.user.sub, "organiser.reject", "organiser", req.params.id, null, { note });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Event approval: nothing is public until an admin approves ----------
r.get("/admin/events", ...admin, async (req, res) => {
  const { rows } = await q(
    `SELECT e.id, e.slug, e.title, e.status, e.starts_at, e.is_featured, o.org_name, v.city, v.name AS venue,
            (SELECT count(*)::int FROM ticket_categories c WHERE c.event_id=e.id) AS ticket_types
       FROM events e JOIN organisers o ON o.id=e.organiser_id LEFT JOIN venues v ON v.id=e.venue_id
      WHERE e.status = coalesce($1, e.status) ORDER BY e.created_at DESC LIMIT 200`, [req.query.status || null]);
  res.json({ events: rows });
});
r.post("/admin/events/:id/approve", ...admin, async (req, res, next) => {
  try {
    const { rows: [e] } = await q(`UPDATE events SET status='published', approved_by=$2, approved_at=now(), status_note=NULL WHERE id=$1 AND status='pending_approval' RETURNING id, slug`, [req.params.id, req.user.sub]);
    if (!e) return res.status(404).json({ error: "Event not found or not waiting for approval." });
    await audit(null, req.user.sub, "event.approve", "event", e.id);
    res.json({ ok: true, slug: e.slug });
  } catch (e) { next(e); }
});
r.post("/admin/events/:id/reject", ...admin, async (req, res, next) => {
  try {
    const { note } = noteSchema.parse(req.body);
    const { rows: [e] } = await q(`UPDATE events SET status='draft', status_note=$2 WHERE id=$1 AND status='pending_approval' RETURNING id`, [req.params.id, note]);
    if (!e) return res.status(404).json({ error: "Event not found or not waiting for approval." });
    await audit(null, req.user.sub, "event.reject", "event", e.id, null, { note });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
r.post("/admin/events/:id/feature", ...admin, async (req, res, next) => {
  try {
    const { featured } = z.object({ featured: z.boolean() }).parse(req.body);
    const { rowCount } = await q(`UPDATE events SET is_featured=$2 WHERE id=$1 AND status='published'`, [req.params.id, featured]);
    if (!rowCount) return res.status(404).json({ error: "Only published events can be featured." });
    await audit(null, req.user.sub, "event.feature", "event", req.params.id, null, { featured });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
export default r;
