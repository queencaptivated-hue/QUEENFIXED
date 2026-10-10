# Deployment guide (fixed)

## What was wrong and what changed
| Problem | Cause | Fix |
|---|---|---|
| Vercel: `bash scripts/vercel-build.sh` exited with **127** (command not found) | The shell script is fragile: Windows CRLF line endings, a wrong Root Directory, or devDependencies (vite) skipped by `NODE_ENV=production` all end in 127 | Build now runs a Node script (`scripts/vercel-build.mjs`) that installs dev deps explicitly and calls Vite directly. `.gitattributes` keeps shell scripts LF. `vercel.json` uses `node scripts/vercel-build.mjs`. |
| Homestay login: "data not found" | The browser kept an old login token, but Render's free disk resets the database on restart, so the account no longer existed (`/api/account/me` -> 404). Also the page pointed at a placeholder backend URL unless `HOMESTAY_API_URL` was set | Stale sessions are cleared automatically and the person is asked to log in again. Clear "server not connected / waking up" messages. Optional sample data (`SEED_DEMO_DATA`). |
| Render deploy errors | Placeholder CORS origin, forced `PORT=4000`, no Node version pinned (native `better-sqlite3` needs a supported Node), random admin password you never saw | `render.yaml` pins Node 22, lets Render set `PORT`, uses `ALLOWED_ORIGIN="*"` until you tighten it, and asks you to type your existing admin password (`sync: false`). Servers no longer crash if `JWT_SECRET` is missing, and CORS ignores trailing slashes. |
| Car-rental logo broken under `/car-rental/` | Absolute `/logo.jpg` path | Uses `BASE_URL`. |

Backend passwords were **not changed**: car-rental admin is still seeded as `9999999999` / `Admin@123`; homestay and products admins use whatever `ADMIN_INITIAL_PASSWORD` you set (defaults unchanged when unset).

## Vercel
1. If your GitHub repo has this project inside a sub-folder, set **Settings -> General -> Root Directory** to that folder (the folder that contains `vercel.json`). A wrong Root Directory is the most common cause of exit code 127.
2. Do **not** override the Build Command / Output Directory in the Vercel UI; `vercel.json` handles them.
3. Add Environment Variables (then redeploy):
   - `VITE_API_URL` = `https://<your-car-api>.onrender.com/api`
   - `HOMESTAY_API_URL` = `https://<your-homestay-api>.onrender.com`
   - `PRODUCTS_API_URL` = `https://<your-products-api>.onrender.com`
4. Node version: 20.19+ / 22 (set in Settings -> General -> Node.js Version).

## Render
1. New -> Blueprint -> pick the repo (also set the Root Directory if the repo nests the project).
2. When prompted, type your **existing** `ADMIN_INITIAL_PASSWORD` for the homestay and products services.
3. After the first deploy, set `ALLOWED_ORIGIN` / `FRONTEND_ORIGIN` to your Vercel URL.
4. **Free plan = database resets on every restart/deploy.** Hosts, guests and bookings are lost. For real use, add a persistent Disk (paid) and set `DATABASE_PATH` / `DB_FILE` to a path on it, then delete `SEED_DEMO_DATA`.
5. Free services sleep after 15 min idle; the first request can take ~1 minute (the apps now say so).

## Nostalgic "Memory Lane" look
Files: `frontend/marketing/nostalgia.css` + `nostalgia.js` (also copied into `frontend/car-rental/src/`). A switch (bottom-left) turns it on/off; it is skipped for visitors who prefer reduced motion.
