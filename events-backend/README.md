# Queen Captivated Events API (payments + UPI QR slice)

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
