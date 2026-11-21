import * as razorpay from "./razorpay.js";
import * as cashfree from "./cashfree.js";
import { q } from "../db.js";

export const gateways = { razorpay, cashfree };

// Providers a customer may use right now: enabled in admin AND credentials present in env (upi_qr needs an active QR).
export async function availableMethods(organiserId) {
  const { rows } = await q(`SELECT code, display_name FROM payment_providers WHERE is_enabled ORDER BY sort_order`);
  const out = [];
  for (const p of rows) {
    if (p.code === "upi_qr") {
      const qr = await activeQr(organiserId);
      if (qr) out.push({ ...p, qr_code_id: qr.id, upi_id: qr.upi_id, collected_by: qr.owner_type });
    } else if (gateways[p.code]?.configured()) out.push(p);
  }
  return out;
}

// Organiser's own QR wins over the platform QR when present.
export async function activeQr(organiserId) {
  const { rows } = await q(
    `SELECT * FROM payment_qr_codes WHERE is_active AND ((owner_type='organiser' AND organiser_id=$1) OR owner_type='platform')
     ORDER BY (owner_type='organiser') DESC LIMIT 1`, [organiserId]);
  return rows[0] || null;
}
