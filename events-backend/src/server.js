import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { q, qRead } from "./db.js";
import checkout from "./routes/checkout.js";
import paymentAdmin from "./routes/paymentAdmin.js";
import webhooks from "./routes/webhooks.js";
import auth from "./routes/auth.js";
import organiser from "./routes/organiser.js";
import adminEvents from "./routes/adminEvents.js";
import publicEvents from "./routes/publicEvents.js";
import { expireHolds } from "./services/fulfil.js";

for (const k of ["DATABASE_URL", "EVENTS_JWT_SECRET", "TICKET_QR_SECRET", "BANK_ENC_KEY", "API_PUBLIC_URL"]) {
  if (!process.env[k]) { console.error(`Missing required env var ${k}`); process.exit(1); } // fail loudly, never run with weak defaults
}
const app = express();
app.set("trust proxy", 1);
app.use(helmet());
const origins = (process.env.FRONTEND_ORIGIN || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
app.use(cors({ origin: (o, cb) => cb(null, !o || origins.includes(o)) }));
app.use(morgan("combined"));

// Webhooks need the raw body for signature checks, so they are mounted before express.json().
app.use("/api/events/webhooks", express.raw({ type: "*/*", limit: "1mb" }), webhooks);
app.use(express.json({ limit: "100kb" }));
app.use("/api/events", rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
app.use("/api/events/auth/otp", rateLimit({ windowMs: 15 * 60_000, limit: Number(process.env.OTP_IP_LIMIT || 100), standardHeaders: true, legacyHeaders: false }));  // per IP; each email/number is also capped at 5 codes/hour
app.use("/api/events/bookings/:id/pay", rateLimit({ windowMs: 60_000, limit: 10 }));
app.use("/api/events/bookings/:id/upi-claim", rateLimit({ windowMs: 60_000, limit: 5 }));

app.get("/api/health", async (_req, res) => {
  try { await q("SELECT 1"); await qRead("SELECT 1"); res.json({ ok: true, service: "events" }); } catch { res.status(503).json({ ok: false }); }
});
app.use("/api/events", auth);
app.use("/api/events", publicEvents);
app.use("/api/events", organiser);
app.use("/api/events", adminEvents);
app.use("/api/events", checkout);
app.use("/api/events", paymentAdmin);
app.use("/api", (_req, res) => res.status(404).json({ error: "Route not found." }));

app.use((err, _req, res, _next) => {
  if (err?.name === "ZodError") return res.status(400).json({ error: err.issues[0]?.message || "Invalid input." });
  if (err?.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "File is too large (max 4 MB)." });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? "Something went wrong on our side." : err.message });
});

setInterval(() => expireHolds().catch((e) => console.error("expireHolds", e)), 60_000);
app.listen(process.env.PORT || 4100, "0.0.0.0", () => console.log("Events API up"));
