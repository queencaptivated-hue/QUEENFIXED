import crypto from "crypto";

// AES-256-GCM for bank details. BANK_ENC_KEY = 64 hex chars (32 bytes). Never logged, never returned by any API.
function key() {
  const k = process.env.BANK_ENC_KEY || "";
  if (!/^[0-9a-fA-F]{64}$/.test(k)) throw Object.assign(new Error("Server is missing BANK_ENC_KEY."), { status: 500 });
  return Buffer.from(k, "hex");
}
export function encryptJson(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
export function decryptJson(b64) {
  const raw = Buffer.from(b64, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
}
export const slugify = (t) => String(t).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "event";
export const slugWithSuffix = (t) => `${slugify(t)}-${crypto.randomBytes(3).toString("hex")}`;
export const csvCell = (v) => {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stops spreadsheet formula injection from attendee-entered text
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
