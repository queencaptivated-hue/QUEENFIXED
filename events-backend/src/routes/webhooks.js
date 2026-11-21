import { Router } from "express";
import { q } from "../db.js";
import { gateways } from "../payments/index.js";
import { refreshPayment } from "../services/fulfil.js";
import { sha256 } from "../lib/ticketqr.js";

// Mounted with express.raw(): signatures are computed over the exact raw bytes.
const r = Router();

async function handle(res, eventId, payload, findPayment) {
  const ins = await q(`INSERT INTO payment_webhook_events(gateway_event_id, payload) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING gateway_event_id`, [eventId, payload]);
  if (!ins.rowCount) {
    const { rows: [e] } = await q(`SELECT processed_at FROM payment_webhook_events WHERE gateway_event_id=$1`, [eventId]);
    if (e?.processed_at) return res.json({ ok: true, duplicate: true });
  }
  const pay = await findPayment();
  // The webhook is only a nudge: we re-check with the gateway before issuing tickets.
  if (pay) await refreshPayment(pay);
  await q(`UPDATE payment_webhook_events SET processed_at=now() WHERE gateway_event_id=$1`, [eventId]);
  res.json({ ok: true });
}

r.post("/razorpay", async (req, res, next) => {
  try {
    const raw = req.body.toString("utf8");
    if (!gateways.razorpay.verifyWebhookSignature(raw, req.headers["x-razorpay-signature"])) return res.status(400).json({ error: "bad signature" });
    const ev = JSON.parse(raw);
    const orderId = ev?.payload?.payment?.entity?.order_id || ev?.payload?.order?.entity?.id;
    const id = req.headers["x-razorpay-event-id"] || "rzp:" + sha256(raw);
    await handle(res, id, ev, async () => orderId && (await q(`SELECT * FROM payments WHERE gateway='razorpay' AND gateway_order_id=$1`, [orderId])).rows[0]);
  } catch (e) { next(e); }
});

r.post("/cashfree", async (req, res, next) => {
  try {
    const raw = req.body.toString("utf8");
    const ts = req.headers["x-webhook-timestamp"];
    if (!gateways.cashfree.verifyWebhookSignature(raw, req.headers["x-webhook-signature"], ts)) return res.status(400).json({ error: "bad signature" });
    const ev = JSON.parse(raw);
    const orderId = ev?.data?.order?.order_id; // "qc_<payments.id>"
    await handle(res, "cf:" + sha256(ts + raw), ev, async () => orderId && (await q(`SELECT * FROM payments WHERE gateway='cashfree' AND gateway_order_id=$1`, [orderId])).rows[0]);
  } catch (e) { next(e); }
});

export default r;
