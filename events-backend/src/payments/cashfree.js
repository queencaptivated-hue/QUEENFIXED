import crypto from "crypto";

const API_VERSION = "2025-01-01";
const base = () => (process.env.CASHFREE_ENV === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg");
export const configured = () => !!(process.env.CASHFREE_CLIENT_ID && process.env.CASHFREE_CLIENT_SECRET);

async function cf(path, opts = {}) {
  const r = await fetch(base() + path, {
    ...opts,
    headers: { "x-client-id": process.env.CASHFREE_CLIENT_ID, "x-client-secret": process.env.CASHFREE_CLIENT_SECRET, "x-api-version": API_VERSION, "Content-Type": "application/json" },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Cashfree: ${j?.message || r.status}`);
  return j;
}

// order_id = our payments.id (unique, idempotent). Cashfree needs a customer phone.
export async function createOrder({ payment, booking, customer }) {
  const o = await cf("/orders", {
    method: "POST",
    body: JSON.stringify({
      order_id: `qc_${payment.id}`,
      order_amount: Number((booking.total_paise / 100).toFixed(2)),
      order_currency: "INR",
      customer_details: { customer_id: customer.id.replace(/-/g, "").slice(0, 40), customer_phone: customer.mobile, customer_email: customer.email || undefined, customer_name: customer.name },
      order_meta: { return_url: `${process.env.FRONTEND_ORIGIN}/events/booking/${booking.reference}?cf_order_id={order_id}`, notify_url: `${process.env.API_PUBLIC_URL}/api/events/webhooks/cashfree` },
      order_note: booking.reference,
    }),
  });
  return { gatewayOrderId: o.order_id, clientPayload: { payment_session_id: o.payment_session_id, env: process.env.CASHFREE_ENV === "production" ? "production" : "sandbox" } };
}

// Webhook signature: base64(HMAC-SHA256(secret, timestamp + rawBody)) per Cashfree docs.
export function verifyWebhookSignature(rawBody, signature, timestamp) {
  if (!signature || !timestamp) return false;
  const exp = crypto.createHmac("sha256", process.env.CASHFREE_CLIENT_SECRET).update(String(timestamp) + rawBody).digest("base64");
  const a = Buffer.from(exp), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function fetchOutcome(gatewayOrderId) {
  const order = await cf(`/orders/${encodeURIComponent(gatewayOrderId)}`);
  if (order.order_status !== "PAID") return { paid: false };
  const pays = await cf(`/orders/${encodeURIComponent(gatewayOrderId)}/payments`);
  const ok = (Array.isArray(pays) ? pays : []).find((p) => p.payment_status === "SUCCESS");
  if (!ok) return { paid: false };
  return { paid: true, gatewayPaymentId: String(ok.cf_payment_id), amountPaise: Math.round(Number(ok.payment_amount) * 100), method: Object.keys(ok.payment_method || {})[0] || null, raw: { cf_payment_id: ok.cf_payment_id, status: ok.payment_status } };
}

export async function refund(gatewayOrderId, amountPaise, refundId) {
  const r = await cf(`/orders/${encodeURIComponent(gatewayOrderId)}/refunds`, { method: "POST", body: JSON.stringify({ refund_amount: Number((amountPaise / 100).toFixed(2)), refund_id: refundId }) });
  return r.cf_refund_id ? String(r.cf_refund_id) : refundId;
}
