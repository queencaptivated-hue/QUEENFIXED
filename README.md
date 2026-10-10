# Queen Captivated — Full Website (Frontend + Backend)

This package has **both** the frontend and the backend, laid out as separate
top-level folders:

```
queen-captivated-website/
├── vercel.json           Deploys the frontend (marketing + car-rental + homestay) to Vercel
├── amplify.yml            Same, but for AWS Amplify Hosting (alternative to Vercel)
├── render.yaml            Deploys the three backend APIs to Render
├── scripts/vercel-build.sh    Build script vercel.json calls
├── scripts/amplify-build.sh    Build script amplify.yml calls (same logic)
├── frontend/
│   ├── marketing/        Static site source: index.html, cookies.html,
│   │                     disclaimer.html, privacy.html — plain HTML/CSS,
│   │                     no build step needed.
│   ├── car-rental/       Full React (Vite) source for the Car Rental app —
│   │                     edit and rebuild this to change that app.
│   └── homestay/         Single-file static app (index.html) for the
│                         Homestay/Hotel booking site — no build step needed.
├── backend/               Car Rental API (Express + SQLite, ESM)
│   ├── src/
│   ├── public-site/       Pre-built copy of frontend/marketing, ready to serve
│   ├── public/car-rental/ Pre-built copy of frontend/car-rental, ready to serve
│   ├── .env.example
│   ├── Dockerfile
│   └── package.json
├── products-backend/      AI Products API (Express + SQLite, CommonJS) — stores the
│   ├── src/                products the admin manages; powers ai-products.html
│   ├── .env.example
│   └── package.json
└── homestay-backend/      Homestay/Hotel API (Express + SQLite, CommonJS) —
    ├── src/                a separate app with its own dependencies; deploys
    ├── uploads/             as its own service (room photos + QR code land here)
    ├── .env.example
    └── package.json
```

**`backend/public-site` and `backend/public/car-rental` are already-built,
ready-to-host copies of the two frontend apps** — so you can deploy `backend/`
by itself right now without running any build step for those two. The
homestay app (`frontend/homestay/index.html`) is a single static file with no
build step at all — it just needs its backend URL set, covered in section 4.

---

## ⚠️ Default admin login

Running `npm run seed` (see step 1) creates one super admin account so you can
log in on day one:

| Field | Value |
|---|---|
| URL | `/car-rental/login` (choose "Admin" login) |
| Mobile number | `9999999999` |
| Password | `Admin@123` |

Login is 2-factor: after the password, an OTP is required. Since no real SMS
provider is wired up yet (see section 7), the OTP is printed to the server
console **and** returned in the API response as `devOtp` — check either place.

**Change this password immediately after your first login**, before giving
out the URL to anyone else — this is a well-known default and is not safe to
leave in place on a live site.

The **AI Products manager** has its own admin login too:

| Field | Value |
|---|---|
| URL | `/ai-products-admin.html` |
| Email | `executive@queencaptivated.in` |
| Password | Locally: `change-this-immediately` (from `.env.example`). On Render: auto-generated — see that service's **Environment** tab (`ADMIN_INITIAL_PASSWORD`) or its **Logs** tab on first boot. |

Change it from the dashboard (**Change password**) straight after your first login.

The **Homestay/Hotel app** has its own separate admin login:

| Field | Value |
|---|---|
| URL | `/homestay/` (choose "Admin" tab) |
| Email | `executive@queencaptivated.in` |
| Password | Printed to the server console the very first time it starts (look for a line starting `[db] Seeded settings row...`) — on Render, check that service's **Logs** tab after its first deploy, or the `ADMIN_INITIAL_PASSWORD` value under its **Environment** tab (Render auto-generates a random one; it isn't the literal placeholder from `.env.example`) |

Same rule applies — log in and change it immediately (Admin → Payment QR & settings).

---

## 1. Run it immediately (frontend already built-in)

```bash
cd backend
npm install
cp .env.example .env        # edit values, especially JWT_SECRET
npm run seed                # creates the DB + the super admin account above
npm start                   # http://localhost:4000
```

Visit:
- `http://localhost:4000/` — marketing site (with the updated "Our Services" section)
- `http://localhost:4000/car-rental` — car rental app (landing, login, booking, dashboards)
- `http://localhost:4000/api/health` — API health check

The seed script prints the super admin's mobile number and password.
**Log in at `/car-rental/login` and change that password before going live.**

The **AI Products API** is another separate service:
```bash
cd products-backend
npm install
cp .env.example .env        # set JWT_SECRET; set ALLOWED_ORIGIN to wherever you serve the site
npm start                   # http://localhost:4000 (change PORT if another backend is running)
```
Serve `frontend/marketing/` with any static server and open `ai-products.html` /
`ai-products-admin.html`. When the page is opened from `localhost` and the API
address has not been configured, it automatically talks to `http://localhost:4000`.

The **Homestay/Hotel app** is a separate service — run it alongside:
```bash
cd homestay-backend
npm install
cp .env.example .env        # edit values, especially JWT_SECRET
npm start                   # http://localhost:4000 — pick a different PORT
                             # in .env if you're running both backends locally
                             # at once, since both default to 4000
```
Then open `frontend/homestay/index.html` directly in a browser, or set
`window.QC_API_BASE` (see section 2) to point it at whichever port you chose.

---

## 2. Editing the frontend and rebuilding

### Marketing site (`frontend/marketing/`)
Plain HTML files — edit directly, then copy them into the backend's serving folder:
```bash
cp frontend/marketing/*.html backend/public-site/
```

### Car Rental app (`frontend/car-rental/`)
React + Vite source. To rebuild and update the live copy:
```bash
cd frontend/car-rental
npm install
npm run build                          # outputs to dist/, base path is /car-rental/
rm -rf ../../backend/public/car-rental
cp -r dist ../../backend/public/car-rental
```

### Homestay/Hotel app (`frontend/homestay/index.html`)
A single static HTML file — edit it directly, no build step. Its backend URL
is controlled by one line near the top of the `<script>` block:
```js
window.QC_API_BASE = "https://your-homestay-backend.onrender.com";
```
For local editing just change that line to your local backend's URL (e.g.
`http://localhost:4001` if you picked a different port). **Don't commit your
real production URL here** — `scripts/vercel-build.sh` injects it
automatically at deploy time from the `HOMESTAY_API_URL` environment
variable, so leave the placeholder in place when committing to Git.

---

### AI Products (`frontend/marketing/ai-products.html` + `ai-products-admin.html`)
Plain static pages, no build step. They talk to `products-backend/` using one line near
the bottom of each page:
```js
window.QC_PRODUCTS_API = "https://your-products-backend.onrender.com";
```
Leave that placeholder in Git — `scripts/vercel-build.sh` / `scripts/amplify-build.sh`
replace it at deploy time from the **`PRODUCTS_API_URL`** environment variable (bare URL,
no `/api` suffix). If it is not set, the pages show a clear "not configured" message.

**How the admin uses it:** open `/ai-products-admin.html` → sign in → *Add New Product*.
Fields: name, category, short + full description, key features (one per line), image,
logo, product URL, button text, status (Available / Coming Soon / Beta), order, plus
*Published* and *Featured* switches. Images can be pasted as links or uploaded (they are
resized in the browser and stored in the database). Published products show up on
`/ai-products.html` immediately; featured products always come first. Visitors never see
admin controls — the only trace is a small "Admin" link in that page's footer that leads
to the sign-in form, and a "Manage products" button that appears only for a signed-in admin.

## 3. Get this project onto GitHub (no VS Code, no terminal required)

Both Vercel and Render deploy from a Git repository, not a local folder, so
this has to happen first. Here's the no-terminal way using **GitHub Desktop**:

1. **Install GitHub Desktop**: go to [desktop.github.com](https://desktop.github.com),
   download it, install it, and sign in with your GitHub account (create one
   at [github.com](https://github.com) first if you don't have one).
2. **Create the repository**: in GitHub Desktop, go to **File → New Repository**.
   - Name: `queen-captivated-website` (or anything you like)
   - Local Path: choose a folder — this is where GitHub Desktop will keep the
     project
   - Leave "Initialize with a README" unchecked (this project already has one)
   - Click **Create Repository**
3. **Copy the project files in**: unzip the downloaded project and copy
   *everything inside* `queen-captivated-website/` (the `frontend` folder,
   `backend` folder, `homestay-backend` folder, `products-backend` folder, `README.md`, `vercel.json`,
   `render.yaml`, `scripts/`, `.gitignore` — all of it) into the folder you
   just picked in step 2, replacing/merging as needed so the repo folder now
   contains those files directly (not nested in another
   `queen-captivated-website` subfolder).
4. **Review changes**: switch back to GitHub Desktop. It will automatically
   detect all the new files and list them under "Changes" on the left —
   this is normal, it hasn't uploaded anything yet.
   - Check the file list briefly: you should **not** see any `node_modules`
     folders, `.env` file, or `.sqlite` files listed — the `.gitignore`
     already included in this project keeps those out automatically.
5. **Commit**: at the bottom left, type a summary like
   `Initial commit — Queen Captivated website` and click **Commit to main**.
6. **Publish**: click the **Publish repository** button in the top toolbar.
   - Choose whether it's Public or Private (Private is fine — both Vercel
     and Render can deploy from private repos once you connect your account)
   - Click **Publish Repository**

### Verify it worked
Go to [github.com](https://github.com), open your profile → **Your
repositories**, click into the new repo, and confirm you see the `frontend/`,
`backend/`, `homestay-backend/` and `products-backend/` folders, `vercel.json`, `render.yaml`,
and `README.md` at the top level — and that there's **no** `.env` file or
`node_modules` folder listed anywhere.

---

## 4. Deploy to Vercel + Render

This is the setup this repo is configured for out of the box: **frontend on
Vercel, both backend APIs on Render**, talking over HTTPS. All three config
files (`vercel.json`, `render.yaml`, `scripts/vercel-build.sh`) are already
at the repo root and tested against the exact commands below.

### Step 1 — Deploy the backends to Render
1. In Render: **New → Blueprint**, select this repo. Render reads
   `render.yaml` automatically and creates **three** web services (the third is
   `queen-captivated-products-api` from `products-backend/`, for AI Products):
   `queen-captivated-api` (car rental) from `backend/`, and
   `queen-captivated-homestay-api` (homestay/hotel) from `homestay-backend/`.
2. Click through to create both. Render generates a random `JWT_SECRET` for
   each service, and a random `ADMIN_INITIAL_PASSWORD` for the homestay one.
3. Once deployed, copy both service URLs Render gives you, e.g.
   `https://queen-captivated-api.onrender.com` and
   `https://queen-captivated-homestay-api.onrender.com`.
4. Confirm both are alive: visit `https://<url>/api/health` for each — you
   should see a small JSON `{"ok":true,...}` or `{"status":"ok",...}` response.
5. For the homestay service, open its **Logs** tab and find the line
   `[db] Seeded settings row. Initial admin password: "..."` — that's your
   one-time admin password (see "Default admin login" above).

> Free-plan note: Render's free web services have an ephemeral filesystem, so
> each SQLite database resets on every deploy/restart. Fine for testing; for
> a real launch, upgrade the relevant service and attach a persistent disk
> (there's a commented-out `disk:` block for each in `render.yaml`), or move
> to a hosted Postgres — see section 7.

### Step 2 — Deploy the frontend to Vercel
1. In Vercel: **New Project**, import this repo. Vercel reads `vercel.json`
   at the repo root automatically — no need to change the Root Directory
   setting.
2. Before the first deploy, add two **Environment Variables** in the Vercel
   project settings:
   - `VITE_API_URL` = `https://<your-car-rental-api-url>/api`
   - `PRODUCTS_API_URL` = `https://<your-products-api-url>` (no `/api` suffix)
   - `HOMESTAY_API_URL` = `https://<your-homestay-api-url>` (no `/api` suffix
     here — the homestay app adds its own `/api/...` paths)
3. Deploy. Vercel runs `scripts/vercel-build.sh`, which builds the React app,
   injects the homestay backend URL, and combines everything with the
   marketing pages into one static site.
4. Visit your Vercel URL:
   - `/` — marketing site
   - `/car-rental` — the car rental app, talking to its Render backend
   - `/homestay` — the homestay/hotel app, talking to its own Render backend
   - `/ai-products.html` — the AI Products page (shows an empty state until the admin adds products)
   - `/ai-products-admin.html` — admin sign-in for managing those products

### Step 3 — Connect them (CORS)
Back in Render, set on **each** service's environment variables:
- `queen-captivated-api` → `FRONTEND_ORIGIN` = your Vercel URL
- `queen-captivated-homestay-api` → `ALLOWED_ORIGIN` = your Vercel URL
- `queen-captivated-products-api` → `ALLOWED_ORIGIN` = your Vercel URL

Save each — Render redeploys automatically, and both backends will now accept
requests from your live frontend. (They're placeholders pointing at
`your-frontend.vercel.app` in `render.yaml` until you do this.)

That's it — every push to your repo's main branch redeploys all three
services automatically.

---

## 5. Deploy to AWS Amplify + Render (alternative to Vercel)

Same idea as section 4, but hosting the frontend on **AWS Amplify Hosting**
instead of Vercel. The backends still go on Render either way — Amplify
Hosting is built for static/SSR frontends, not long-running Node processes
with a local SQLite file, so it isn't a fit for `backend/` or
`homestay-backend/` as they're written. `amplify.yml` and
`scripts/amplify-build.sh` are already in this repo and tested.

### Step 1 — Deploy both backends to Render
Identical to Step 1 in section 4 — do that first, you need both Render URLs
before setting up Amplify.

### Step 2 — Create the Amplify app
1. AWS Console → **Amplify** → **New app** → **Host web app**.
2. Connect GitHub, authorize AWS Amplify, pick this repo and branch.
3. Amplify detects `amplify.yml` at the repo root automatically — leave the
   build settings as detected, don't let the console overwrite it with an
   auto-generated one.
4. Before deploying, go to **App settings → Environment variables** and add:
   - `VITE_API_URL` = `https://<your-car-rental-api-url>/api`
   - `HOMESTAY_API_URL` = `https://<your-homestay-api-url>` (no `/api` suffix)
   - `PRODUCTS_API_URL` = `https://<your-products-api-url>` (no `/api` suffix)
5. Click **Save and deploy**.

### Step 3 — Add the car-rental SPA routing rule
The car-rental app uses client-side routing (React Router), so direct visits
or refreshes on pages like `/car-rental/login` need a rewrite rule, or
Amplify will 404 them. The marketing site and homestay app don't need this —
they're plain multi-page/single-file static content.

In the Amplify console: **App settings → Rewrites and redirects → Manage
rewrites and redirects → open the JSON editor** and add:
```json
[
  {
    "source": "</^\\/car-rental(\\/[^.]*)?$|^\\/car-rental\\/.*\\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+)$/>",
    "status": "200",
    "target": "/car-rental/index.html",
    "condition": null
  }
]
```
This is AWS's own documented SPA-rewrite pattern, scoped to only the
`/car-rental` path so it doesn't interfere with the rest of the site. **Test
it after deploying** by visiting `https://<your-amplify-url>/car-rental/login`
directly (not by clicking through from the homepage) — that's the case this
rule exists for. If it 404s or the page loads blank/broken, replace the rule
above with these more explicit ones instead (functionally equivalent, just
spelled out one asset type at a time instead of one regex):
```json
[
  { "source": "/car-rental/assets/<*>", "status": "200", "target": "/car-rental/assets/<*>", "condition": null },
  { "source": "/car-rental/favicon.svg", "status": "200", "target": "/car-rental/favicon.svg", "condition": null },
  { "source": "/car-rental/icons.svg", "status": "200", "target": "/car-rental/icons.svg", "condition": null },
  { "source": "/car-rental/logo.jpg", "status": "200", "target": "/car-rental/logo.jpg", "condition": null },
  { "source": "/car-rental/<*>", "status": "200", "target": "/car-rental/index.html", "condition": null }
]
```

### Step 4 — Connect them (CORS)
Same as section 4's Step 3 — in Render, set `FRONTEND_ORIGIN` (on
`queen-captivated-api`) and `ALLOWED_ORIGIN` (on both
`queen-captivated-homestay-api` and `queen-captivated-products-api`) to your Amplify URL, e.g.
`https://main.d1234abcd.amplifyapp.com`.

### Verify
- `https://<your-amplify-url>/` — marketing site
- `https://<your-amplify-url>/car-rental/login` — loads directly (not just by
  clicking through), confirming the rewrite rule works
- `https://<your-amplify-url>/homestay/` — homestay app loads and can reach
  its backend (try registering a test account)
- `https://<your-amplify-url>/ai-products-admin.html` — sign in, add a test product, then
  confirm it appears on `/ai-products.html` (and the **Products ▸ AI Product** menu item works)

---

## 6. Other ways to deploy

**Single service, one host, no CORS setup** (alternative to Vercel for the
marketing site + car rental app specifically): deploy the `backend/` folder
as-is to any Node host. It already serves the marketing site, the car rental
app, and the car-rental API all from one process/port, since
`backend/public-site` and `backend/public/car-rental` are pre-built into
the repo.

**The homestay app always needs its own backend process**, deployed
separately, regardless of which option below you pick for the rest of the
site — point `frontend/homestay/index.html`'s `window.QC_API_BASE` (or the
`HOMESTAY_API_URL` build variable, if using `scripts/vercel-build.sh`) at
wherever you deploy `homestay-backend/`.

- **Render (single service instead of the split, for backend/)**: build
  command `npm install`, start command `npm start`, set env vars from
  `backend/.env.example`. No `FRONTEND_ORIGIN`/`VITE_API_URL` juggling needed.
- **Railway / Fly.io**: same idea for either backend — build `npm install`,
  start `npm start`.
- **VPS**: upload the backend folder(s), `npm install`, run any one-time
  seed step, then `npm start` under `pm2`/`systemd`, with Nginx/Caddy in
  front for TLS.
- **Docker** — both backends have a `Dockerfile`:
  ```bash
  # Car rental API
  docker build -t queen-captivated-api backend/
  docker run -p 4000:4000 --env-file backend/.env -v $(pwd)/data:/app/data queen-captivated-api

  # AI Products API
  docker build -t queen-captivated-products-api products-backend/
  docker run -p 4002:4000 --env-file products-backend/.env -v $(pwd)/products-data:/app/data -e DATABASE_PATH=/app/data/data.sqlite queen-captivated-products-api

  # Homestay API
  docker build -t queen-captivated-homestay-api homestay-backend/
  docker run -p 4001:4000 --env-file homestay-backend/.env -v $(pwd)/homestay-data:/app/uploads queen-captivated-homestay-api
  ```

> `better-sqlite3` is a native module in both backends — run `npm install` on
> the target platform (or inside its Docker build) rather than copying
> `node_modules` over. Both Dockerfiles use a glibc-based image
> (`node:20-bookworm-slim`), not Alpine — `better-sqlite3`'s prebuilt binary
> isn't built for Alpine's musl libc and will crash on boot (`Aborted (core
> dumped)`) if run on it. The car rental Dockerfile seeds the database
> automatically on every boot (`npm run seed && node src/server.js`); the
> homestay one seeds itself on first boot without a separate step.

### Deploying via Docker on Render specifically
If you pick **Docker** as the Language when creating a Render web service
(instead of Node), Render builds and runs the matching `Dockerfile` directly
— the Build Command / Start Command fields disappear because the Dockerfile
defines both. Everything else is the same as the Blueprint/Node path:
- Root Directory: `backend`, `homestay-backend` or `products-backend`, same as before
- Environment Variables: same table as section 4, added the same way
- `render.yaml`'s Blueprint path pins `runtime: node` for both services (not
  Docker), so it sidesteps this entirely — Docker-as-language only comes up
  if you create the services manually and pick it yourself

---

## 7. Before going live

| Item | Where | Notes |
|---|---|---|
| `JWT_SECRET` (car rental) | `backend/.env` | Replace the placeholder with a long random string (Render generates this for you) |
| Super admin password (car rental) | seeded via `npm run seed` | Default is `9999999999` / `Admin@123` — see "Default admin login" above. Change it after first login |
| SMS OTP provider | `backend/src/utils/otp.js` | Currently mocked (`OTP_MODE=dev`); wire up a real provider and set `OTP_MODE=live` |
| Road distance/ETA | `backend/src/utils/distance.js` | Currently a haversine straight-line estimate; swap in Google Maps Directions API |
| Database persistence | Render dashboard / `backend/.env` → `DB_FILE` | SQLite resets on Render's free plan on every deploy — attach a persistent disk (paid plan) or swap `backend/src/db/index.js` for Postgres/MySQL |
| `JWT_SECRET` (homestay) | `homestay-backend/.env` | Replace the placeholder (Render generates this for you) |
| Admin password (homestay) | `homestay-backend/.env` → `ADMIN_INITIAL_PASSWORD` | Only used on first boot — Render generates a random one; retrieve it from that service's Logs or Environment tab, then change it from Admin → Payment QR & settings |
| Payment QR code (homestay) | Admin → Payment QR & settings, in the app itself | Upload your real UPI/payment QR so hosts can settle commission |
| Database persistence (homestay) | Render dashboard / `homestay-backend/.env` → `DATABASE_PATH` | Same caveat as above — SQLite resets on the free plan |
| **AI Products database persistence** | Render dashboard → `queen-captivated-products-api` | **Important:** on Render's free plan the SQLite file is wiped on every redeploy/restart, so products the admin adds will disappear. Before relying on it, attach a persistent disk (paid plan — commented block in `render.yaml`) and point `DATABASE_PATH` at it, or move to a hosted database. Uploaded product images live in the same database, so they follow the same rule. |
| `JWT_SECRET` / admin password (AI Products) | `products-backend/.env` | Render generates both; change the admin password from the dashboard after first login |
| `ALLOWED_ORIGIN` (AI Products) | `queen-captivated-products-api` env vars | Must equal your live site URL exactly (no trailing slash), otherwise the admin page can't sign in |
| Room photo storage (homestay) | `homestay-backend/uploads/` | Stored on local disk by default — attach a persistent disk on Render, or migrate to Cloudflare R2/S3 for real scale |
