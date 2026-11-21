import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import { q, tx } from "../db.js";
import { requireAuth, audit } from "../auth.js";
import { availableMethods, gateways } from "../payments/index.js";
import { refreshPayment } from "../services/fulfil.js";
import { makeTicketQr, newReference } from "../lib/ticketqr.js";
import { putImage } from "../storage.js";

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });
const HOLD = () => Number(process.env.HOLD_MINUTES || 15);

const checkoutSchema = z.object({
  event_id: z.string().uuid(),
  items: z.array(z.object({ category_id: z.string().uuid(), qty: z.number().int().min(1).max(20) })).min(1).max(8),
  coupon_code: z.string().trim().max(40).optional(),
  idempotency_key: z.string().min(8).max(80),
});

// 1) Reserve tickets + price the order. Every number is computed here from the database.
r.post("/checkout", requireAuth, async (req, res, next) => {
  try {
    const body = checkoutSchema.parse(req.body);
    const existing = await q(`SELECT * FROM bookings WHERE idempotency_key=$1 AND profile_id=$2`, [body.idempotency_key, req.user.sub]);
    if (existing.rowCount) return res.json({ booking: existing.rows[0], methods: await methodsFor(existing.rows[0].event_id) });

    const booking = await tx(async (c) => {
      const { rows: [ev] } = await c.query(`SELECT id, status, approved_at, starts_at FROM events WHERE id=$1`, [body.event_id]);
      if (!ev || ev.status !== "published" || !ev.approved_at) throw Object.assign(new Error("This event isn’t open for booking."), { status: 409 });
      if (new Date(ev.starts_at) < new Date()) throw Object.assign(new Error("This event has already started."), { status: 409 });

      const merged = new Map();
      for (const it of body.items) merged.set(it.category_id, (merged.get(it.category_id) || 0) + it.qty);
      const ids = [...merged.keys()].sort(); // fixed lock order avoids deadlocks
      const { rows: cats } = await c.query(`SELECT id, name, price_paise FROM ticket_categories WHERE id = ANY($1) AND event_id=$2`, [ids, body.event_id]);
      if (cats.length !== ids.length) throw Object.assign(new Error("Unknown ticket type."), { status: 400 });

      let subtotal = 0;
      for (const cat of cats) {
        const qty = merged.get(cat.id);
        const { rows: [res1] } = await c.query(`SELECT reserve_tickets($1,$2) AS ok`, [cat.id, qty]);
        if (!res1.ok) throw Object.assign(new Error(`Not enough “${cat.name}” tickets left.`), { status: 409 });
        subtotal += cat.price_paise * qty;
      }

      let discount = 0, couponId = null;
      if (body.coupon_code) {
        const { rows: [cp] } = await c.query(
          `UPDATE coupons SET used_count = used_count + 1
           WHERE code=$1 AND is_active AND (event_id IS NULL OR event_id=$2) AND (max_uses IS NULL OR used_count < max_uses)
             AND (valid_from IS NULL OR valid_from <= now()) AND (valid_until IS NULL OR valid_until >= now())
           RETURNING id, discount_type, discount_value`, [body.coupon_code, body.event_id]);
        if (!cp) throw Object.assign(new Error("That coupon isn’t valid."), { status: 400 });
        couponId = cp.id;
        discount = Math.min(subtotal, cp.discount_type === "percent_bps" ? Math.round((subtotal * cp.discount_value) / 10000) : cp.discount_value);
      }
      const { rows: [fee] } = await c.query(`SELECT service_fee_bps FROM commission_rates WHERE service='ticket' AND effective_from <= now() ORDER BY effective_from DESC LIMIT 1`);
      const serviceFee = Math.round(((subtotal - discount) * (fee?.service_fee_bps ?? 0)) / 10000);
      const total = subtotal - discount + serviceFee;
      if (total <= 0) throw Object.assign(new Error("Free and complimentary tickets are issued by the organiser or box office."), { status: 400 });

      const { rows: [b] } = await c.query(
        `INSERT INTO bookings(reference, event_id, profile_id, subtotal_paise, discount_paise, service_fee_paise, total_paise, coupon_id, idempotency_key, hold_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + ($10 || ' minutes')::interval) RETURNING *`,
        [newReference(), body.event_id, req.user.sub, subtotal, discount, serviceFee, total, couponId, body.idempotency_key, String(HOLD())]);
      for (const cat of cats) await c.query(`INSERT INTO booking_items(booking_id, category_id, qty, unit_price_paise) VALUES ($1,$2,$3,$4)`, [b.id, cat.id, merged.get(cat.id), cat.price_paise]);
      return b;
    });
    res.status(201).json({ booking, methods: await methodsFor(booking.event_id) });
  } catch (e) { next(e); }
});

async function methodsFor(eventId) {
  const { rows: [ev] } = await q(`SELECT organiser_id FROM events WHERE id=$1`, [eventId]);
  return availableMethods(ev.organiser_id);
}

async function ownBooking(req, id) {
  const { rows: [b] } = await q(`SELECT * FROM bookings WHERE id=$1 AND profile_id=$2`, [id, req.user.sub]);
  if (!b) throw Object.assign(new Error("Booking not found."), { status: 404 });
  return b;
}

// 2) Pick a payment method.
r.post("/bookings/:id/pay", requireAuth, async (req, res, next) => {
  try {
    const { provider } = z.object({ provider: z.enum(["razorpay", "cashfree", "upi_qr"]) }).parse(req.body);
    const b = await ownBooking(req, req.params.id);
    if (b.status !== "pending_payment" || new Date(b.hold_expires_at) < new Date()) throw Object.assign(new Error("This reservation has expired. Please start again."), { status: 409 });
    const method = (await methodsFor(b.event_id)).find((m) => m.code === provider);
    if (!method) throw Object.assign(new Error("That payment method isn’t available."), { status: 400 });
    const { rows: [me] } = await q(`SELECT id, full_name AS name, email, mobile FROM profiles WHERE id=$1`, [req.user.sub]);

    const { rows: [pay] } = await q(
      `INSERT INTO payments(service, ref_id, profile_id, gateway, amount_paise, collected_by) VALUES ('ticket',$1,$2,$3,$4,$5) RETURNING *`,
      [b.id, req.user.sub, provider, b.total_paise, provider === "upi_qr" ? method.collected_by : "platform"]);

    if (provider === "upi_qr") {
      await q(`UPDATE bookings SET hold_expires_at = now() + ($2 || ' minutes')::interval WHERE id=$1 AND hold_expires_at < now() + ($2 || ' minutes')::interval`, [b.id, String(HOLD() * 2)]);
      const { rows: [qr] } = await q(`SELECT id, upi_id, payee_name FROM payment_qr_codes WHERE id=$1`, [method.qr_code_id]);
      const link = `upi://pay?pa=${encodeURIComponent(qr.upi_id)}&pn=${encodeURIComponent(qr.payee_name || "Queen Captivated")}&am=${(b.total_paise / 100).toFixed(2)}&cu=INR&tn=${b.reference}`;
      return res.json({ payment_id: pay.id, provider, qr_image_url: `${process.env.API_PUBLIC_URL}/api/events/payment-qr/${qr.id}/image`, upi_id: qr.upi_id, amount_paise: b.total_paise, note: b.reference, upi_link: link,
        next: "After paying, submit your UTR / transaction reference. Tickets are issued once the payment is verified." });
    }
    const gw = gateways[provider];
    if (provider === "cashfree" && !me.mobile) throw Object.assign(new Error("Add a mobile number to your profile to pay with Cashfree."), { status: 400 });
    const { gatewayOrderId, clientPayload } = await gw.createOrder({ payment: pay, booking: b, customer: me });
    await q(`UPDATE payments SET gateway_order_id=$2 WHERE id=$1`, [pay.id, gatewayOrderId]);
    res.json({ payment_id: pay.id, provider, ...clientPayload });
  } catch (e) { next(e); }
});

// 3) Customer returns from the gateway (or polls). We ask the gateway directly; the browser’s word is never enough.
r.post("/bookings/:id/refresh", requireAuth, async (req, res, next) => {
  try {
    const b = await ownBooking(req, req.params.id);
    const sig = req.body?.razorpay_signature;
    if (sig) {
      if (!gateways.razorpay.verifyCheckoutSignature({ order_id: req.body.razorpay_order_id, payment_id: req.body.razorpay_payment_id, signature: sig }))
        throw Object.assign(new Error("Payment signature check failed."), { status: 400 });
    }
    const { rows } = await q(`SELECT * FROM payments WHERE ref_id=$1 AND service='ticket' AND gateway IN ('razorpay','cashfree') AND status<>'captured' ORDER BY created_at DESC LIMIT 3`, [b.id]);
    for (const p of rows) await refreshPayment(p);
    res.json(await bookingView(req, b.id));
  } catch (e) { next(e); }
});

async function bookingView(req, id) {
  const { rows: [b] } = await q(`SELECT id, reference, event_id, status, subtotal_paise, discount_paise, service_fee_paise, total_paise, hold_expires_at FROM bookings WHERE id=$1 AND profile_id=$2`, [id, req.user.sub]);
  if (b.status !== "confirmed") {
    const { rows: [claim] } = await q(`SELECT status FROM manual_payment_claims WHERE booking_id=$1 ORDER BY created_at DESC LIMIT 1`, [id]);
    return { booking: b, tickets: [], upi_claim_status: claim?.status ?? null };
  }
  const { rows: t } = await q(`SELECT t.id, t.status, c.name AS category FROM tickets t JOIN ticket_categories c ON c.id=t.category_id WHERE t.booking_id=$1`, [id]);
  return { booking: b, tickets: t.map((x) => ({ ...x, qr: makeTicketQr(x.id) })) };
}
r.get("/bookings/:id", requireAuth, async (req, res, next) => { try { await ownBooking(req, req.params.id); res.json(await bookingView(req, req.params.id)); } catch (e) { next(e); } });

// UPI QR flow: customer submits the UTR (and optional screenshot) after paying.
r.post("/bookings/:id/upi-claim", requireAuth, upload.single("screenshot"), async (req, res, next) => {
  try {
    const { utr, payment_id } = z.object({ utr: z.string().trim().regex(/^[A-Za-z0-9]{8,30}$/, "Enter the UTR / transaction ID (8–30 letters and numbers)."), payment_id: z.string().uuid() }).parse(req.body);
    const b = await ownBooking(req, req.params.id);
    const { rows: [pay] } = await q(`SELECT * FROM payments WHERE id=$1 AND ref_id=$2 AND gateway='upi_qr' AND status='created'`, [payment_id, b.id]);
    if (!pay) throw Object.assign(new Error("Payment not found."), { status: 404 });
    const { rows: [ev] } = await q(`SELECT organiser_id FROM events WHERE id=$1`, [b.event_id]);
    const { activeQr } = await import("../payments/index.js");
    const qr = await activeQr(ev.organiser_id);
    if (!qr) throw Object.assign(new Error("UPI QR payments are unavailable right now."), { status: 409 });
    const shot = req.file ? await putImage(req.file.buffer, "claims", { maxWidth: 1400 }) : null;
    try {
      await tx(async (c) => {
        await c.query(`INSERT INTO manual_payment_claims(payment_id, booking_id, qr_code_id, utr, screenshot_key) VALUES ($1,$2,$3,$4,$5)`, [pay.id, b.id, qr.id, utr, shot]);
        await c.query(`UPDATE bookings SET hold_expires_at = now() + ($2 || ' minutes')::interval WHERE id=$1 AND status='pending_payment'`, [b.id, String(process.env.UPI_CLAIM_HOLD_MINUTES || 360)]);
        await audit(c, req.user.sub, "upi_claim.submit", "booking", b.id, null, { utr_last4: utr.slice(-4) });
      });
    } catch (e) { if (e.code === "23505") throw Object.assign(new Error("That UTR has already been submitted."), { status: 409 }); throw e; }
    res.status(201).json({ status: "pending", message: "Thanks. We’ll issue your tickets as soon as the payment is verified." });
  } catch (e) { next(e); }
});

export default r;
