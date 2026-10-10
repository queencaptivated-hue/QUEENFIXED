import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import "./db/index.js";

import authRoutes from "./routes/auth.js";
import driverRoutes from "./routes/driver.js";
import passengerRoutes from "./routes/passenger.js";
import adminRoutes from "./routes/admin.js";
import sharedRoutes from "./routes/shared.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

if (!process.env.JWT_SECRET) {
  // Without a secret every login would crash with a 500. Fall back to a random
  // per-boot secret (users must log in again after a restart) and say so loudly.
  process.env.JWT_SECRET = (await import("crypto")).randomBytes(32).toString("hex");
  console.warn("[warn] JWT_SECRET is not set - using a temporary random secret. Set JWT_SECRET in your environment.");
}

// FRONTEND_ORIGIN may be "*", one URL, or a comma-separated list. Trailing
// slashes are ignored so "https://site.vercel.app/" still matches the browser's Origin.
const allowedOrigins = (process.env.FRONTEND_ORIGIN || "*")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);
app.use(
  cors({
    origin: allowedOrigins.includes("*")
      ? true
      : (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
  })
);
app.use(express.json({ limit: "10mb" })); // generous limit for base64 document/photo uploads
app.use(morgan("dev"));

app.get("/api/health", (req, res) => res.json({ status: "ok", ok: true, company: "QUEEN CAPTIVATED" }));

app.use("/api/auth", authRoutes);
app.use("/api/driver", driverRoutes);
app.use("/api/passenger", passengerRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api", sharedRoutes);

app.use("/api", (req, res) => res.status(404).json({ error: "Route not found." }));

// ── Serve the marketing site (queencaptivated.com) at "/" ────────────
const marketingDir = path.join(__dirname, "..", "public-site");
if (fs.existsSync(marketingDir)) {
  app.use(express.static(marketingDir));
}

// ── Serve the Car Rental app (React SPA) under "/car-rental" ─────────
const carRentalDir = path.join(__dirname, "..", "public", "car-rental");
if (fs.existsSync(carRentalDir)) {
  app.use("/car-rental", express.static(carRentalDir));
  // SPA fallback so client-side routes like /car-rental/login,
  // /car-rental/passenger, etc. reload correctly.
  app.get("/car-rental/*", (req, res) => {
    res.sendFile(path.join(carRentalDir, "index.html"));
  });
}

// Fallback 404 for anything else not matched above
app.use((req, res) => {
  const notFoundPage = path.join(marketingDir, "404.html");
  if (fs.existsSync(notFoundPage)) return res.status(404).sendFile(notFoundPage);
  res.status(404).send("Not found");
});

// Centralized error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`QUEEN CAPTIVATED API running on http://localhost:${PORT}`);
});
