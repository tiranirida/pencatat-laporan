-- Skema D1 untuk Pencatat Pelanggan Jasa.
-- Jalankan sekali ke database D1, misal:
--   npx wrangler d1 execute pencatat-laporan --file=migrations/schema.sql
-- atau tempel isi file ini di konsol D1 di Dashboard Cloudflare.
-- Login TIDAK memakai tabel user: kredensial hanya dari env Cloudflare
-- (ADMIN_USERNAME, ADMIN_PASSWORD_HASH, SESSION_SECRET).

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  next_visit_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  service_type TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  paid_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'lunas' CHECK (status IN ('lunas', 'dp', 'belum')),
  job_date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL DEFAULT 'transfer',
  bank_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_date ON jobs(job_date);
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);

-- Informasi usaha untuk invoice (key-value, diisi lewat Pengaturan di aplikasi).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Baris layanan per transaksi: 1 transaksi bisa berisi beberapa jasa,
-- masing-masing dengan jumlah (kubikasi/strip/pcs) dan harga satuan.
-- jobs.amount selalu = jumlah amount baris-barisnya; jobs.service_type
-- adalah ringkasan (jasa pertama, atau "jasa pertama + n layanan lain").
CREATE TABLE IF NOT EXISTS job_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  service_type TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT '',
  unit_price INTEGER NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_job_items_job ON job_items(job_id);

-- Daftar harga jasa (preset): satu nama jasa = satu satuan + harga satuan.
-- Dipakai form transaksi untuk mengisi harga otomatis; transaksi yang
-- sudah tersimpan tidak ikut berubah bila harga preset diubah.
CREATE TABLE IF NOT EXISTS service_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_type TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  unit_price INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
