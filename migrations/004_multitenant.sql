-- Multi-tenant + Google OAuth (19 Nov 2026).
-- Untuk database D1 baru. Database lama TIDAK perlu menjalankan ini:
-- shared/api.js (ensureMultiTenant) membuat tabel/kolom ini sendiri
-- dan memigrasikan data lama ke satu usaha legacy.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub TEXT UNIQUE,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  picture TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS businesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER,
  legacy INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  logo TEXT NOT NULL DEFAULT '',
  bank_name TEXT NOT NULL DEFAULT '',
  bank_account_number TEXT NOT NULL DEFAULT '',
  bank_account_holder TEXT NOT NULL DEFAULT '',
  stamp_enabled INTEGER NOT NULL DEFAULT 1,
  stamp_color TEXT NOT NULL DEFAULT 'red',
  stamp_model TEXT NOT NULL DEFAULT '1',
  stamp_image TEXT NOT NULL DEFAULT '',
  signer_name TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE customers ADD COLUMN business_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN business_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE service_prices ADD COLUMN business_id INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_customers_business ON customers(business_id);
CREATE INDEX IF NOT EXISTS idx_jobs_business ON jobs(business_id);
CREATE INDEX IF NOT EXISTS idx_prices_business ON service_prices(business_id);
