const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', '..', 'data.sqlite');
require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS landlords (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  wallet_balance INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  landlord_id TEXT NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  location TEXT NOT NULL,
  description TEXT NOT NULL,
  price INTEGER NOT NULL,
  max_guests INTEGER NOT NULL DEFAULT 2,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_photos (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  checkin TEXT NOT NULL,
  checkout TEXT NOT NULL,
  guests INTEGER NOT NULL,
  total INTEGER NOT NULL,
  commission INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'Confirmed',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  landlord_id TEXT NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  commission_rate INTEGER NOT NULL DEFAULT 20,
  qr_image_path TEXT,
  admin_password_hash TEXT NOT NULL
);
`);

// Seed the singleton settings row on first boot.
const existingSettings = db.prepare('SELECT * FROM settings WHERE id = 1').get();
if (!existingSettings) {
  const initialPassword = process.env.ADMIN_INITIAL_PASSWORD || 'admin123';
  const hash = bcrypt.hashSync(initialPassword, 10);
  db.prepare('INSERT INTO settings (id, commission_rate, qr_image_path, admin_password_hash) VALUES (1, 20, NULL, ?)').run(hash);
  console.log(`[db] Seeded settings row. Initial admin password: "${initialPassword}" — change this immediately after first login.`);
}

// Optional sample data. On hosts with an ephemeral disk (Render free plan) the
// database is empty after every restart, so guests would see "no rooms" and
// previously-registered hosts could no longer log in. Setting SEED_DEMO_DATA=true
// re-creates one clearly-labelled sample host + listings whenever the DB is empty.
// It never touches the admin password. Remove the variable once you use a persistent disk.
if (String(process.env.SEED_DEMO_DATA).toLowerCase() === 'true') {
  const hasLandlords = db.prepare('SELECT COUNT(*) AS n FROM landlords').get().n > 0;
  if (!hasLandlords) {
    const { customAlphabet } = require('nanoid');
    const nid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);
    const now = Date.now();
    const hostId = 'landlord_' + nid();
    const demoPass = process.env.DEMO_HOST_PASSWORD || 'demo1234';
    db.prepare("INSERT INTO landlords (id, name, email, phone, password_hash, wallet_balance, status, created_at) VALUES (?,?,?,?,?,0,'active',?)")
      .run(hostId, 'Sample Host (demo)', 'host@demo.queencaptivated.in', '9000000000', bcrypt.hashSync(demoPass, 10), now);
    const insRoom = db.prepare('INSERT INTO rooms (id, landlord_id, title, location, description, price, max_guests, active, created_at) VALUES (?,?,?,?,?,?,?,1,?)');
    insRoom.run('room_' + nid(), hostId, 'Cosy Hill-View Room (sample)', 'Ukhrul, Manipur', 'A warm, quiet room with a mountain view, hot water and home-cooked breakfast. Sample listing - replace with real rooms.', 1500, 2, now);
    insRoom.run('room_' + nid(), hostId, 'Family Homestay Suite (sample)', 'Ukhrul, Manipur', 'Two beds, a small sitting area and a garden porch. Sample listing - replace with real rooms.', 2800, 4, now);
    console.log('[db] SEED_DEMO_DATA: created sample host host@demo.queencaptivated.in and 2 sample rooms.');
  }
}

module.exports = db;
