// Builds the combined static site for Vercel: marketing pages + the
// car-rental React app + the homestay app, all into one output directory.
//
// This is a Node script (not bash) on purpose:
//  * it can't break on Windows CRLF line endings (which make bash report
//    "command not found", exit code 127),
//  * it doesn't depend on `vite` being on PATH - it calls Vite's JS entry directly,
//  * it works the same on Vercel, Netlify, AWS Amplify and your own laptop.
//
// Environment variables (set in Vercel -> Project -> Settings -> Environment Variables):
//   VITE_API_URL       car-rental backend, e.g. https://queen-captivated-api.onrender.com/api
//   HOMESTAY_API_URL   homestay backend,   e.g. https://queen-captivated-homestay-api.onrender.com
//   PRODUCTS_API_URL   products backend,   e.g. https://queen-captivated-products-api.onrender.com

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = path.join(ROOT, "frontend");
const OUT = path.join(FRONTEND, process.env.BUILD_OUT_DIR || ".vercel-output");
const CAR = path.join(FRONTEND, "car-rental");

const log = (m) => console.log(`[build] ${m}`);
const warn = (m) => console.warn(`[build] WARNING: ${m}`);

function run(cmd, args, cwd) {
  log(`${cmd} ${args.join(" ")}   (in ${path.relative(ROOT, cwd) || "."})`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`"${cmd} ${args.join(" ")}" failed with exit code ${r.status}`);
}

// Strip trailing slashes and an optional trailing "/api".
const cleanBase = (u) => String(u || "").trim().replace(/\/+$/, "").replace(/\/api$/i, "");

function replaceInFile(file, placeholder, value) {
  if (!fs.existsSync(file)) return;
  const src = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, src.split(placeholder).join(value));
}

function main() {
  for (const needed of [FRONTEND, CAR, path.join(FRONTEND, "marketing"), path.join(FRONTEND, "homestay")]) {
    if (!fs.existsSync(needed)) {
      throw new Error(
        `Missing folder: ${needed}\n` +
          `If your GitHub repo contains this project inside another folder, set Vercel -> Settings -> General -> "Root Directory" to that folder.`
      );
    }
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, "car-rental"), { recursive: true });
  fs.mkdirSync(path.join(OUT, "homestay"), { recursive: true });

  // 1. Marketing site (plain static files, no build step)
  for (const f of fs.readdirSync(path.join(FRONTEND, "marketing"))) {
    fs.cpSync(path.join(FRONTEND, "marketing", f), path.join(OUT, f), { recursive: true });
  }

  // 2. Car Rental app (React/Vite). devDependencies (vite, tailwind) are REQUIRED to build,
  //    so force them on even if NODE_ENV=production / NPM_CONFIG_PRODUCTION is set.
  run("npm", ["install", "--include=dev", "--no-audit", "--no-fund"], CAR);
  const viteBin = path.join(CAR, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(viteBin)) throw new Error("vite was not installed - check the npm install output above.");
  run(process.execPath, [viteBin, "build"], CAR);
  fs.cpSync(path.join(CAR, "dist"), path.join(OUT, "car-rental"), { recursive: true });

  // 3. Homestay app (single static HTML file) - inject the real backend URL.
  const homestayOut = path.join(OUT, "homestay", "index.html");
  fs.cpSync(path.join(FRONTEND, "homestay", "index.html"), homestayOut);
  const homestayUrl = cleanBase(process.env.HOMESTAY_API_URL);
  if (homestayUrl) {
    replaceInFile(homestayOut, "https://your-homestay-backend.onrender.com", homestayUrl);
    log(`Homestay API -> ${homestayUrl}`);
  } else {
    warn("HOMESTAY_API_URL is not set. Homestay login/booking will show 'backend not configured'.");
  }

  // 4. AI Products pages - inject the Products API URL.
  const productsUrl = cleanBase(process.env.PRODUCTS_API_URL);
  if (productsUrl) {
    for (const f of ["ai-products.html", "ai-products-admin.html"]) {
      replaceInFile(path.join(OUT, f), "https://your-products-backend.onrender.com", productsUrl);
    }
    log(`Products API -> ${productsUrl}`);
  } else {
    warn("PRODUCTS_API_URL is not set. The AI Products pages will show a 'not configured' message.");
  }

  if (!process.env.VITE_API_URL) {
    warn("VITE_API_URL is not set. Car-rental login will show 'backend not configured'.");
  }

  log(`Build complete: ${path.relative(ROOT, OUT)}`);
}

try {
  main();
} catch (e) {
  console.error(`[build] FAILED: ${e.message}`);
  process.exit(1);
}
