import crypto from "crypto";

// QR content = "<ticketId>.<signature>". No personal data. Signature is an HMAC so QR codes can't be forged,
// and it can be regenerated any time from the ticket id (for PDF re-downloads).
const sig = (id) => crypto.createHmac("sha256", process.env.TICKET_QR_SECRET).update(id).digest("base64url").slice(0, 22);
export const makeTicketQr = (ticketId) => `${ticketId}.${sig(ticketId)}`;
export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function parseTicketQr(s) {
  const [id, mac] = String(s || "").split(".");
  if (!id || !mac) return null;
  const a = Buffer.from(mac), b = Buffer.from(sig(id));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? id : null;
}
export const newReference = () => "QCE-" + crypto.randomBytes(5).toString("hex").toUpperCase();
