-- 002: multiple payment providers + uploadable UPI QR codes. Additive; run after 001_schema.sql.
BEGIN;
SET search_path = qc_events, public;

-- Which payment options customers see. Secrets (API keys) live in env vars, never in this table.
CREATE TABLE payment_providers (
  code          TEXT PRIMARY KEY CHECK (code IN ('razorpay','cashfree','upi_qr')),
  display_name  TEXT NOT NULL,
  is_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order    INT NOT NULL DEFAULT 0,
  updated_by    UUID REFERENCES profiles(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO payment_providers(code, display_name, sort_order) VALUES
  ('razorpay','Razorpay (UPI, cards, net banking)',1),
  ('cashfree','Cashfree (UPI, cards, net banking)',2),
  ('upi_qr','Pay by UPI QR code',3);

-- Uploaded UPI QR images. Platform-owned (admin) or organiser-owned.
CREATE TABLE payment_qr_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type    TEXT NOT NULL CHECK (owner_type IN ('platform','organiser')),
  organiser_id  UUID REFERENCES organisers(id),
  upi_id        TEXT NOT NULL,             -- VPA decoded from the QR itself (pa=...)
  payee_name    TEXT,
  image_key     TEXT NOT NULL,             -- R2 object key
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  uploaded_by   UUID NOT NULL REFERENCES profiles(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((owner_type = 'organiser') = (organiser_id IS NOT NULL))
);
CREATE UNIQUE INDEX uq_active_qr_platform  ON payment_qr_codes ((1)) WHERE owner_type='platform' AND is_active;
CREATE UNIQUE INDEX uq_active_qr_organiser ON payment_qr_codes (organiser_id) WHERE owner_type='organiser' AND is_active;

-- Customer says "I paid" -> must be verified by an authorised person. UTR is unique so it can't be reused.
CREATE TABLE manual_payment_claims (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id     UUID NOT NULL UNIQUE REFERENCES payments(id),
  booking_id     UUID NOT NULL REFERENCES bookings(id),
  qr_code_id     UUID NOT NULL REFERENCES payment_qr_codes(id),
  utr            TEXT NOT NULL,
  screenshot_key TEXT,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by    UUID REFERENCES profiles(id),
  reviewed_at    TIMESTAMPTZ,
  review_note    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT utr_format CHECK (utr ~ '^[A-Za-z0-9]{8,30}$')
);
CREATE UNIQUE INDEX uq_claim_utr ON manual_payment_claims (upper(utr));

-- Who actually received the money (affects settlement maths).
ALTER TABLE payments       ADD COLUMN collected_by TEXT NOT NULL DEFAULT 'platform' CHECK (collected_by IN ('platform','organiser'));
ALTER TABLE ledger_entries ADD COLUMN collected_by TEXT NOT NULL DEFAULT 'platform' CHECK (collected_by IN ('platform','organiser'));
ALTER TABLE payments       ADD COLUMN gateway_meta JSONB;
COMMIT;
