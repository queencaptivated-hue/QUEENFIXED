-- 003: OTP login, organiser onboarding, event publishing. Additive.
BEGIN;
SET search_path = qc_events, public;
ALTER TABLE otp_codes  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX idx_otp_target ON otp_codes (target, created_at DESC);
ALTER TABLE organisers ADD COLUMN bank_last4 TEXT;      -- bank_account_ref holds the AES-256-GCM encrypted details
ALTER TABLE organisers ADD COLUMN review_note TEXT;
CREATE UNIQUE INDEX uq_organiser_profile ON organisers (profile_id);   -- one organiser account per login
ALTER TABLE events     ADD COLUMN video_url TEXT;
CREATE INDEX idx_events_slug ON events (slug);
COMMIT;
