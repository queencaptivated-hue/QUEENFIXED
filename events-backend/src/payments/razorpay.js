import crypto from "crypto";

const base = "https://api.razorpay.com/v1";
const auth = () => "Basic " + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
export const configured = () => !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

async function rz(path, opts = {}) {
  const r = await fetch(base + path, { ...opts, headers: { Authorization: auth(), "Content-Type": "application/json" } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Razorpay: ${j?.error?.description || r.status}`);
  return j;
}

// Creates the gateway order. Amount always comes from our database, never from the browser.
export async function createOrder({ payment, booking }) {
  const o = await rz("/orders", {
    method: "POST",
    body: JSON.stringify({ amount: booking.total_paise, currency: "INR", receipt: booking.reference, notes: { booking: booking.reference, payment_id: payment.id } }),
  });
  return { gatewayOrderId: o.id, clientPayload: { key_id: process.env.RAZORPAY_KEY_ID, order_id: o.id, amount: o.amount, currency: "INR", name: "Queen Captivated Events", description: booking.reference } };
}

// Checkout-callback signature (necessary, not sufficient: we still fetch the payment from Razorpay).
export function verifyCheckoutSignature({ order_id, payment_id, signature }) {
  const exp = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(`${order_id}|${payment_id}`).digest("hex");
  return safeEq(exp, String(signature || ""));
}
export function verifyWebhookSignature(rawBody, signature) {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) return false;
  const exp = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest("hex");
  return safeEq(exp, String(signature || ""));
}
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Source of truth: ask Razorpay what happened to this order.
export async function fetchOutcome(gatewayOrderId) {
  const list = await rz(`/orders/${encodeURIComponent(gatewayOrderId)}/payments`);
  const ok = (list.items || []).find((p) => p.status === "captured");
  if (!ok) return { paid: false };
  return { paid: true, gatewayPaymentId: ok.id, amountPaise: ok.amount, method: ok.method, feePaise: ok.fee ?? null, raw: { id: ok.id, method: ok.method, status: ok.status } };
}

export async function refund(gatewayPaymentId, amountPaise) {
  const r = await rz(`/payments/${encodeURIComponent(gatewayPaymentId)}/refund`, { method: "POST", body: JSON.stringify({ amount: amountPaise }) });
  return r.id;
}
