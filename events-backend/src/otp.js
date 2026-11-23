import crypto from "crypto";
import nodemailer from "nodemailer";

export const normaliseTarget = (raw) => {
  const t = String(raw || "").trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t) && t.length <= 254) return { kind: "email", value: t.toLowerCase() };
  const digits = t.replace(/[\s\-()]/g, "").replace(/^(\+91|91|0)(?=\d{10}$)/, "");
  if (/^[6-9]\d{9}$/.test(digits)) return { kind: "mobile", value: digits };
  return null;
};
export const newCode = () => String(crypto.randomInt(100000, 1000000));
export const hashCode = (target, code) => crypto.createHmac("sha256", process.env.EVENTS_JWT_SECRET).update(`${target}:${code}`).digest("hex");
export const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// OTP_MODE=console prints the code to the server log (development only).
// Email uses SMTP_URL (e.g. smtps://user:pass@smtp.example.com). SMS needs a provider; see README.
export async function deliver(target, code) {
  const text = `Your Queen Captivated verification code is ${code}. It expires in 10 minutes. Never share it with anyone.`;
  if (process.env.OTP_MODE === "console" && process.env.NODE_ENV !== "production") { console.log(`[OTP] ${target.value}: ${code}`); return; }
  if (target.kind === "email") {
    if (!process.env.SMTP_URL) throw Object.assign(new Error("Email sending isn’t set up yet."), { status: 503 });
    await nodemailer.createTransport(process.env.SMTP_URL).sendMail({ from: process.env.MAIL_FROM || "Queen Captivated <no-reply@queencaptivated.in>", to: target.value, subject: "Your verification code", text });
    return;
  }
  throw Object.assign(new Error("Mobile OTP isn’t set up yet. Please use email."), { status: 503 });
}
