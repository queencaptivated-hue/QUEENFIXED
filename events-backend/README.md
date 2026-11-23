# Queen Captivated Events API (login, organisers, events, payments, UPI QR)

Separate Render web service. Does not touch the existing car-rental, homestay or products services.

## Run
1. Create a Render **Postgres** database, set `DATABASE_URL` and the other vars from `.env.example`.
2. `npm install && npm run migrate && npm start` (health check: `GET /api/health`).
3. Render Blueprint entry (add to render.yaml): `type: web`, `name: queen-captivated-events-api`, `rootDir: events-backend`,
   `buildCommand: npm install`, `startCommand: npm run migrate && npm start`, `healthCheckPath: /api/health`.

## Payment options (admin chooses which are live)
| Code | How it works | Needs |
|---|---|---|
| `razorpay` | Gateway order; confirmed by server lookup + signed webhook | `RAZORPAY_*` keys; webhook URL `/api/events/webhooks/razorpay` |
| `cashfree` | Gateway order; confirmed by server lookup + signed webhook | `CASHFREE_*` keys; webhook URL `/api/events/webhooks/cashfree` |
| `upi_qr` | Customer pays an uploaded UPI QR, submits UTR, reviewer approves | An uploaded QR |

Tickets are issued in ONE place (`services/fulfil.js`) and only after the gateway confirms the payment (never from the browser) or a reviewer approves a UPI claim.

## Endpoints
Customer: `POST /api/events/checkout` · `POST /bookings/:id/pay {provider}` · `POST /bookings/:id/refresh` · `GET /bookings/:id` · `POST /bookings/:id/upi-claim` (multipart: utr, payment_id, optional screenshot)
Admin: `GET|PATCH /admin/payment-providers[/:code]` · `POST /admin/payment-qr` (multipart `image`) · `DELETE /admin/payment-qr/:id`
Organiser: `POST /organiser/payment-qr` · Reviewers (admin or the organiser who owns the QR): `GET /claims` · `POST /claims/:id/approve {amount_received_paise}` · `POST /claims/:id/reject {note}`
Public: `GET /payment-qr/:id/image` · Gateways: `POST /webhooks/razorpay|cashfree`

## QR upload rules
JPG/PNG/WebP up to 4 MB. The image must contain a UPI payment QR (`upi://pay`); the UPI ID is read from the QR itself, fixed-amount QRs are rejected, the image is re-encoded and stored privately in R2.

## Login, organisers, events (added in migration 003)
- **Login:** `POST /api/events/auth/otp/request {target}` then `POST /auth/otp/verify {target, code, full_name?}` returns a token. Email OTP needs `SMTP_URL`. Mobile (SMS) OTP needs an SMS provider that isn't chosen yet. `GET /me`, `GET /me/bookings` (My Tickets).
- **First admin:** put your email in `ADMIN_BOOTSTRAP_EMAILS`, log in with an email code. There are no default passwords.
- **Organiser:** `POST /organiser/register` (multipart, documents + bank details; bank details are AES-256-GCM encrypted with `BANK_ENC_KEY`). Admin: `GET /admin/organisers`, `POST /admin/organisers/:id/approve|reject`, documents at `/admin/organisers/:id/documents/:n`; full bank details only for super admin and audit-logged.
- **Events:** `POST /organiser/events`, `PATCH /organiser/events/:id`, `POST .../poster`, `.../gallery`, `.../ticket-categories`, `POST .../submit`, `.../postpone`, `.../cancel` (queues refunds), `GET .../sales`, `GET .../attendees.csv`. Admin: `GET /admin/events`, `POST /admin/events/:id/approve|reject|feature`.
- **Public (no login):** `GET /public` (search: q, category, city, date, date_from, date_to, featured, page), `GET /public/categories`, `GET /public/calendar?month=YYYY-MM`, `GET /public/:slug`, images at `/media/events/:file`.
- Nothing is public until an admin approves it. Documents and QR-claim screenshots are never served publicly.

## Using a different database (not only Render)
The events service runs on **any PostgreSQL 13+ database**: Render, Neon, Supabase, AWS RDS/Aurora, Google Cloud SQL, Azure, DigitalOcean, Railway, or your own server. The service only needs `DATABASE_URL`.

**To switch (or add) a database**
1. Create the new PostgreSQL database with your provider and copy its connection URL.
2. On your computer or the Render shell, run `DATABASE_URL="<new url>" npm run db:check`. It tells you PASS/FAIL for the version, SSL, required extensions (`citext`, `pgcrypto`, `btree_gist`) and permissions.
3. **New, empty database:** `DATABASE_URL="<new url>" npm run migrate` creates every table.
   **Moving existing data:** `pg_dump -Fc --no-owner "<old url>" > events.dump`, then `pg_restore --no-owner -d "<new url>" events.dump`. Do this during a quiet period, with the service paused, so no booking is lost.
4. In Render (or wherever the service runs) change `DATABASE_URL` to the new URL and redeploy. Keep the old database untouched for a few days in case you need to roll back.

**Provider notes**
- Behind a pooler (PgBouncer, Neon or Supabase "pooled" URL): set `DB_SEARCH_PATH_MODE=database` and put the provider's direct (non-pooled) URL in `MIGRATION_DATABASE_URL`. `npm run migrate` then sets the schema as the database default.
- Strict certificate checking: `DATABASE_SSL=verify` plus `DATABASE_CA_CERT` (the provider's CA certificate text).
- Many users: raise `DB_POOL_MAX`, but keep (copies of the service x `DB_POOL_MAX`) below your plan's connection limit.
- **Read replica:** set `DATABASE_READ_URL` and public browsing (search, categories, calendar) reads from it. Bookings, payments, stock and event details always use the main database.

**Not supported:** MySQL, MongoDB, SQLite and other engines. Ticket stock and payments depend on PostgreSQL transactions and functions, so changing engine would mean rewriting the data layer.
