// Core API untuk Pencatat Pelanggan Jasa.
// Dijalankan di Cloudflare Pages Functions (runtime Workers).
// Satu-satunya sumber login adalah environment variable Cloudflare,
// TIDAK ada tabel user di D1 dan TIDAK ada kredensial di repo ini.
//
// Env yang wajib di-set di Dashboard Pages (Settings > Functions):
//   ADMIN_USERNAME       (Variable, contoh: andro)
//   ADMIN_PASSWORD_HASH  (Secret, SHA-256 hex dari password, lihat README)
//   SESSION_SECRET       (Secret, string acak, contoh hasil `openssl rand -hex 32`)
// Opsional (fallback, kurang disarankan dibanding hash):
//   ADMIN_PASSWORD       (Secret, password mentah — hanya dipakai bila
//                          ADMIN_PASSWORD_HASH tidak di-set)

const SESSION_COOKIE = "session";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 hari, dalam detik
const STATUSES = ["lunas", "dp", "belum"];

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function textEncoder() {
  return new TextEncoder();
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, textEncoder().encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Perbandingan string yang tidak bocor lewat timing secara kasar.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseCookies(request) {
  const out = {};
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

async function makeSessionToken(env, username) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
  const payload = `${encodeURIComponent(username)}.${exp}`;
  const sig = await hmacHex(env.SESSION_SECRET, payload);
  return `${payload}.${sig}`;
}

async function verifySession(request, env) {
  if (!env.SESSION_SECRET) return null;
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedUser, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  const payload = `${encodedUser}.${expStr}`;
  const expected = await hmacHex(env.SESSION_SECRET, payload);
  if (!safeEqual(sig, expected)) return null;
  return decodeURIComponent(encodedUser);
}

function sessionCookie(token, maxAge) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

async function readJson(request) {
  try {
    const data = await request.json();
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

function isValidDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function todayId() {
  // Tanggal WIB (UTC+7) untuk default form, tanpa library tambahan.
  const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function monthRange(month) {
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`;
  const endDate = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // hari terakhir bulan itu
  return { from: start, to: endDate };
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function dbMissingTableError(err) {
  return err && /no such table/i.test(String(err.message || err));
}

async function qAll(env, sql, ...params) {
  try {
    const res = await env.DB.prepare(sql).bind(...params).all();
    return res.results || [];
  } catch (err) {
    if (dbMissingTableError(err)) {
      const e = new Error("Tabel D1 belum dibuat. Jalankan migrations/schema.sql ke database D1 (lihat README).");
      e.status = 500;
      throw e;
    }
    throw err;
  }
}

async function qFirst(env, sql, ...params) {
  const rows = await qAll(env, sql, ...params);
  return rows[0] || null;
}

async function qRun(env, sql, ...params) {
  try {
    return await env.DB.prepare(sql).bind(...params).run();
  } catch (err) {
    if (dbMissingTableError(err)) {
      const e = new Error("Tabel D1 belum dibuat. Jalankan migrations/schema.sql ke database D1 (lihat README).");
      e.status = 500;
      throw e;
    }
    throw err;
  }
}

const ITEM_UNITS = ["kubik", "strip", "pcs", "paket", "tanki", ""];

function validateItems(body) {
  const raw = body?.items;
  if (!Array.isArray(raw) || !raw.length || raw.length > 20) return { error: "Minimal 1 baris layanan, maksimal 20." };
  const items = [];
  for (const it of raw) {
    const service_type = (it?.service_type || "").trim();
    const qty = Number(it?.qty);
    const unit = (it?.unit || "").trim();
    const unit_price = Number(it?.unit_price);
    if (!service_type || service_type.length > 100) return { error: "Jenis jasa tiap baris wajib diisi." };
    if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) return { error: "Kubikasi/jumlah tiap baris harus lebih dari 0." };
    if (!ITEM_UNITS.includes(unit)) return { error: "Satuan tidak valid (kubik/strip/pcs/paket/tanki)." };
    if (!Number.isSafeInteger(unit_price) || unit_price < 0) return { error: "Harga satuan harus angka >= 0." };
    items.push({ service_type, qty, unit, unit_price, amount: Math.round(qty * unit_price) });
  }
  return { items, total: items.reduce((sum, i) => sum + i.amount, 0) };
}

function itemsSummary(items) {
  return items.length === 1 ? items[0].service_type : `${items[0].service_type} + ${items.length - 1} layanan lain`;
}

async function ensureJobItemsTable(env) {
  await qRun(env, "CREATE TABLE IF NOT EXISTS job_items (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL REFERENCES jobs(id), service_type TEXT NOT NULL, qty REAL NOT NULL DEFAULT 1, unit TEXT NOT NULL DEFAULT '', unit_price INTEGER NOT NULL DEFAULT 0, amount INTEGER NOT NULL DEFAULT 0)");
  await qRun(env, "CREATE INDEX IF NOT EXISTS idx_job_items_job ON job_items(job_id)");
}

// Kolom paid_amount (sudah dibayar) ditambahkan ke jobs yang sudah ada
// lewat ALTER, bukan migrasi manual. Transaksi lama yang berstatus lunas
// dianggap sudah dibayar penuh, karena status adalah satu-satunya bukti
// pembayaran yang tercatat untuk data lama tersebut.
async function ensurePaidAmountColumn(env) {
  try { await qRun(env, "ALTER TABLE jobs ADD COLUMN paid_amount INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { await qRun(env, "UPDATE jobs SET paid_amount = amount WHERE status = 'lunas' AND (paid_amount IS NULL OR paid_amount = 0)"); } catch {}
}

// Jadwal kunjungan berikutnya per pelanggan (kolom di customers, NULL =
// tidak ada jadwal). Migrasi idempotent seperti paid_amount.
async function ensureNextVisitColumn(env) {
  try { await qRun(env, "ALTER TABLE customers ADD COLUMN next_visit_date TEXT"); } catch {}
}

function validatePaidAmount(paidRaw, amount) {
  const paid = Number(paidRaw ?? 0);
  if (!Number.isSafeInteger(paid) || paid < 0 || paid > amount) return { error: "Sudah dibayar harus angka 0 sampai total." };
  return { paid };
}

async function saveJobItems(env, jobId, items) {
  await ensureJobItemsTable(env);
  await qRun(env, "DELETE FROM job_items WHERE job_id = ?", jobId);
  for (const it of items) {
    await qRun(env, "INSERT INTO job_items (job_id, service_type, qty, unit, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?)",
      jobId, it.service_type, it.qty, it.unit, it.unit_price, it.amount);
  }
}

// Lampirkan items ke tiap job; job lama tanpa baris item disintesis jadi 1 baris (1 paket x nominal).
async function attachJobItems(env, jobs) {
  if (!jobs.length) return jobs;
  await ensureJobItemsTable(env);
  const ids = jobs.map((j) => j.id);
  const ph = ids.map(() => "?").join(",");
  const rows = await qAll(env, `SELECT * FROM job_items WHERE job_id IN (${ph}) ORDER BY id ASC`, ...ids);
  const byJob = {};
  rows.forEach((r) => { (byJob[r.job_id] = byJob[r.job_id] || []).push(r); });
  return jobs.map((j) => ({
    ...j,
    items: byJob[j.id]?.length
      ? byJob[j.id].map((r) => ({ id: r.id, service_type: r.service_type, qty: r.qty, unit: r.unit, unit_price: r.unit_price, amount: r.amount }))
      : [{ service_type: j.service_type, qty: 1, unit: "paket", unit_price: j.amount, amount: j.amount }],
  }));
}

export async function handleApi(request, env) {
  try {
    if (!env.DB) {
      return json({ error: "Binding D1 belum di-set. Di Dashboard Pages, tambahkan D1 binding dengan nama variabel DB." }, 500);
    }
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    const method = request.method.toUpperCase();

    // ---- Login: satu-satunya endpoint publik ----
    if (path === "/api/login" && method === "POST") {
      if (!env.ADMIN_USERNAME || !env.SESSION_SECRET || (!env.ADMIN_PASSWORD_HASH && !env.ADMIN_PASSWORD)) {
        return json({ error: "Login belum dikonfigurasi. Set ADMIN_USERNAME, ADMIN_PASSWORD_HASH, dan SESSION_SECRET di Cloudflare (lihat README)." }, 503);
      }
      const body = await readJson(request);
      if (!body) return json({ error: "Body JSON tidak valid." }, 400);
      const usernameOk = safeEqual(String(body.username || ""), String(env.ADMIN_USERNAME));
      let passwordOk = false;
      if (env.ADMIN_PASSWORD_HASH) {
        passwordOk = safeEqual(await sha256Hex(String(body.password || "")), String(env.ADMIN_PASSWORD_HASH));
      } else {
        passwordOk = safeEqual(String(body.password || ""), String(env.ADMIN_PASSWORD));
      }
      if (!usernameOk || !passwordOk) {
        return json({ error: "Username atau password salah." }, 401);
      }
      const token = await makeSessionToken(env, String(env.ADMIN_USERNAME));
      return json({ ok: true, username: String(env.ADMIN_USERNAME) }, 200, {
        "Set-Cookie": sessionCookie(token, SESSION_MAX_AGE),
      });
    }

    if (path === "/api/logout" && method === "POST") {
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
    }

    // ---- Semua endpoint lain wajib login ----
    const username = await verifySession(request, env);
    if (!username) return json({ error: "Belum login." }, 401);

    if (path === "/api/me" && method === "GET") {
      return json({ username });
    }

    // ---- Pengaturan usaha (key-value di D1, bukan env) ----
    if (path === "/api/settings" && (method === "GET" || method === "PUT")) {
      await qRun(env, "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')");
      if (method === "GET") {
        const rows = await qAll(env, "SELECT key, value FROM settings");
        const settings = {};
        rows.forEach((r) => { settings[r.key] = r.value; });
        return json({ settings });
      }
      const body = await readJson(request);
      if (!body) return json({ error: "Body JSON tidak valid." }, 400);
      const allowed = ["business_name", "business_address", "business_phone", "business_website", "business_logo", "bank_name", "bank_account_number", "bank_account_holder"];
      for (const key of allowed) {
        if (key in body) {
          const value = String(body[key] || "").trim();
          if (key === "business_logo") {
            // Logo disimpan sebagai data URL (PNG/JPEG, sudah diperkecil di aplikasi).
            if (value && !/^data:image\/(png|jpeg);base64,/.test(value)) return json({ error: "Logo harus berupa gambar PNG atau JPEG." }, 400);
            if (value.length > 1500000) return json({ error: "Logo terlalu besar (maksimal sekitar 1 MB setelah diperkecil)." }, 400);
          } else if (value.length > 200) {
            return json({ error: `Isi ${key} maksimal 200 karakter.` }, 400);
          }
          await qRun(env, "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
        }
      }
      const rows = await qAll(env, "SELECT key, value FROM settings");
      const settings = {};
      rows.forEach((r) => { settings[r.key] = r.value; });
      return json({ settings });
    }

    // ---- Pelanggan ----
    if (path === "/api/customers" && method === "GET") {
      await ensureNextVisitColumn(env);
      const q = (url.searchParams.get("q") || "").trim();
      const rows = q
        ? await qAll(env, "SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? ORDER BY name COLLATE NOCASE ASC LIMIT 200", `%${q}%`, `%${q}%`)
        : await qAll(env, "SELECT * FROM customers ORDER BY name COLLATE NOCASE ASC LIMIT 500");
      return json({ customers: rows });
    }

    if (path === "/api/customers" && method === "POST") {
      const body = await readJson(request);
      const name = (body?.name || "").trim();
      if (!name) return json({ error: "Nama pelanggan wajib diisi." }, 400);
      const nextVisit = body?.next_visit_date ? String(body.next_visit_date).trim() : null;
      if (nextVisit && !isValidDate(nextVisit)) return json({ error: "Tanggal kunjungan berikutnya tidak valid (YYYY-MM-DD)." }, 400);
      await ensureNextVisitColumn(env);
      const now = new Date().toISOString();
      const res = await qRun(
        env,
        "INSERT INTO customers (name, address, phone, next_visit_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        name, (body.address || "").trim(), (body.phone || "").trim(), nextVisit, now, now,
      );
      const row = await qFirst(env, "SELECT * FROM customers WHERE id = ?", res.meta.last_row_id);
      return json({ customer: row }, 201);
    }

    // ---- Hapus massal ----
    if (path === "/api/customers/bulk-delete" && method === "POST") {
      const body = await readJson(request);
      const ids = [...new Set((body?.ids || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
      if (!ids.length || ids.length > 200) return json({ error: "Pilih 1–200 pelanggan." }, 400);
      const ph = ids.map(() => "?").join(",");
      // Hitung dulu (bukan meta.changes, yang di runtime D1 tidak selalu terisi untuk DELETE).
      const nJobs = (await qFirst(env, `SELECT COUNT(*) AS n FROM jobs WHERE customer_id IN (${ph})`, ...ids))?.n || 0;
      const nCust = (await qFirst(env, `SELECT COUNT(*) AS n FROM customers WHERE id IN (${ph})`, ...ids))?.n || 0;
      await ensureJobItemsTable(env);
      await qRun(env, `DELETE FROM job_items WHERE job_id IN (SELECT id FROM jobs WHERE customer_id IN (${ph}))`, ...ids);
      await qRun(env, `DELETE FROM jobs WHERE customer_id IN (${ph})`, ...ids);
      await qRun(env, `DELETE FROM customers WHERE id IN (${ph})`, ...ids);
      return json({ ok: true, deleted_customers: nCust, deleted_jobs: nJobs });
    }

    if (path === "/api/jobs/bulk-delete" && method === "POST") {
      const body = await readJson(request);
      const ids = [...new Set((body?.ids || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
      if (!ids.length || ids.length > 200) return json({ error: "Pilih 1–200 transaksi." }, 400);
      const ph = ids.map(() => "?").join(",");
      const n = (await qFirst(env, `SELECT COUNT(*) AS n FROM jobs WHERE id IN (${ph})`, ...ids))?.n || 0;
      await ensureJobItemsTable(env);
      await qRun(env, `DELETE FROM job_items WHERE job_id IN (${ph})`, ...ids);
      await qRun(env, `DELETE FROM jobs WHERE id IN (${ph})`, ...ids);
      return json({ ok: true, deleted_jobs: n });
    }

    const customerIdMatch = path.match(/^\/api\/customers\/(\d+)$/);
    if (customerIdMatch) {
      const id = Number(customerIdMatch[1]);
      if (method === "PUT") {
        const body = await readJson(request);
        const name = (body?.name || "").trim();
        if (!name) return json({ error: "Nama pelanggan wajib diisi." }, 400);
        await ensureNextVisitColumn(env);
        const existing = await qFirst(env, "SELECT * FROM customers WHERE id = ?", id);
        if (!existing) return json({ error: "Pelanggan tidak ditemukan." }, 404);
        // Bila kunci next_visit_date tidak dikirim, jadwal lama dipertahankan
        // (PUT parsial dari pemanggil lain tidak boleh menghapus jadwal).
        const nextVisit = ("next_visit_date" in (body || {}))
          ? (body.next_visit_date ? String(body.next_visit_date).trim() : null)
          : (existing.next_visit_date || null);
        if (nextVisit && !isValidDate(nextVisit)) return json({ error: "Tanggal kunjungan berikutnya tidak valid (YYYY-MM-DD)." }, 400);
        await qRun(env, "UPDATE customers SET name = ?, address = ?, phone = ?, next_visit_date = ?, updated_at = ? WHERE id = ?",
          name, (body.address || "").trim(), (body.phone || "").trim(), nextVisit, new Date().toISOString(), id);
        const row = await qFirst(env, "SELECT * FROM customers WHERE id = ?", id);
        return json({ customer: row });
      }
      if (method === "DELETE") {
        await qRun(env, "DELETE FROM jobs WHERE customer_id = ?", id);
        await qRun(env, "DELETE FROM customers WHERE id = ?", id);
        return json({ ok: true });
      }
    }

    // ---- Transaksi jasa (pemasukan) ----
    if (path === "/api/jobs" && method === "GET") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      const customerId = url.searchParams.get("customer_id") || "";
      const status = url.searchParams.get("status") || "";
      let sql = `SELECT j.*, c.name AS customer_name, c.phone AS customer_phone
                 FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE 1 = 1`;
      const params = [];
      if (from && isValidDate(from)) { sql += " AND j.job_date >= ?"; params.push(from); }
      if (to && isValidDate(to)) { sql += " AND j.job_date <= ?"; params.push(to); }
      if (customerId) { sql += " AND j.customer_id = ?"; params.push(Number(customerId)); }
      if (STATUSES.includes(status)) { sql += " AND j.status = ?"; params.push(status); }
      sql += " ORDER BY j.job_date DESC, j.id DESC LIMIT 1000";
      await ensurePaidAmountColumn(env);
      const jobs = await qAll(env, sql, ...params);
      return json({ jobs: await attachJobItems(env, jobs) });
    }

    if (path === "/api/jobs" && method === "POST") {
      const body = await readJson(request);
      const customerId = Number(body?.customer_id);
      const jobDate = body?.job_date || todayId();
      const status = body?.status || "lunas";
      let items, serviceType, amount;
      if (Array.isArray(body?.items)) {
        const v = validateItems(body);
        if (v.error) return json({ error: v.error }, 400);
        items = v.items; serviceType = itemsSummary(items); amount = v.total;
      } else {
        serviceType = (body?.service_type || "").trim();
        amount = Number(body?.amount);
        if (!serviceType) return json({ error: "Jenis jasa wajib diisi." }, 400);
        if (!Number.isSafeInteger(amount) || amount < 0) return json({ error: "Nominal harus angka >= 0." }, 400);
        items = [{ service_type: serviceType, qty: 1, unit: "paket", unit_price: amount, amount }];
      }
      if (!customerId) return json({ error: "Pilih pelanggan dulu." }, 400);
      if (!isValidDate(jobDate)) return json({ error: "Tanggal tidak valid (YYYY-MM-DD)." }, 400);
      if (!STATUSES.includes(status)) return json({ error: "Status tidak valid." }, 400);
      await ensurePaidAmountColumn(env);
      const paidV = validatePaidAmount(body?.paid_amount, amount);
      if (paidV.error) return json({ error: paidV.error }, 400);
      const customer = await qFirst(env, "SELECT id FROM customers WHERE id = ?", customerId);
      if (!customer) return json({ error: "Pelanggan tidak ditemukan." }, 404);
      const now = new Date().toISOString();
      const res = await qRun(env,
        "INSERT INTO jobs (customer_id, service_type, amount, paid_amount, status, job_date, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        customerId, serviceType, amount, paidV.paid, status, jobDate, (body.note || "").trim(), now, now);
      await saveJobItems(env, res.meta.last_row_id, items);
      const row = await qFirst(env, "SELECT * FROM jobs WHERE id = ?", res.meta.last_row_id);
      return json({ job: { ...row, items } }, 201);
    }

    const jobIdMatch = path.match(/^\/api\/jobs\/(\d+)$/);
    if (jobIdMatch) {
      const id = Number(jobIdMatch[1]);
      if (method === "PUT") {
        const body = await readJson(request);
        const jobDate = body?.job_date || "";
        const status = body?.status || "";
        let items, serviceType, amount;
        if (Array.isArray(body?.items)) {
          const v = validateItems(body);
          if (v.error) return json({ error: v.error }, 400);
          items = v.items; serviceType = itemsSummary(items); amount = v.total;
        } else {
          serviceType = (body?.service_type || "").trim();
          amount = Number(body?.amount);
          if (!serviceType || !Number.isSafeInteger(amount) || amount < 0) {
            return json({ error: "Data transaksi tidak valid." }, 400);
          }
          items = [{ service_type: serviceType, qty: 1, unit: "paket", unit_price: amount, amount }];
        }
        if (!isValidDate(jobDate) || !STATUSES.includes(status)) {
          return json({ error: "Data transaksi tidak valid." }, 400);
        }
        await ensurePaidAmountColumn(env);
        const existing = await qFirst(env, "SELECT * FROM jobs WHERE id = ?", id);
        if (!existing) return json({ error: "Transaksi tidak ditemukan." }, 404);
        const paidV = validatePaidAmount(body?.paid_amount !== undefined ? body.paid_amount : existing.paid_amount, amount);
        if (paidV.error) return json({ error: paidV.error }, 400);
        await qRun(env, "UPDATE jobs SET service_type = ?, amount = ?, paid_amount = ?, status = ?, job_date = ?, note = ?, updated_at = ? WHERE id = ?",
          serviceType, amount, paidV.paid, status, jobDate, (body.note || "").trim(), new Date().toISOString(), id);
        const row = await qFirst(env, "SELECT * FROM jobs WHERE id = ?", id);
        await saveJobItems(env, id, items);
        return json({ job: { ...row, items } });
      }
      if (method === "DELETE") {
        await ensureJobItemsTable(env);
        await qRun(env, "DELETE FROM job_items WHERE job_id = ?", id);
        await qRun(env, "DELETE FROM jobs WHERE id = ?", id);
        return json({ ok: true });
      }
    }

    // ---- Daftar harga jasa (preset harga satuan) ----
    // Satu nama jasa = satu harga satuan + satuan. Dipakai form transaksi
    // untuk mengisi harga otomatis; nama dicocokkan tanpa memperhatikan
    // huruf besar/kecil supaya "Sedot WC" dan "sedot wc" tidak ganda.
    async function ensureServicePricesTable(env) {
      await qRun(env, "CREATE TABLE IF NOT EXISTS service_prices (id INTEGER PRIMARY KEY AUTOINCREMENT, service_type TEXT NOT NULL, unit TEXT NOT NULL DEFAULT '', unit_price INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    }
    if (path === "/api/service-prices" && method === "GET") {
      await ensureServicePricesTable(env);
      const rows = await qAll(env, "SELECT * FROM service_prices ORDER BY service_type ASC");
      return json({ prices: rows });
    }
    if (path === "/api/service-prices" && method === "POST") {
      await ensureServicePricesTable(env);
      const body = await readJson(request);
      const serviceType = (body?.service_type || "").trim();
      const unit = (body?.unit || "").trim();
      const unitPrice = Number(body?.unit_price);
      if (!serviceType || serviceType.length > 100) return json({ error: "Nama jasa wajib diisi." }, 400);
      if (!ITEM_UNITS.includes(unit)) return json({ error: "Satuan tidak valid (kubik/strip/pcs/paket/tanki)." }, 400);
      if (!Number.isSafeInteger(unitPrice) || unitPrice < 0) return json({ error: "Harga satuan harus angka >= 0." }, 400);
      const now = new Date().toISOString();
      const existing = await qFirst(env, "SELECT * FROM service_prices WHERE LOWER(service_type) = LOWER(?)", serviceType);
      if (existing) {
        await qRun(env, "UPDATE service_prices SET service_type = ?, unit = ?, unit_price = ?, updated_at = ? WHERE id = ?", serviceType, unit, unitPrice, now, existing.id);
        return json({ price: await qFirst(env, "SELECT * FROM service_prices WHERE id = ?", existing.id) });
      }
      const res = await qRun(env, "INSERT INTO service_prices (service_type, unit, unit_price, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", serviceType, unit, unitPrice, now, now);
      return json({ price: await qFirst(env, "SELECT * FROM service_prices WHERE id = ?", res.meta.last_row_id) }, 201);
    }
    const priceIdMatch = path.match(/^\/api\/service-prices\/(\d+)$/);
    if (priceIdMatch) {
      await ensureServicePricesTable(env);
      const id = Number(priceIdMatch[1]);
      if (method === "PUT") {
        const body = await readJson(request);
        const serviceType = (body?.service_type || "").trim();
        const unit = (body?.unit || "").trim();
        const unitPrice = Number(body?.unit_price);
        if (!serviceType || serviceType.length > 100) return json({ error: "Nama jasa wajib diisi." }, 400);
        if (!ITEM_UNITS.includes(unit)) return json({ error: "Satuan tidak valid (kubik/strip/pcs/paket/tanki)." }, 400);
        if (!Number.isSafeInteger(unitPrice) || unitPrice < 0) return json({ error: "Harga satuan harus angka >= 0." }, 400);
        const clash = await qFirst(env, "SELECT * FROM service_prices WHERE LOWER(service_type) = LOWER(?) AND id != ?", serviceType, id);
        if (clash) return json({ error: "Nama jasa sudah ada di daftar harga." }, 400);
        await qRun(env, "UPDATE service_prices SET service_type = ?, unit = ?, unit_price = ?, updated_at = ? WHERE id = ?", serviceType, unit, unitPrice, new Date().toISOString(), id);
        const row = await qFirst(env, "SELECT * FROM service_prices WHERE id = ?", id);
        if (!row) return json({ error: "Harga jasa tidak ditemukan." }, 404);
        return json({ price: row });
      }
      if (method === "DELETE") {
        await qRun(env, "DELETE FROM service_prices WHERE id = ?", id);
        return json({ ok: true });
      }
    }

    // ---- Cadangan data (backup & restore) ----
    // Restore MENGGANTI seluruh data dengan isi file cadangan. Seluruh
    // payload divalidasi dulu sebelum ada baris yang dihapus, supaya
    // file rusak tidak sempat menghapus data lalu gagal mengembalikan.
    // Id asli ikut disimpan supaya relasi pelanggan–transaksi–baris jasa
    // tetap utuh persis seperti di sumber cadangan.
    if (path === "/api/backup/restore" && method === "POST") {
      const body = await readJson(request);
      if (!body || typeof body !== "object" || !Array.isArray(body.customers) || !Array.isArray(body.jobs)) {
        return json({ error: "File cadangan tidak valid: harus berisi daftar pelanggan dan transaksi." }, 400);
      }
      const prices = Array.isArray(body.service_prices) ? body.service_prices : [];
      const settingsIn = body.settings && typeof body.settings === "object" ? body.settings : {};
      const isInt = (n) => Number.isSafeInteger(n);
      const isStr = (v) => typeof v === "string";
      const custIds = new Set();
      for (const c of body.customers) {
        if (!c || !isInt(c.id) || c.id <= 0 || custIds.has(c.id)) return json({ error: "Data pelanggan di cadangan tidak valid (id ganda/tidak valid)." }, 400);
        custIds.add(c.id);
        if (!isStr(c.name) || !c.name.trim() || c.name.length > 200) return json({ error: "Nama pelanggan di cadangan tidak valid." }, 400);
        if (!isStr(c.address || "") || !isStr(c.phone || "") || (c.address || "").length > 500 || (c.phone || "").length > 50) return json({ error: "Alamat/telepon pelanggan di cadangan tidak valid." }, 400);
        if (c.next_visit_date && !isValidDate(c.next_visit_date)) return json({ error: "Tanggal kunjungan berikutnya di cadangan tidak valid." }, 400);
      }
      const priceIds = new Set();
      const priceNames = new Set();
      for (const p of prices) {
        if (!p || !isInt(p.id) || p.id <= 0 || priceIds.has(p.id)) return json({ error: "Data harga jasa di cadangan tidak valid." }, 400);
        priceIds.add(p.id);
        const nm = isStr(p.service_type) ? p.service_type.trim().toLowerCase() : "";
        if (!nm || priceNames.has(nm)) return json({ error: "Nama jasa di cadangan ganda/tidak valid." }, 400);
        priceNames.add(nm);
        if (!ITEM_UNITS.includes(p.unit || "")) return json({ error: "Satuan harga jasa di cadangan tidak valid." }, 400);
        if (!isInt(p.unit_price) || p.unit_price < 0) return json({ error: "Harga satuan di cadangan tidak valid." }, 400);
      }
      const jobIds = new Set();
      for (const j of body.jobs) {
        if (!j || !isInt(j.id) || j.id <= 0 || jobIds.has(j.id)) return json({ error: "Data transaksi di cadangan tidak valid (id ganda/tidak valid)." }, 400);
        jobIds.add(j.id);
        if (!custIds.has(j.customer_id)) return json({ error: "Transaksi di cadangan mengacu ke pelanggan yang tidak ada di cadangan." }, 400);
        if (!isStr(j.service_type) || !j.service_type.trim()) return json({ error: "Jenis jasa transaksi di cadangan tidak valid." }, 400);
        if (!isInt(j.amount) || j.amount < 0) return json({ error: "Nominal transaksi di cadangan tidak valid." }, 400);
        const paid = j.paid_amount === undefined ? 0 : j.paid_amount;
        if (!isInt(paid) || paid < 0 || paid > j.amount) return json({ error: "Sudah dibayar di cadangan tidak valid." }, 400);
        if (!STATUSES.includes(j.status)) return json({ error: "Status transaksi di cadangan tidak valid." }, 400);
        if (!isValidDate(j.job_date)) return json({ error: "Tanggal transaksi di cadangan tidak valid." }, 400);
        if (Array.isArray(j.items)) {
          const v = validateItems({ items: j.items });
          if (v.error) return json({ error: `Baris layanan di cadangan tidak valid: ${v.error}` }, 400);
          if (v.total !== j.amount) return json({ error: "Total baris layanan tidak cocok dengan nominal transaksi di cadangan." }, 400);
        }
      }
      const SETTING_KEYS = ["business_name", "business_address", "business_phone", "business_website", "business_logo", "bank_name", "bank_account_number", "bank_account_holder"];
      const settingsOut = {};
      for (const key of SETTING_KEYS) {
        if (!(key in settingsIn)) continue;
        const value = String(settingsIn[key] ?? "");
        if (key === "business_logo") {
          if (value && !/^data:image\/(png|jpeg);base64,/.test(value)) return json({ error: "Logo di cadangan bukan PNG/JPEG." }, 400);
          if (value.length > 1500000) return json({ error: "Logo di cadangan terlalu besar." }, 400);
          settingsOut[key] = value;
        } else {
          if (value.length > 200) return json({ error: `Isi ${key} di cadangan terlalu panjang.` }, 400);
          settingsOut[key] = value.trim();
        }
      }
      // Validasi lolos semua — baru sekarang ganti data.
      await qRun(env, "CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', next_visit_date TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      await ensureNextVisitColumn(env);
      await qRun(env, "CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES customers(id), service_type TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0, paid_amount INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'lunas', job_date TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      await ensureServicePricesTable(env);
      await ensureJobItemsTable(env);
      await qRun(env, "DELETE FROM job_items");
      await qRun(env, "DELETE FROM jobs");
      await qRun(env, "DELETE FROM customers");
      await qRun(env, "DELETE FROM service_prices");
      await qRun(env, "DELETE FROM settings");
      const now = new Date().toISOString();
      for (const c of body.customers) {
        await qRun(env, "INSERT INTO customers (id, name, address, phone, next_visit_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", c.id, c.name.trim(), (c.address || "").trim(), (c.phone || "").trim(), c.next_visit_date || null, c.created_at || now, c.updated_at || now);
      }
      for (const p of prices) {
        await qRun(env, "INSERT INTO service_prices (id, service_type, unit, unit_price, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", p.id, p.service_type.trim(), p.unit, p.unit_price, p.created_at || now, p.updated_at || now);
      }
      for (const [key, value] of Object.entries(settingsOut)) {
        await qRun(env, "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
      }
      for (const j of body.jobs) {
        const paid = j.paid_amount === undefined ? 0 : j.paid_amount;
        await qRun(env, "INSERT INTO jobs (id, customer_id, service_type, amount, paid_amount, status, job_date, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", j.id, j.customer_id, j.service_type.trim(), j.amount, paid, j.status, j.job_date, (j.note || "").trim(), j.created_at || now, j.updated_at || now);
        const items = Array.isArray(j.items) && j.items.length
          ? j.items
          : [{ service_type: j.service_type, qty: 1, unit: "paket", unit_price: j.amount, amount: j.amount }];
        for (const it of items) {
          await qRun(env, "INSERT INTO job_items (job_id, service_type, qty, unit, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?)", j.id, it.service_type, it.qty, it.unit, it.unit_price, it.amount);
        }
      }
      return json({ ok: true, restored_customers: body.customers.length, restored_jobs: body.jobs.length, restored_prices: prices.length });
    }

    // ---- Laporan pemasukan ----
    if (path === "/api/reports" && method === "GET") {
      const period = url.searchParams.get("period") || "monthly";
      let from = url.searchParams.get("from") || "";
      let to = url.searchParams.get("to") || "";
      if (period === "daily") {
        const date = url.searchParams.get("date") || todayId();
        if (!isValidDate(date)) return json({ error: "Tanggal tidak valid." }, 400);
        from = date; to = date;
      } else if (period === "monthly") {
        const month = url.searchParams.get("month") || todayId().slice(0, 7);
        if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: "Bulan tidak valid (YYYY-MM)." }, 400);
        ({ from, to } = monthRange(month));
      } else {
        if (!isValidDate(from) || !isValidDate(to)) return json({ error: "Rentang from/to tidak valid." }, 400);
      }
      const totals = await qFirst(env,
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(amount), 0) AS total,
                COALESCE(SUM(CASE WHEN status = 'lunas' THEN amount ELSE 0 END), 0) AS total_lunas,
                COALESCE(SUM(CASE WHEN status = 'dp' THEN amount ELSE 0 END), 0) AS total_dp,
                COALESCE(SUM(CASE WHEN status = 'belum' THEN amount ELSE 0 END), 0) AS total_belum
         FROM jobs WHERE job_date BETWEEN ? AND ?`, from, to);
      const jobsRaw = await qAll(env,
        `SELECT j.*, c.name AS customer_name FROM jobs j JOIN customers c ON c.id = j.customer_id
         WHERE j.job_date BETWEEN ? AND ? ORDER BY j.job_date DESC, j.id DESC`, from, to);
      const jobs = await attachJobItems(env, jobsRaw);
      const byMap = {};
      jobs.forEach((j) => j.items.forEach((it) => {
        byMap[it.service_type] = byMap[it.service_type] || { service_type: it.service_type, count: 0, total: 0 };
        byMap[it.service_type].count += 1;
        byMap[it.service_type].total += it.amount;
      }));
      const byService = Object.values(byMap).sort((a, b) => b.total - a.total);
      return json({ from, to, totals, by_service: byService, jobs });
    }

    // ---- Ekspor CSV laporan ----
    if (path === "/api/export" && method === "GET") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      if (!isValidDate(from) || !isValidDate(to)) return json({ error: "Rentang from/to tidak valid." }, 400);
      const jobsRaw = await qAll(env,
        `SELECT j.*, c.name AS customer_name, c.phone FROM jobs j JOIN customers c ON c.id = j.customer_id
         WHERE j.job_date BETWEEN ? AND ? ORDER BY j.job_date ASC, j.id ASC`, from, to);
      const jobs = await attachJobItems(env, jobsRaw);
      const lines = ["tanggal,nama_pelanggan,telepon_wa,jenis_jasa,jumlah,satuan,harga_satuan_rp,subtotal_rp,status,catatan,sudah_dibayar_rp,sisa_rp"];
      for (const j of jobs) {
        const paid = Number(j.paid_amount || 0);
        const remaining = Math.max(0, Number(j.amount) - paid);
        for (const it of j.items) {
          lines.push([j.job_date, j.customer_name, j.phone, it.service_type, it.qty, it.unit, it.unit_price, it.amount, j.status, j.note, paid, remaining].map(csvEscape).join(","));
        }
      }
      return new Response(lines.join("\n"), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="laporan-${from}-sampai-${to}.csv"`,
        },
      });
    }

    return json({ error: "Endpoint tidak ditemukan." }, 404);
  } catch (err) {
    return json({ error: err?.message || "Terjadi kesalahan server." }, err?.status || 500);
  }
}
