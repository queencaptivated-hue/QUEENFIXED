-- QUEEN CAPTIVATED EVENTS & ENTERTAINMENT: Stage 1 schema (PostgreSQL 14+)
-- ADDITIVE ONLY: everything lives in schema "qc_events". No existing table is altered or dropped.
-- Runs on a NEW Render Postgres database (existing SQLite databases stay untouched). Existing accounts are linked via profile_identities.
-- All money is stored in paise (integer). Percentages are in basis points (100 bps = 1%) and come from commission_rates.
-- Run inside a transaction on a staging copy first: BEGIN; \i this_file.sql; ROLLBACK;

BEGIN;
CREATE SCHEMA IF NOT EXISTS qc_events;
SET search_path = qc_events, public;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- needed for equipment date-range overlap index

-- ---------- ENUMS ----------
CREATE TYPE approval_status AS ENUM ('draft','pending','approved','rejected','suspended');
CREATE TYPE event_status    AS ENUM ('draft','pending_approval','published','postponed','cancelled','completed');
CREATE TYPE booking_status  AS ENUM ('pending_payment','confirmed','cancelled','refunded','partially_refunded','expired');
CREATE TYPE ticket_status   AS ENUM ('valid','checked_in','cancelled','refunded');
CREATE TYPE payment_status  AS ENUM ('created','authorized','captured','failed','refunded','partially_refunded');
CREATE TYPE service_type    AS ENUM ('ticket','promotion','artist','equipment','planning');
CREATE TYPE enquiry_status  AS ENUM ('new','assigned','quoted','negotiating','confirmed','in_progress','completed','cancelled');

-- ---------- USERS, ROLES, PERMISSIONS ----------
-- Profile row is created lazily the first time an existing QC account uses the events module.
CREATE TABLE profiles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT UNIQUE,
  mobile        TEXT UNIQUE,
  full_name     TEXT NOT NULL,
  password_hash TEXT,                     -- only used if no existing account; argon2id/bcrypt, never plaintext
  email_verified_at TIMESTAMPTZ,
  mobile_verified_at TIMESTAMPTZ,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR mobile IS NOT NULL)
);
-- Links one events profile to accounts in the EXISTING systems (separate SQLite DBs, separate JWTs).
-- Matched by verified mobile/email; the existing databases are never written to.
CREATE TABLE profile_identities (
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('car_rental','homestay')),
  source_user_id TEXT NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_user_id)
);
CREATE TABLE roles (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL               -- customer, organiser, artist, vendor, event_staff, box_office, admin, super_admin
);
CREATE TABLE permissions (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,              -- e.g. event.approve, refund.issue, checkin.scan
  description TEXT
);
CREATE TABLE role_permissions (
  role_id INT REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INT REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);
CREATE TABLE profile_roles (
  profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  role_id INT REFERENCES roles(id),
  event_id UUID,                          -- optional: staff scoped to one event (FK added below)
  PRIMARY KEY (profile_id, role_id)
);
CREATE TABLE otp_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target TEXT NOT NULL,                   -- email or mobile
  code_hash TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

-- ---------- ORGANISERS, VENUES ----------
CREATE TABLE organisers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id),
  org_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  mobile TEXT NOT NULL,
  email CITEXT NOT NULL,
  address TEXT,
  business_info TEXT,
  kyc_doc_keys TEXT[],                    -- R2 object keys (private bucket), never public URLs
  bank_account_ref TEXT,                  -- gateway/vault token or encrypted blob, never raw account data in logs
  status approval_status NOT NULL DEFAULT 'pending',
  reviewed_by UUID REFERENCES profiles(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE venues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT,
  latitude NUMERIC(9,6),
  longitude NUMERIC(9,6),
  google_maps_url TEXT,
  capacity INT
);

-- ---------- EVENTS ----------
CREATE TABLE event_categories (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  sort_order INT DEFAULT 0
);
CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organiser_id UUID NOT NULL REFERENCES organisers(id),
  category_id INT REFERENCES event_categories(id),
  venue_id UUID REFERENCES venues(id),
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  poster_key TEXT,                        -- R2 key
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  capacity INT,
  status event_status NOT NULL DEFAULT 'draft',
  is_featured BOOLEAN NOT NULL DEFAULT FALSE,
  status_note TEXT,                       -- postponement / cancellation reason
  approved_by UUID REFERENCES profiles(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Rule: nothing becomes public without admin approval
  CHECK (status NOT IN ('published','postponed','completed') OR approved_at IS NOT NULL)
);
CREATE INDEX idx_events_public ON events (status, starts_at);
CREATE INDEX idx_events_search ON events USING gin (to_tsvector('simple', title || ' ' || coalesce(description,'')));
ALTER TABLE profile_roles ADD FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE;

CREATE TABLE event_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image','video')),
  object_key TEXT NOT NULL,
  thumb_key TEXT,
  sort_order INT DEFAULT 0
);
CREATE TABLE event_schedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  title TEXT NOT NULL,
  details TEXT
);

-- ---------- TICKET CATEGORIES & INVENTORY ----------
CREATE TABLE ticket_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                     -- general, premium, vip, couple, group, early_bird, student, complimentary
  name TEXT NOT NULL,
  price_paise INT NOT NULL CHECK (price_paise >= 0),
  admits INT NOT NULL DEFAULT 1,          -- people per ticket (couple=2, group=N)
  total_qty INT NOT NULL CHECK (total_qty >= 0),
  sold_qty  INT NOT NULL DEFAULT 0,
  held_qty  INT NOT NULL DEFAULT 0,       -- reserved during checkout
  sale_starts_at TIMESTAMPTZ,
  sale_ends_at   TIMESTAMPTZ,
  max_per_booking INT NOT NULL DEFAULT 10,
  -- DB-LEVEL OVERSELL GUARD: even buggy application code cannot break this
  CONSTRAINT no_oversell CHECK (sold_qty >= 0 AND held_qty >= 0 AND sold_qty + held_qty <= total_qty)
);

-- Atomic reservation: single UPDATE takes a row lock, so concurrent buyers serialise.
-- Returns TRUE if reserved, FALSE if not enough stock. Call inside the checkout transaction.
CREATE OR REPLACE FUNCTION reserve_tickets(p_category UUID, p_qty INT) RETURNS BOOLEAN AS $$
DECLARE n INT;
BEGIN
  UPDATE ticket_categories
     SET held_qty = held_qty + p_qty
   WHERE id = p_category
     AND p_qty > 0 AND p_qty <= max_per_booking
     AND total_qty - sold_qty - held_qty >= p_qty
     AND (sale_starts_at IS NULL OR sale_starts_at <= now())
     AND (sale_ends_at   IS NULL OR sale_ends_at   >= now());
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$ LANGUAGE plpgsql;

-- Convert hold to sale after VERIFIED payment (server/webhook only)
CREATE OR REPLACE FUNCTION confirm_tickets(p_category UUID, p_qty INT) RETURNS VOID AS $$
BEGIN
  UPDATE ticket_categories SET held_qty = held_qty - p_qty, sold_qty = sold_qty + p_qty
   WHERE id = p_category AND held_qty >= p_qty;
  IF NOT FOUND THEN RAISE EXCEPTION 'hold missing for category %', p_category; END IF;
END $$ LANGUAGE plpgsql;

-- Release hold on expiry/failure/cancel. A scheduled job expires bookings past hold_expires_at.
CREATE OR REPLACE FUNCTION release_tickets(p_category UUID, p_qty INT, p_was_sold BOOLEAN) RETURNS VOID AS $$
BEGIN
  IF p_was_sold THEN UPDATE ticket_categories SET sold_qty = sold_qty - p_qty WHERE id = p_category AND sold_qty >= p_qty;
  ELSE UPDATE ticket_categories SET held_qty = held_qty - p_qty WHERE id = p_category AND held_qty >= p_qty;
  END IF;
END $$ LANGUAGE plpgsql;

-- ---------- COUPONS ----------
CREATE TABLE coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code CITEXT UNIQUE NOT NULL,
  event_id UUID REFERENCES events(id),    -- NULL = platform-wide
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percent_bps','flat_paise')),
  discount_value INT NOT NULL CHECK (discount_value > 0),
  max_uses INT, used_count INT NOT NULL DEFAULT 0,
  valid_from TIMESTAMPTZ, valid_until TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- ---------- BOOKINGS, TICKETS, QR ----------
CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT UNIQUE NOT NULL,         -- human booking ref, e.g. QCE-8K3M2Q
  event_id UUID NOT NULL REFERENCES events(id),
  profile_id UUID REFERENCES profiles(id),-- NULL for box-office walk-ins
  channel TEXT NOT NULL DEFAULT 'online' CHECK (channel IN ('online','box_office','guest_list')),
  status booking_status NOT NULL DEFAULT 'pending_payment',
  subtotal_paise INT NOT NULL,
  discount_paise INT NOT NULL DEFAULT 0,
  service_fee_paise INT NOT NULL DEFAULT 0,
  tax_paise INT NOT NULL DEFAULT 0,
  total_paise INT NOT NULL,
  coupon_id UUID REFERENCES coupons(id),
  idempotency_key TEXT UNIQUE,            -- stops double-submit creating two bookings
  hold_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (total_paise = subtotal_paise - discount_paise + service_fee_paise + tax_paise)
);
CREATE INDEX idx_bookings_profile ON bookings(profile_id, created_at DESC);
CREATE INDEX idx_bookings_hold ON bookings(hold_expires_at) WHERE status = 'pending_payment';

CREATE TABLE booking_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES ticket_categories(id),
  qty INT NOT NULL CHECK (qty > 0),
  unit_price_paise INT NOT NULL            -- price snapshot at purchase time
);

CREATE TABLE tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id),
  category_id UUID NOT NULL REFERENCES ticket_categories(id),
  event_id UUID NOT NULL REFERENCES events(id),
  holder_name TEXT,
  status ticket_status NOT NULL DEFAULT 'valid',
  qr_token_hash TEXT UNIQUE NOT NULL,     -- QR holds an opaque random token; only its hash is stored. No personal data in QR.
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tickets_event ON tickets(event_id, status);

CREATE TABLE checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL UNIQUE REFERENCES tickets(id),   -- UNIQUE = duplicate entry impossible
  event_id UUID NOT NULL REFERENCES events(id),
  scanned_by UUID NOT NULL REFERENCES profiles(id),
  gate TEXT,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE scan_attempts (               -- audit of every scan incl. invalid/used results
  id BIGSERIAL PRIMARY KEY,
  event_id UUID, token_hash TEXT, result TEXT NOT NULL,
  scanned_by UUID REFERENCES profiles(id), scanned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- BOX OFFICE ----------
CREATE TABLE box_office_counters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id),
  name TEXT NOT NULL, operator_id UUID REFERENCES profiles(id)
);
CREATE TABLE box_office_sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id),  -- same central inventory via bookings/tickets
  counter_id UUID NOT NULL REFERENCES box_office_counters(id),
  pay_method TEXT NOT NULL CHECK (pay_method IN ('cash','upi','online','complimentary')),
  customer_name TEXT, customer_mobile TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE cash_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  counter_id UUID NOT NULL REFERENCES box_office_counters(id),
  business_date DATE NOT NULL,
  expected_cash_paise INT NOT NULL, counted_cash_paise INT NOT NULL,
  reconciled_by UUID REFERENCES profiles(id), notes TEXT,
  UNIQUE (counter_id, business_date)
);

-- ---------- PAYMENTS, REFUNDS ----------
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service service_type NOT NULL,
  ref_id UUID NOT NULL,                   -- bookings.id / rental_bookings.id / artist_bookings.id etc.
  profile_id UUID REFERENCES profiles(id),
  gateway TEXT NOT NULL DEFAULT 'razorpay',
  gateway_order_id TEXT UNIQUE,
  gateway_payment_id TEXT UNIQUE,         -- UNIQUE = duplicate transaction prevention
  amount_paise INT NOT NULL,
  gateway_fee_paise INT,
  status payment_status NOT NULL DEFAULT 'created',
  method TEXT,                            -- upi/card/netbanking (no card data ever stored)
  verified_at TIMESTAMPTZ,                -- set ONLY after server-side signature/webhook verification
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE payment_webhook_events (       -- idempotent webhook processing
  gateway_event_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id),
  booking_id UUID REFERENCES bookings(id),
  amount_paise INT NOT NULL CHECK (amount_paise > 0),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected','processed','failed')),
  gateway_refund_id TEXT UNIQUE,
  requested_by UUID REFERENCES profiles(id),
  decided_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no TEXT UNIQUE NOT NULL,
  service service_type NOT NULL, ref_id UUID NOT NULL,
  profile_id UUID REFERENCES profiles(id),
  pdf_key TEXT, issued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- COMMISSIONS & SETTLEMENTS (no hardcoded percentages) ----------
CREATE TABLE commission_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service service_type NOT NULL,
  rate_bps INT NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  service_fee_bps INT NOT NULL DEFAULT 0,  -- customer-side fee
  organiser_id UUID REFERENCES organisers(id), -- optional per-organiser override
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  set_by UUID REFERENCES profiles(id)
);
CREATE INDEX idx_commission_lookup ON commission_rates(service, effective_from DESC);

-- Immutable ledger line per paid transaction; computed and validated on backend only.
CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id),
  service service_type NOT NULL,
  payee_type TEXT NOT NULL CHECK (payee_type IN ('organiser','artist','vendor','qc_staff')),
  payee_id UUID NOT NULL,
  gross_paise INT NOT NULL,
  gateway_fee_paise INT NOT NULL DEFAULT 0,
  commission_bps_applied INT NOT NULL,     -- snapshot of rate used
  commission_paise INT NOT NULL,
  refund_paise INT NOT NULL DEFAULT 0,
  net_payable_paise INT NOT NULL,
  settlement_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (net_payable_paise = gross_paise - gateway_fee_paise - commission_paise - refund_paise)
);
CREATE TABLE settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payee_type TEXT NOT NULL, payee_id UUID NOT NULL,
  amount_paise INT NOT NULL CHECK (amount_paise > 0),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','paid','rejected')),
  bank_reference TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ, approved_by UUID REFERENCES profiles(id)
);
ALTER TABLE ledger_entries ADD FOREIGN KEY (settlement_id) REFERENCES settlements(id);

-- ---------- ARTISTS ----------
CREATE TABLE artists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id),
  stage_name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL,                  -- singer, dj, band, dancer, anchor, traditional ...
  bio TEXT, city TEXT, skills TEXT[],
  photo_key TEXT, portfolio_keys TEXT[], video_urls TEXT[],
  base_fee_paise INT,
  status approval_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE artist_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id UUID NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  day DATE NOT NULL, is_available BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (artist_id, day)
);
CREATE TABLE artist_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id UUID NOT NULL REFERENCES artists(id),
  requester_id UUID NOT NULL REFERENCES profiles(id),
  event_id UUID REFERENCES events(id),
  event_date DATE NOT NULL, location TEXT,
  requirements TEXT,
  quoted_paise INT, agreed_paise INT,
  contract_key TEXT,
  status enquiry_status NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- EQUIPMENT RENTAL ----------
CREATE TABLE vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id),
  business_name TEXT NOT NULL, mobile TEXT, address TEXT, kyc_doc_keys TEXT[],
  status approval_status NOT NULL DEFAULT 'pending'
);
CREATE TABLE equipment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendors(id),
  category TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
  price_per_day_paise INT NOT NULL, price_per_event_paise INT,
  deposit_paise INT NOT NULL DEFAULT 0,
  units_owned INT NOT NULL DEFAULT 1 CHECK (units_owned > 0),
  photo_keys TEXT[], status approval_status NOT NULL DEFAULT 'pending'
);
CREATE TABLE rental_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id UUID NOT NULL REFERENCES equipment(id),
  renter_id UUID NOT NULL REFERENCES profiles(id),
  event_id UUID REFERENCES events(id),
  units INT NOT NULL CHECK (units > 0),
  rental_period DATERANGE NOT NULL,
  delivery_mode TEXT CHECK (delivery_mode IN ('delivery','pickup')),
  delivery_address TEXT,
  rent_paise INT NOT NULL, deposit_paise INT NOT NULL,
  deposit_status TEXT NOT NULL DEFAULT 'held' CHECK (deposit_status IN ('held','released','partially_forfeited','forfeited')),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','confirmed','out','returned','cancelled')),
  returned_at TIMESTAMPTZ, damage_report TEXT, damage_paise INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_rental_period ON rental_bookings USING gist (equipment_id, rental_period);
-- Availability check (units): sum(units) of overlapping confirmed rentals + requested <= units_owned,
-- done with SELECT ... FOR UPDATE on the equipment row inside the booking transaction.

-- ---------- EVENT PLANNING ENQUIRIES ----------
CREATE TABLE planning_services (
  id SERIAL PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, details TEXT
);
CREATE TABLE event_enquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES profiles(id),
  service_id INT REFERENCES planning_services(id),
  event_date DATE, venue TEXT, guest_count INT,
  budget_min_paise INT, budget_max_paise INT, requirements TEXT,
  assigned_to UUID REFERENCES profiles(id),
  quote_paise INT, status enquiry_status NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE enquiry_messages (
  id BIGSERIAL PRIMARY KEY,
  enquiry_kind TEXT NOT NULL CHECK (enquiry_kind IN ('planning','artist','rental')),
  enquiry_id UUID NOT NULL,
  sender_id UUID NOT NULL REFERENCES profiles(id),
  body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- PROMOTION ----------
CREATE TABLE promotion_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  placement TEXT NOT NULL CHECK (placement IN ('featured','sponsored_listing','homepage_banner','email','social')),
  price_paise INT NOT NULL, duration_days INT NOT NULL, is_active BOOLEAN DEFAULT TRUE
);
CREATE TABLE promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id),
  package_id UUID NOT NULL REFERENCES promotion_packages(id),
  banner_key TEXT, starts_on DATE, ends_on DATE,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','paid','live','ended','rejected')),
  impressions BIGINT DEFAULT 0, clicks BIGINT DEFAULT 0
);

-- ---------- NEWS / BLOG ----------
CREATE TABLE articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, category TEXT,
  body TEXT NOT NULL, cover_key TEXT,
  meta_title TEXT, meta_description TEXT,
  is_featured BOOLEAN DEFAULT FALSE,
  author_id UUID REFERENCES profiles(id),
  published_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- CROSS-SERVICE LINKS (no changes to car rental / homestay tables) ----------
CREATE TABLE travel_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id),
  event_booking_id UUID REFERENCES bookings(id),
  car_booking_ref TEXT,                    -- id/ref from EXISTING car rental system (read via its API)
  homestay_booking_ref TEXT,               -- id/ref from EXISTING homestay system
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Each service keeps its own booking + payment record; this table only links them for the customer view.

-- ---------- NOTIFICATIONS, AUDIT ----------
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(id),
  channel TEXT NOT NULL CHECK (channel IN ('in_app','email','sms','whatsapp')),
  template TEXT NOT NULL, payload JSONB,
  status TEXT NOT NULL DEFAULT 'queued', sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_id UUID, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT,
  before JSONB, after JSONB, ip INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE complaints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(id), booking_id UUID REFERENCES bookings(id),
  subject TEXT NOT NULL, body TEXT, status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- SEED ----------
INSERT INTO roles(code) VALUES ('customer'),('organiser'),('artist'),('vendor'),('event_staff'),('box_office'),('admin'),('super_admin');
INSERT INTO event_categories(slug,name) VALUES
 ('music-concerts','Music Concerts'),('cultural-festivals','Cultural Festivals'),('traditional-festivals','Traditional Festivals'),
 ('dance','Dance Programmes'),('sports','Sports Events'),('running','Running Events'),('conferences','Conferences'),
 ('corporate','Corporate Events'),('weddings','Weddings'),('birthdays','Birthday Celebrations'),('parties','Parties'),
 ('educational','Educational Events'),('entertainment','Entertainment Programmes'),('community','Community Events');
-- Initial rates are placeholders for admin to change in the dashboard; app reads them from this table.
INSERT INTO commission_rates(service, rate_bps) VALUES ('ticket',0),('promotion',0),('artist',0),('equipment',0),('planning',0);

COMMIT;
