import crypto from "crypto";
import { tx, q } from "../db.js";
import { gateways } from "../payments/index.js";
import { makeTicketQr, sha256 } from "../lib/ticketqr.js";

// THE only place tickets are issued. Called after server-side verification (gateway lookup or human approval).
// Idempotent: calling twice for the same payment issues tickets once.
export async function confirmPayment(paymentId, o) {
  return tx(async (c) => {
    const { rows: [pay] } = await c.query(`SELECT * FROM payments WHERE id=$1 FOR UPDATE`, [paymentId]);
    if (!pay) throw Object.assign(new Error("Payment not found"), { status: 404 });
    if (pay.status === "captured") return { already: true, bookingId: pay.ref_id };

    const { rows: [b] } = await c.query(`SELECT * FROM bookings WHERE id=$1 FOR UPDATE`, [pay.ref_id]);
    if (o.amountPaise !== b.total_paise || pay.amount_paise !== b.total_paise) {
      await c.query(`UPDATE payments SET status='failed', gateway_meta = coalesce(gateway_meta,'{}'::jsonb) || $2::jsonb WHERE id=$1`,
        [paymentId, JSON.stringify({ error: "amount_mismatch", got: o.amountPaise, expected: b.total_paise })]);
      return { mismatch: true, bookingId: b.id };
    }
    const { rows: items } = await c.query(`SELECT * FROM booking_items WHERE booking_id=$1`, [b.id]);

    let lateRefund = false;
    if (b.status === "pending_payment") {
      for (const it of items) await c.query(`SELECT confirm_tickets($1,$2)`, [it.category_id, it.qty]);
    } else if (b.status === "expired") {
      // Paid after the hold lapsed: try to re-take the stock; otherwise queue an automatic refund.
      const taken = [];
      for (const it of items) {
        const { rows: [r] } = await c.query(`SELECT reserve_tickets($1,$2) AS ok`, [it.category_id, it.qty]);
        if (!r.ok) { lateRefund = true; break; }
        taken.push(it);
      }
      if (lateRefund) for (const it of taken) await c.query(`SELECT release_tickets($1,$2,false)`, [it.category_id, it.qty]);
      else for (const it of items) await c.query(`SELECT confirm_tickets($1,$2)`, [it.category_id, it.qty]);
    } else if (b.status === "confirmed") {
      return { already: true, bookingId: b.id };
    } else {
      lateRefund = true;
    }

    await c.query(
      `UPDATE payments SET status='captured', verified_at=now(), gateway_payment_id=$2, method=$3, gateway_fee_paise=$4, gateway_meta=$5 WHERE id=$1`,
      [paymentId, o.gatewayPaymentId, o.method ?? null, o.feePaise ?? null, JSON.stringify(o.raw ?? {})]);

    if (lateRefund) {
      await c.query(`INSERT INTO refunds(payment_id, booking_id, amount_paise, reason, status) VALUES ($1,$2,$3,'Paid after reservation expired and tickets sold out','requested')`,
        [paymentId, b.id, b.total_paise]);
      return { needsRefund: true, bookingId: b.id };
    }

    await c.query(`UPDATE bookings SET status='confirmed', hold_expires_at=NULL WHERE id=$1`, [b.id]);
    for (const it of items) {
      const { rows: [cat] } = await c.query(`SELECT event_id FROM ticket_categories WHERE id=$1`, [it.category_id]);
      for (let i = 0; i < it.qty; i++) {
        const id = crypto.randomUUID();
        await c.query(`INSERT INTO tickets(id, booking_id, category_id, event_id, qr_token_hash) VALUES ($1,$2,$3,$4,$5)`,
          [id, b.id, it.category_id, cat.event_id, sha256(makeTicketQr(id))]);
      }
    }

    // Ledger: commission is read from the admin-configured rates (never hardcoded).
    const { rows: [ev] } = await c.query(`SELECT organiser_id FROM events WHERE id=$1`, [b.event_id]);
    const { rows: [rate] } = await c.query(
      `SELECT rate_bps FROM commission_rates WHERE service='ticket' AND effective_from <= now()
       ORDER BY (organiser_id = $1) DESC NULLS LAST, effective_from DESC LIMIT 1`, [ev.organiser_id]);
    const bps = rate?.rate_bps ?? 0;
    const base = b.subtotal_paise - b.discount_paise;
    const commission = Math.round((base * bps) / 10000) + b.service_fee_paise;
    const gwFee = o.feePaise ?? 0;
    await c.query(
      `INSERT INTO ledger_entries(payment_id, service, payee_type, payee_id, gross_paise, gateway_fee_paise, commission_bps_applied, commission_paise, net_payable_paise, collected_by)
       VALUES ($1,'ticket','organiser',$2,$3,$4,$5,$6,$7,$8)`,
      [paymentId, ev.organiser_id, b.total_paise, gwFee, bps, commission, b.total_paise - gwFee - commission, pay.collected_by]);

    if (b.profile_id) await c.query(`INSERT INTO notifications(profile_id, channel, template, payload) VALUES ($1,'email','booking_confirmed',$2),($1,'sms','booking_confirmed',$2)`,
      [b.profile_id, JSON.stringify({ reference: b.reference })]);
    return { confirmed: true, bookingId: b.id };
  });
}

// Ask the gateway what happened, and confirm only if it says paid. Safe to call repeatedly.
export async function refreshPayment(payment) {
  const gw = gateways[payment.gateway];
  if (!gw || !payment.gateway_order_id || payment.status === "captured") return { skipped: true };
  const out = await gw.fetchOutcome(payment.gateway_order_id);
  if (!out.paid) return { paid: false };
  return confirmPayment(payment.id, out);
}

// Releases stock for abandoned checkouts. Run every minute.
export async function expireHolds() {
  const { rows } = await q(`SELECT id FROM bookings WHERE status='pending_payment' AND hold_expires_at < now() LIMIT 50`);
  for (const { id } of rows) {
    await tx(async (c) => {
      const { rows: [b] } = await c.query(
        `SELECT * FROM bookings WHERE id=$1 AND status='pending_payment' AND hold_expires_at < now() FOR UPDATE SKIP LOCKED`, [id]);
      if (!b) return;
      const { rows: items } = await c.query(`SELECT * FROM booking_items WHERE booking_id=$1`, [id]);
      for (const it of items) await c.query(`SELECT release_tickets($1,$2,false)`, [it.category_id, it.qty]);
      if (b.coupon_id) await c.query(`UPDATE coupons SET used_count = GREATEST(used_count-1,0) WHERE id=$1`, [b.coupon_id]);
      await c.query(`UPDATE bookings SET status='expired' WHERE id=$1`, [id]);
    });
  }
}
