// Core API untuk Pencatat Pelanggan Jasa.
// Dijalankan di Cloudflare Pages Functions (runtime Workers).
//
// Login ada dua macam:
//   1. Password lama (satu akun admin): env ADMIN_USERNAME,
//      ADMIN_PASSWORD_HASH (SHA-256 hex), SESSION_SECRET. Sesi ini
//      mengakses usaha legacy (data yang sudah ada sebelum multi-tenant).
//   2. Google OAuth (pendaftaran TERBUKA, siapa pun dengan akun Google
//      bisa daftar): env GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET.
//      Setiap pemilik usaha login sendiri dan hanya melihat usahanya.
//      Sesi Google memakai cookie yang sama dengan sesi password.
//
// Multi-tenant: tabel businesses + kolom business_id di customers, jobs,
// service_prices. Semua endpoint data WAJIB memfilter business_id dan
// memverifikasi kepemilikan usaha. Data lama dimigrasikan sekali ke satu
// usaha legacy (dari tabel settings). Sesi password bisa menghubungkan
// akun Google-nya ke usaha legacy lewat /api/auth/google?mode=link.

const SESSION_COOKIE = "session";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 hari, dalam detik
const STATUSES = ["lunas", "dp", "belum"];
const MAX_BUSINESSES_PER_USER = 5;

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

async function makeSessionToken(env, subject) {
  // subject: username lama (mis. "andro") atau "g.<userId>" untuk Google.
  // Format token lama (3 bagian) tetap didukung verifySession di bawah,
  // jadi cookie password yang sudah ada tidak langsung mati.
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
  const payload = `${encodeURIComponent(subject)}.${exp}`;
  const sig = await hmacHex(env.SESSION_SECRET, payload);
  return `${payload}.${sig}`;
}

// Identitas dari cookie sesi, atau null bila tidak login.
// Password: { kind: "password", username }
// Google:   { kind: "google", userId, email }
async function verifySession(request, env) {
  if (!env.SESSION_SECRET) return null;
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  const parts = token.split(".");
  const exp = Number(parts[parts.length - 2]);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  const payload = parts.slice(0, -1).join(".");
  const expected = await hmacHex(env.SESSION_SECRET, payload);
  if (!safeEqual(parts[parts.length - 1], expected)) return null;
  if (parts.length === 4 && parts[0] === "g") {
    const userId = Number(parts[1]);
    if (!Number.isSafeInteger(userId) || userId <= 0) return null;
    const user = await qFirst(env, "SELECT id, email, name FROM users WHERE id = ?", userId).catch(() => null);
    if (!user) return null;
    return { kind: "google", userId: user.id, email: user.email, name: user.name };
  }
  if (parts.length === 3) {
    return { kind: "password", username: decodeURIComponent(parts[0]) };
  }
  return null;
}

function sessionCookie(token, maxAge) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

// ---- Multi-tenant: users, businesses, business_id ----

// Hasil ensure hanya perlu dihitung sekali per isolate Worker: isolate
// dipakai ulang antar request, jadi request hangat tidak perlu mengulang
// CREATE/ALTER/SELECT migrasi (~9 round trip D1) di tiap panggilan API.
// Bila ensure gagal di tengah jalan, flag tidak diset sehingga request
// berikutnya mencoba lagi.
let ensuredMultiTenant = false;
let ensuredNextVisit = false;
let ensuredPaidAmount = false;
let ensuredJobItems = false;

async function ensureMultiTenant(env) {
  if (ensuredMultiTenant) return;
  // Pernyataan DDL-nya saling bebas (tabel & indeks berbeda) jadi
  // dijalankan paralel, bukan satu-satu: ~9 round trip D1 berurutan
  // menjadi 1 batch paralel. ALTER yang gagal (kolom sudah ada) ditelan
  // per pernyataan supaya tidak menggagalkan yang lain.
  await Promise.all([
    qRun(env, "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, google_sub TEXT UNIQUE, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', picture TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)"),
    qRun(env, "CREATE TABLE IF NOT EXISTS businesses (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER, legacy INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '', logo TEXT NOT NULL DEFAULT '', bank_name TEXT NOT NULL DEFAULT '', bank_account_number TEXT NOT NULL DEFAULT '', bank_account_holder TEXT NOT NULL DEFAULT '', stamp_enabled INTEGER NOT NULL DEFAULT 1, stamp_color TEXT NOT NULL DEFAULT 'red', stamp_model TEXT NOT NULL DEFAULT '1', stamp_image TEXT NOT NULL DEFAULT '', signer_name TEXT NOT NULL DEFAULT '', signature TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    ...["customers", "jobs", "service_prices"].map((table) =>
      qRun(env, `ALTER TABLE ${table} ADD COLUMN business_id INTEGER NOT NULL DEFAULT 0`).catch(() => {})),
    qRun(env, "ALTER TABLE businesses ADD COLUMN stamp_enabled INTEGER NOT NULL DEFAULT 1").catch(() => {}),
    qRun(env, "ALTER TABLE businesses ADD COLUMN stamp_color TEXT NOT NULL DEFAULT 'red'").catch(() => {}),
    qRun(env, "ALTER TABLE businesses ADD COLUMN stamp_model TEXT NOT NULL DEFAULT '1'").catch(() => {}),
    qRun(env, "ALTER TABLE businesses ADD COLUMN stamp_image TEXT NOT NULL DEFAULT ''").catch(() => {}),
    qRun(env, "ALTER TABLE businesses ADD COLUMN signer_name TEXT NOT NULL DEFAULT ''").catch(() => {}),
    qRun(env, "ALTER TABLE businesses ADD COLUMN signature TEXT NOT NULL DEFAULT ''").catch(() => {}),
    ...[["customers", "idx_customers_business"], ["jobs", "idx_jobs_business"], ["service_prices", "idx_prices_business"]].map(([table, index]) =>
      qRun(env, `CREATE INDEX IF NOT EXISTS ${index} ON ${table}(business_id)`)),
  ]);
  // Migrasi sekali: data lama (business_id 0) dipindah ke satu usaha
  // legacy yang profilnya diambil dari tabel settings.
  const existing = await qFirst(env, "SELECT id FROM businesses LIMIT 1");
  if (!existing) {
    const rows = await qAll(env, "SELECT key, value FROM settings").catch(() => []);
    const s = {};
    rows.forEach((r) => { s[r.key] = r.value; });
    const hasData = s.business_name || (await qFirst(env, "SELECT id FROM customers LIMIT 1").catch(() => null)) || (await qFirst(env, "SELECT id FROM jobs LIMIT 1").catch(() => null));
    if (hasData) {
      const now = new Date().toISOString();
      const res = await qRun(env,
        "INSERT INTO businesses (owner_user_id, legacy, name, address, phone, website, logo, bank_name, bank_account_number, bank_account_holder, created_at, updated_at) VALUES (NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        s.business_name || "Usaha Saya", s.business_address || "", s.business_phone || "", s.business_website || "",
        s.business_logo || "", s.bank_name || "", s.bank_account_number || "", s.bank_account_holder || "", now, now);
      const bid = res.meta.last_row_id;
      for (const table of ["customers", "jobs", "service_prices"]) {
        await qRun(env, `UPDATE ${table} SET business_id = ? WHERE business_id = 0`, bid);
      }
    }
  }
  ensuredMultiTenant = true;
}

// Usaha-usaha yang boleh diakses identitas ini.
async function listBusinessesFor(env, identity) {
  if (identity.kind === "google") {
    return qAll(env, "SELECT * FROM businesses WHERE owner_user_id = ? ORDER BY id ASC", identity.userId);
  }
  return qAll(env, "SELECT * FROM businesses WHERE legacy = 1 ORDER BY id ASC");
}

// Tentukan usaha aktif untuk endpoint data. business_id diambil dari
// query (?business_id=) atau header x-business-id. Bila tidak disebut
// dan identitas hanya punya satu usaha, usaha itu yang dipakai.
// Mengembalikan { business } atau { error, status }.
async function resolveBusiness(request, env, identity) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("business_id") || request.headers.get("x-business-id") || "";
  const owned = await listBusinessesFor(env, identity);
  if (!owned.length) return { error: "Belum ada usaha. Buat profil usaha dulu.", status: 400, code: "no_business" };
  if (!raw) {
    if (owned.length === 1) return { business: owned[0] };
    return { error: "Pilih usaha dulu.", status: 400, code: "need_business" };
  }
  const id = Number(raw);
  const business = owned.find((b) => b.id === id);
  if (!business) return { error: "Usaha tidak ditemukan atau bukan milik Anda.", status: 403 };
  return { business };
}

// Profil usaha dalam bentuk yang sama seperti /api/settings dulu
// (business_name, dst.), supaya form Pengaturan & invoice tidak berubah.
function businessSettings(b) {
  return {
    business_name: b.name || "",
    business_address: b.address || "",
    business_phone: b.phone || "",
    business_website: b.website || "",
    business_logo: b.logo || "",
    bank_name: b.bank_name || "",
    bank_account_number: b.bank_account_number || "",
    bank_account_holder: b.bank_account_holder || "",
    stamp_image: b.stamp_image || "",
    signer_name: b.signer_name || "",
    signature: b.signature || "",
  };
}

const BUSINESS_FIELDS = ["business_name", "business_address", "business_phone", "business_website", "business_logo", "bank_name", "bank_account_number", "bank_account_holder", "stamp_image", "signer_name", "signature"];
const BUSINESS_COLUMNS = { business_name: "name", business_address: "address", business_phone: "phone", business_website: "website", business_logo: "logo", bank_name: "bank_name", bank_account_number: "bank_account_number", bank_account_holder: "bank_account_holder", stamp_image: "stamp_image", signer_name: "signer_name", signature: "signature" };

function validateBusinessProfile(body) {
  const out = {};
  for (const key of BUSINESS_FIELDS) {
    if (!(key in (body || {}))) continue;
    const value = String(body[key] || "").trim();
    if (key === "business_logo" || key === "signature" || key === "stamp_image") {
      if (value && !/^data:image\/(png|jpeg);base64,/.test(value)) return { error: key === "business_logo" ? "Logo harus berupa gambar PNG atau JPEG." : key === "stamp_image" ? "Gambar stempel harus berupa gambar PNG atau JPEG." : "Tanda tangan harus berupa gambar PNG atau JPEG." };
      if (value.length > 1500000) return { error: key === "business_logo" ? "Logo terlalu besar (maksimal sekitar 1 MB setelah diperkecil)." : key === "stamp_image" ? "Gambar stempel terlalu besar (maksimal sekitar 1 MB setelah diperkecil)." : "Tanda tangan terlalu besar (maksimal sekitar 1 MB setelah diperkecil)." };
    } else if (value.length > 200) {
      return { error: `Isi ${key} maksimal 200 karakter.` };
    }
    out[key] = value;
  }
  return { values: out };
}

// ---- Google OAuth (authorization code flow, tanpa library) ----

function b64urlEncode(bytes) {
  const bin = typeof bytes === "string" ? bytes : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function b64urlDecode(str) {
  const bin = atob(str.replaceAll("-", "+").replaceAll("_", "/"));
  return [...bin].map((c) => c.charCodeAt(0));
}

async function signState(env, payload) {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = await hmacHex(env.SESSION_SECRET, body);
  return `${body}.${sig}`;
}

async function verifyState(env, token) {
  try {
    const [body, sig] = String(token || "").split(".");
    if (!body || !sig) return null;
    if (!safeEqual(sig, await hmacHex(env.SESSION_SECRET, body))) return null;
    const payload = JSON.parse(new TextDecoder().decode(new Uint8Array(b64urlDecode(body))));
    if (!payload || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (payload.mode !== "login" && payload.mode !== "link") return null;
    return payload;
  } catch { return null; }
}

function googleRedirectUri(request) {
  return `${new URL(request.url).origin}/api/auth/google/callback`;
}

function oauthErrorRedirect(message) {
  return new Response(null, { status: 302, headers: { Location: `/?auth_error=${encodeURIComponent(message)}` } });
}

function stateCookie(token) {
  return `oauth_state=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/google; Max-Age=600`;
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

const ITEM_UNITS = ["kubik", "strip", "pcs", "paket", "tanki", "titik", ""];

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
    if (!ITEM_UNITS.includes(unit)) return { error: "Satuan tidak valid (kubik/strip/pcs/paket/tanki/titik)." };
    if (!Number.isSafeInteger(unit_price) || unit_price < 0) return { error: "Harga satuan harus angka >= 0." };
    items.push({ service_type, qty, unit, unit_price, amount: Math.round(qty * unit_price) });
  }
  return { items, total: items.reduce((sum, i) => sum + i.amount, 0) };
}

function itemsSummary(items) {
  return items.length === 1 ? items[0].service_type : `${items[0].service_type} + ${items.length - 1} layanan lain`;
}

async function ensureJobItemsTable(env) {
  if (ensuredJobItems) return;
  await qRun(env, "CREATE TABLE IF NOT EXISTS job_items (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL REFERENCES jobs(id), service_type TEXT NOT NULL, qty REAL NOT NULL DEFAULT 1, unit TEXT NOT NULL DEFAULT '', unit_price INTEGER NOT NULL DEFAULT 0, amount INTEGER NOT NULL DEFAULT 0)");
  await qRun(env, "CREATE INDEX IF NOT EXISTS idx_job_items_job ON job_items(job_id)");
  ensuredJobItems = true;
}

// Kolom payment_method (cara bayar) + bank_text (rekening per transaksi)
// ditambahkan ke jobs yang sudah ada lewat ALTER, bukan migrasi manual.
// Transaksi lama dianggap transfer (nilai default), karena sebelumnya
// invoice selalu menampilkan rekening dari Pengaturan.
let ensuredPaymentMethod = false;
async function ensurePaymentMethodColumn(env) {
  if (ensuredPaymentMethod) return;
  try { await qRun(env, "ALTER TABLE jobs ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'transfer'"); } catch {}
  try { await qRun(env, "ALTER TABLE jobs ADD COLUMN bank_text TEXT NOT NULL DEFAULT ''"); } catch {}
  ensuredPaymentMethod = true;
}
const PAYMENT_METHODS = ["transfer", "cash"];
const validPaymentMethod = (v) => PAYMENT_METHODS.includes(v) ? v : "transfer";

// Kolom paid_amount (sudah dibayar) ditambahkan ke jobs yang sudah ada
// lewat ALTER, bukan migrasi manual. Transaksi lama yang berstatus lunas
// dianggap sudah dibayar penuh, karena status adalah satu-satunya bukti
// pembayaran yang tercatat untuk data lama tersebut.
async function ensurePaidAmountColumn(env) {
  if (ensuredPaidAmount) return;
  try { await qRun(env, "ALTER TABLE jobs ADD COLUMN paid_amount INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { await qRun(env, "UPDATE jobs SET paid_amount = amount WHERE status = 'lunas' AND (paid_amount IS NULL OR paid_amount = 0)"); } catch {}
  ensuredPaidAmount = true;
}

// Jadwal kunjungan berikutnya per pelanggan (kolom di customers, NULL =
// tidak ada jadwal). Migrasi idempotent seperti paid_amount.
async function ensureNextVisitColumn(env) {
  if (ensuredNextVisit) return;
  try { await qRun(env, "ALTER TABLE customers ADD COLUMN next_visit_date TEXT"); } catch {}
  ensuredNextVisit = true;
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

    // Tabel users/businesses + kolom business_id + migrasi data lama.
    await ensureMultiTenant(env);

    // ---- Google OAuth: endpoint publik ----
    if (path === "/api/auth/google" && method === "GET") {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET) {
        return oauthErrorRedirect("Login Google belum dikonfigurasi. Set GOOGLE_CLIENT_ID dan GOOGLE_CLIENT_SECRET di Cloudflare.");
      }
      const mode = url.searchParams.get("mode") === "link" ? "link" : "login";
      const state = await signState(env, { mode, exp: Math.floor(Date.now() / 1000) + 600, nonce: crypto.randomUUID() });
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", googleRedirectUri(request));
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", "openid email profile");
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("prompt", "select_account");
      return new Response(null, { status: 302, headers: { Location: authUrl.toString(), "Set-Cookie": stateCookie(state) } });
    }

    if (path === "/api/auth/google/callback" && method === "GET") {
      const code = url.searchParams.get("code") || "";
      const state = url.searchParams.get("state") || "";
      const stateCookieValue = parseCookies(request).oauth_state || "";
      const payload = await verifyState(env, state);
      if (!code || !payload || stateCookieValue !== state) {
        return oauthErrorRedirect("Login Google gagal: sesi tidak valid. Coba lagi.");
      }
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
        return oauthErrorRedirect("Login Google belum dikonfigurasi.");
      }
      try {
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: googleRedirectUri(request), grant_type: "authorization_code",
          }),
        });
        const tokenData = await tokenRes.json().catch(() => ({}));
        if (!tokenRes.ok || !tokenData.id_token) {
          return oauthErrorRedirect("Login Google gagal: Google menolak kode login. Coba lagi.");
        }
        const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenData.id_token)}`);
        const info = await infoRes.json().catch(() => ({}));
        if (!infoRes.ok || info.aud !== env.GOOGLE_CLIENT_ID || !info.email || info.email_verified !== "true" || !info.sub) {
          return oauthErrorRedirect("Login Google gagal: identitas tidak terverifikasi.");
        }
        const now = new Date().toISOString();
        await qRun(env,
          "INSERT INTO users (google_sub, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture",
          info.sub, info.email, info.name || "", info.picture || "", now);
        const user = await qFirst(env, "SELECT id, email, name FROM users WHERE google_sub = ?", info.sub);
        if (!user) return oauthErrorRedirect("Login Google gagal: akun tidak tersimpan. Coba lagi.");
        if (payload.mode === "link") {
          // Hubungkan usaha legacy ke akun Google ini; butuh sesi password.
          const passwordIdentity = await verifySession(request, env);
          if (!passwordIdentity || passwordIdentity.kind !== "password") {
            return oauthErrorRedirect("Untuk menghubungkan akun Google, login dulu dengan password lama.");
          }
          await qRun(env, "UPDATE businesses SET owner_user_id = ? WHERE legacy = 1 AND (owner_user_id IS NULL OR owner_user_id = ?)", user.id, user.id);
        }
        const token = await makeSessionToken(env, `g.${user.id}`);
        return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": sessionCookie(token, SESSION_MAX_AGE) } });
      } catch {
        return oauthErrorRedirect("Login Google gagal: tidak bisa menghubungi Google. Coba lagi.");
      }
    }

    // ---- Login password lama: satu-satunya endpoint publik lain ----
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
    const identity = await verifySession(request, env);
    if (!identity) return json({ error: "Belum login." }, 401);

    if (path === "/api/me" && method === "GET") {
      const businesses = await listBusinessesFor(env, identity);
      return json({
        username: identity.kind === "google" ? identity.email : identity.username,
        auth: identity.kind,
        email: identity.kind === "google" ? identity.email : "",
        name: identity.kind === "google" ? (identity.name || "") : "",
        businesses: businesses.map((b) => ({ id: b.id, name: b.name })),
      });
    }

    // ---- Bootstrap: semua yang dibutuhkan tampilan pertama dalam SATU
    // panggilan (profil + pelanggan + transaksi + harga + total harian &
    // bulanan). Sebelumnya halaman awal menembak 8 endpoint terpisah
    // (/api/me dulu, lalu 2x reports + customers + jobs + settings +
    // service-prices), masing-masing membayar biaya ensure migrasi dan
    // round trip D1 sendiri — itu yang membuat laporan baru muncul
    // setelah beberapa detik. Query di sini jalan paralel (Promise.all).
    if (path === "/api/bootstrap" && method === "GET") {
      const businesses = await listBusinessesFor(env, identity);
      const base = {
        username: identity.kind === "google" ? identity.email : identity.username,
        auth: identity.kind,
        email: identity.kind === "google" ? identity.email : "",
        name: identity.kind === "google" ? (identity.name || "") : "",
        businesses: businesses.map((b) => ({ id: b.id, name: b.name })),
      };
      const rawBid = url.searchParams.get("business_id") || request.headers.get("x-business-id") || "";
      let business = null;
      if (rawBid) {
        business = businesses.find((b) => b.id === Number(rawBid)) || null;
        if (!business) return json({ error: "Usaha tidak ditemukan atau bukan milik Anda." }, 403);
      } else if (businesses.length === 1) {
        business = businesses[0];
      }
      if (!business) return json({ ...base, business: null });
      const bid = business.id;
      const today = todayId();
      const month = today.slice(0, 7);
      const { from: mFrom, to: mTo } = monthRange(month);
      const [py, pm] = month.split("-").map(Number);
      const prevMonth = pm === 1 ? `${py - 1}-12` : `${py}-${String(pm - 1).padStart(2, "0")}`;
      const { from: pFrom, to: pTo } = monthRange(prevMonth);
      const totalsSql = `SELECT COUNT(*) AS count,
                COALESCE(SUM(amount), 0) AS total,
                COALESCE(SUM(CASE WHEN status = 'lunas' THEN amount ELSE 0 END), 0) AS total_lunas,
                COALESCE(SUM(CASE WHEN status = 'dp' THEN amount ELSE 0 END), 0) AS total_dp,
                COALESCE(SUM(CASE WHEN status = 'belum' THEN amount ELSE 0 END), 0) AS total_belum
         FROM jobs WHERE business_id = ? AND job_date BETWEEN ? AND ?`;
      const [customers, jobsRaw, prices, dailyTotals, monthlyTotals, lastMonthTotals] = await Promise.all([
        (async () => { await ensureNextVisitColumn(env); return qAll(env, "SELECT * FROM customers WHERE business_id = ? ORDER BY name COLLATE NOCASE ASC LIMIT 500", bid); })(),
        (async () => {
          await ensurePaidAmountColumn(env);
          return qAll(env, `SELECT j.*, c.name AS customer_name, c.phone AS customer_phone
                 FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE j.business_id = ?
                 ORDER BY j.job_date DESC, j.id DESC LIMIT 1000`, bid);
        })(),
        qAll(env, "SELECT * FROM service_prices WHERE business_id = ? ORDER BY service_type ASC", bid),
        qFirst(env, totalsSql, bid, today, today),
        qFirst(env, totalsSql, bid, mFrom, mTo),
        qFirst(env, totalsSql, bid, pFrom, pTo),
      ]);
      const jobs = await attachJobItems(env, jobsRaw);
      return json({
        ...base,
        business: { id: business.id, name: business.name, ...businessSettings(business) },
        settings: businessSettings(business),
        customers,
        jobs,
        prices,
        totals: { daily: dailyTotals, monthly: monthlyTotals, lastMonth: lastMonthTotals },
      });
    }

    // ---- Profil usaha (businesses) ----
    if (path === "/api/businesses" && method === "GET") {
      const businesses = await listBusinessesFor(env, identity);
      return json({ businesses: businesses.map((b) => ({ id: b.id, name: b.name, ...businessSettings(b) })) });
    }

    if (path === "/api/businesses" && method === "POST") {
      const body = await readJson(request);
      const name = String(body?.business_name || body?.name || "").trim();
      if (!name || name.length > 200) return json({ error: "Nama usaha wajib diisi (maksimal 200 karakter)." }, 400);
      if (identity.kind === "google") {
        const count = (await qFirst(env, "SELECT COUNT(*) AS n FROM businesses WHERE owner_user_id = ?", identity.userId))?.n || 0;
        if (count >= MAX_BUSINESSES_PER_USER) return json({ error: `Maksimal ${MAX_BUSINESSES_PER_USER} usaha per akun.` }, 400);
      } else {
        // Sesi password hanya boleh membuat usaha legacy bila belum ada.
        const legacy = await qFirst(env, "SELECT id FROM businesses WHERE legacy = 1 LIMIT 1");
        if (legacy) return json({ error: "Usaha lama sudah ada. Hubungkan akun Google untuk mengelola usaha." }, 403);
      }
      const v = validateBusinessProfile(body);
      if (v.error) return json({ error: v.error }, 400);
      const now = new Date().toISOString();
      const values = { name, address: "", phone: "", website: "", logo: "", bank_name: "", bank_account_number: "", bank_account_holder: "", ...v.values };
      const res = await qRun(env,
        "INSERT INTO businesses (owner_user_id, legacy, name, address, phone, website, logo, bank_name, bank_account_number, bank_account_holder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        identity.kind === "google" ? identity.userId : null, identity.kind === "password" ? 1 : 0,
        values.name, values.address, values.phone, values.website, values.logo,
        values.bank_name, values.bank_account_number, values.bank_account_holder, now, now);
      const business = await qFirst(env, "SELECT * FROM businesses WHERE id = ?", res.meta.last_row_id);
      return json({ business: { id: business.id, name: business.name, ...businessSettings(business) } }, 201);
    }

    const businessIdMatch = path.match(/^\/api\/businesses\/(\d+)$/);
    if (businessIdMatch) {
      const id = Number(businessIdMatch[1]);
      const owned = await listBusinessesFor(env, identity);
      const business = owned.find((b) => b.id === id);
      if (!business) return json({ error: "Usaha tidak ditemukan atau bukan milik Anda." }, 403);
      if (method === "PUT") {
        const body = await readJson(request);
        if (!body) return json({ error: "Body JSON tidak valid." }, 400);
        const v = validateBusinessProfile(body);
        if (v.error) return json({ error: v.error }, 400);
        const sets = [];
        const params = [];
        for (const [key, value] of Object.entries(v.values)) {
          sets.push(`${BUSINESS_COLUMNS[key]} = ?`);
          params.push(value);
        }
        if (sets.length) {
          sets.push("updated_at = ?");
          params.push(new Date().toISOString());
          await qRun(env, `UPDATE businesses SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
        }
        const row = await qFirst(env, "SELECT * FROM businesses WHERE id = ?", id);
        return json({ business: { id: row.id, name: row.name, ...businessSettings(row) } });
      }
      if (method === "DELETE") {
        if (identity.kind !== "google") return json({ error: "Hapus usaha hanya bisa dari akun Google pemiliknya." }, 403);
        await qRun(env, "DELETE FROM job_items WHERE job_id IN (SELECT id FROM jobs WHERE business_id = ?)", id);
        await qRun(env, "DELETE FROM jobs WHERE business_id = ?", id);
        await qRun(env, "DELETE FROM customers WHERE business_id = ?", id);
        await qRun(env, "DELETE FROM service_prices WHERE business_id = ?", id);
        await qRun(env, "DELETE FROM businesses WHERE id = ?", id);
        return json({ ok: true });
      }
    }

    // ---- Semua endpoint data di bawah ini wajib punya usaha aktif ----
    const bizResolved = await resolveBusiness(request, env, identity);
    if (bizResolved.error) return json({ error: bizResolved.error, code: bizResolved.code || undefined }, bizResolved.status);
    const business = bizResolved.business;
    const bid = business.id;

    // ---- Pengaturan usaha: dibaca/ditulis dari baris businesses usaha
    // aktif (bukan lagi tabel settings global). Bentuk respons tetap sama
    // seperti dulu supaya form Pengaturan & invoice tidak berubah.
    if (path === "/api/settings" && (method === "GET" || method === "PUT")) {
      if (method === "GET") {
        return json({ settings: businessSettings(business) });
      }
      const body = await readJson(request);
      if (!body) return json({ error: "Body JSON tidak valid." }, 400);
      const v = validateBusinessProfile(body);
      if (v.error) return json({ error: v.error }, 400);
      const sets = [];
      const params = [];
      for (const [key, value] of Object.entries(v.values)) {
        sets.push(`${BUSINESS_COLUMNS[key]} = ?`);
        params.push(value);
      }
      if (sets.length) {
        sets.push("updated_at = ?");
        params.push(new Date().toISOString());
        await qRun(env, `UPDATE businesses SET ${sets.join(", ")} WHERE id = ?`, ...params, bid);
      }
      const row = await qFirst(env, "SELECT * FROM businesses WHERE id = ?", bid);
      return json({ settings: businessSettings(row) });
    }

    // ---- Pelanggan ----
    if (path === "/api/customers" && method === "GET") {
      await ensureNextVisitColumn(env);
      const q = (url.searchParams.get("q") || "").trim();
      const rows = q
        ? await qAll(env, "SELECT * FROM customers WHERE business_id = ? AND (name LIKE ? OR phone LIKE ?) ORDER BY name COLLATE NOCASE ASC LIMIT 200", bid, `%${q}%`, `%${q}%`)
        : await qAll(env, "SELECT * FROM customers WHERE business_id = ? ORDER BY name COLLATE NOCASE ASC LIMIT 500", bid);
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
        "INSERT INTO customers (business_id, name, address, phone, next_visit_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        bid, name, (body.address || "").trim(), (body.phone || "").trim(), nextVisit, now, now,
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
      const nJobs = (await qFirst(env, `SELECT COUNT(*) AS n FROM jobs WHERE business_id = ? AND customer_id IN (${ph})`, bid, ...ids))?.n || 0;
      const nCust = (await qFirst(env, `SELECT COUNT(*) AS n FROM customers WHERE business_id = ? AND id IN (${ph})`, bid, ...ids))?.n || 0;
      await ensureJobItemsTable(env);
      await qRun(env, `DELETE FROM job_items WHERE job_id IN (SELECT id FROM jobs WHERE business_id = ? AND customer_id IN (${ph}))`, bid, ...ids);
      await qRun(env, `DELETE FROM jobs WHERE business_id = ? AND customer_id IN (${ph})`, bid, ...ids);
      await qRun(env, `DELETE FROM customers WHERE business_id = ? AND id IN (${ph})`, bid, ...ids);
      return json({ ok: true, deleted_customers: nCust, deleted_jobs: nJobs });
    }

    if (path === "/api/jobs/bulk-delete" && method === "POST") {
      const body = await readJson(request);
      const ids = [...new Set((body?.ids || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
      if (!ids.length || ids.length > 200) return json({ error: "Pilih 1–200 transaksi." }, 400);
      const ph = ids.map(() => "?").join(",");
      const n = (await qFirst(env, `SELECT COUNT(*) AS n FROM jobs WHERE business_id = ? AND id IN (${ph})`, bid, ...ids))?.n || 0;
      await ensureJobItemsTable(env);
      await qRun(env, `DELETE FROM job_items WHERE job_id IN (${ph}) AND job_id IN (SELECT id FROM jobs WHERE business_id = ?)`, ...ids, bid);
      await qRun(env, `DELETE FROM jobs WHERE business_id = ? AND id IN (${ph})`, bid, ...ids);
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
        const existing = await qFirst(env, "SELECT * FROM customers WHERE id = ? AND business_id = ?", id, bid);
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
        await qRun(env, "DELETE FROM jobs WHERE business_id = ? AND customer_id = ?", bid, id);
        await qRun(env, "DELETE FROM customers WHERE business_id = ? AND id = ?", bid, id);
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
                 FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE j.business_id = ?`;
      const params = [bid];
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
      await ensurePaymentMethodColumn(env);
      const paidV = validatePaidAmount(body?.paid_amount, amount);
      if (paidV.error) return json({ error: paidV.error }, 400);
      const customer = await qFirst(env, "SELECT id FROM customers WHERE id = ? AND business_id = ?", customerId, bid);
      if (!customer) return json({ error: "Pelanggan tidak ditemukan." }, 404);
      const now = new Date().toISOString();
      const paymentMethod = validPaymentMethod(body?.payment_method);
      const bankText = String(body?.bank_text || "").trim().slice(0, 200);
      const res = await qRun(env,
        "INSERT INTO jobs (business_id, customer_id, service_type, amount, paid_amount, status, job_date, note, payment_method, bank_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        bid, customerId, serviceType, amount, paidV.paid, status, jobDate, (body.note || "").trim(), paymentMethod, bankText, now, now);
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
        await ensurePaymentMethodColumn(env);
        const existing = await qFirst(env, "SELECT * FROM jobs WHERE id = ? AND business_id = ?", id, bid);
        if (!existing) return json({ error: "Transaksi tidak ditemukan." }, 404);
        const paidV = validatePaidAmount(body?.paid_amount !== undefined ? body.paid_amount : existing.paid_amount, amount);
        if (paidV.error) return json({ error: paidV.error }, 400);
        const paymentMethod = body?.payment_method !== undefined ? validPaymentMethod(body.payment_method) : (existing.payment_method || "transfer");
        const bankText = body?.bank_text !== undefined ? String(body.bank_text || "").trim().slice(0, 200) : (existing.bank_text || "");
        await qRun(env, "UPDATE jobs SET service_type = ?, amount = ?, paid_amount = ?, status = ?, job_date = ?, note = ?, payment_method = ?, bank_text = ?, updated_at = ? WHERE id = ?",
          serviceType, amount, paidV.paid, status, jobDate, (body.note || "").trim(), paymentMethod, bankText, new Date().toISOString(), id);
        const row = await qFirst(env, "SELECT * FROM jobs WHERE id = ?", id);
        await saveJobItems(env, id, items);
        return json({ job: { ...row, items } });
      }
      if (method === "DELETE") {
        await ensureJobItemsTable(env);
        await qRun(env, "DELETE FROM job_items WHERE job_id = ? AND job_id IN (SELECT id FROM jobs WHERE business_id = ?)", id, bid);
        await qRun(env, "DELETE FROM jobs WHERE id = ? AND business_id = ?", id, bid);
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
      const rows = await qAll(env, "SELECT * FROM service_prices WHERE business_id = ? ORDER BY service_type ASC", bid);
      return json({ prices: rows });
    }
    if (path === "/api/service-prices" && method === "POST") {
      await ensureServicePricesTable(env);
      const body = await readJson(request);
      const serviceType = (body?.service_type || "").trim();
      const unit = (body?.unit || "").trim();
      const unitPrice = Number(body?.unit_price);
      if (!serviceType || serviceType.length > 100) return json({ error: "Nama jasa wajib diisi." }, 400);
      if (!ITEM_UNITS.includes(unit)) return json({ error: "Satuan tidak valid (kubik/strip/pcs/paket/tanki/titik)." }, 400);
      if (!Number.isSafeInteger(unitPrice) || unitPrice < 0) return json({ error: "Harga satuan harus angka >= 0." }, 400);
      const now = new Date().toISOString();
      const existing = await qFirst(env, "SELECT * FROM service_prices WHERE business_id = ? AND LOWER(service_type) = LOWER(?)", bid, serviceType);
      if (existing) {
        await qRun(env, "UPDATE service_prices SET service_type = ?, unit = ?, unit_price = ?, updated_at = ? WHERE id = ? AND business_id = ?", serviceType, unit, unitPrice, now, existing.id, bid);
        return json({ price: await qFirst(env, "SELECT * FROM service_prices WHERE id = ? AND business_id = ?", existing.id, bid) });
      }
      const res = await qRun(env, "INSERT INTO service_prices (business_id, service_type, unit, unit_price, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", bid, serviceType, unit, unitPrice, now, now);
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
        if (!ITEM_UNITS.includes(unit)) return json({ error: "Satuan tidak valid (kubik/strip/pcs/paket/tanki/titik)." }, 400);
        if (!Number.isSafeInteger(unitPrice) || unitPrice < 0) return json({ error: "Harga satuan harus angka >= 0." }, 400);
        const clash = await qFirst(env, "SELECT * FROM service_prices WHERE business_id = ? AND LOWER(service_type) = LOWER(?) AND id != ?", bid, serviceType, id);
        if (clash) return json({ error: "Nama jasa sudah ada di daftar harga." }, 400);
        await qRun(env, "UPDATE service_prices SET service_type = ?, unit = ?, unit_price = ?, updated_at = ? WHERE id = ? AND business_id = ?", serviceType, unit, unitPrice, new Date().toISOString(), id, bid);
        const row = await qFirst(env, "SELECT * FROM service_prices WHERE id = ? AND business_id = ?", id, bid);
        if (!row) return json({ error: "Harga jasa tidak ditemukan." }, 404);
        return json({ price: row });
      }
      if (method === "DELETE") {
        await qRun(env, "DELETE FROM service_prices WHERE id = ? AND business_id = ?", id, bid);
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
      // Validasi lolos semua — baru sekarang ganti data USAHA AKTIF ini saja
      // (usaha lain tidak tersentuh). ID dari file cadangan TIDAK dipakai:
      // tiap baris dapat id baru dan relasi pelanggan–transaksi dipetakan
      // ulang, supaya restore tidak bentrok dengan id usaha lain.
      await qRun(env, "CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, business_id INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', next_visit_date TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      await ensureNextVisitColumn(env);
      await qRun(env, "CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, business_id INTEGER NOT NULL DEFAULT 0, customer_id INTEGER NOT NULL REFERENCES customers(id), service_type TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0, paid_amount INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'lunas', job_date TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', payment_method TEXT NOT NULL DEFAULT 'transfer', bank_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      await ensureServicePricesTable(env);
      await ensureJobItemsTable(env);
      await qRun(env, "DELETE FROM job_items WHERE job_id IN (SELECT id FROM jobs WHERE business_id = ?)", bid);
      await qRun(env, "DELETE FROM jobs WHERE business_id = ?", bid);
      await qRun(env, "DELETE FROM customers WHERE business_id = ?", bid);
      await qRun(env, "DELETE FROM service_prices WHERE business_id = ?", bid);
      const now = new Date().toISOString();
      const custIdMap = new Map();
      for (const c of body.customers) {
        const res = await qRun(env, "INSERT INTO customers (business_id, name, address, phone, next_visit_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", bid, c.name.trim(), (c.address || "").trim(), (c.phone || "").trim(), c.next_visit_date || null, c.created_at || now, c.updated_at || now);
        custIdMap.set(c.id, res.meta.last_row_id);
      }
      for (const p of prices) {
        await qRun(env, "INSERT INTO service_prices (business_id, service_type, unit, unit_price, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", bid, p.service_type.trim(), p.unit, p.unit_price, p.created_at || now, p.updated_at || now);
      }
      {
        const sets = [];
        const params = [];
        for (const [key, value] of Object.entries(settingsOut)) {
          sets.push(`${BUSINESS_COLUMNS[key]} = ?`);
          params.push(value);
        }
        if (sets.length) {
          sets.push("updated_at = ?");
          params.push(now);
          await qRun(env, `UPDATE businesses SET ${sets.join(", ")} WHERE id = ?`, ...params, bid);
        }
      }
      for (const j of body.jobs) {
        const paid = j.paid_amount === undefined ? 0 : j.paid_amount;
        const newCustId = custIdMap.get(j.customer_id);
        if (!newCustId) continue;
        const res = await qRun(env, "INSERT INTO jobs (business_id, customer_id, service_type, amount, paid_amount, status, job_date, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", bid, newCustId, j.service_type.trim(), j.amount, paid, j.status, j.job_date, (j.note || "").trim(), j.created_at || now, j.updated_at || now);
        const newJobId = res.meta.last_row_id;
        const items = Array.isArray(j.items) && j.items.length
          ? j.items
          : [{ service_type: j.service_type, qty: 1, unit: "paket", unit_price: j.amount, amount: j.amount }];
        for (const it of items) {
          await qRun(env, "INSERT INTO job_items (job_id, service_type, qty, unit, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?)", newJobId, it.service_type, it.qty, it.unit, it.unit_price, it.amount);
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
         FROM jobs WHERE business_id = ? AND job_date BETWEEN ? AND ?`, bid, from, to);
      const jobsRaw = await qAll(env,
        `SELECT j.*, c.name AS customer_name FROM jobs j JOIN customers c ON c.id = j.customer_id
         WHERE j.business_id = ? AND j.job_date BETWEEN ? AND ? ORDER BY j.job_date DESC, j.id DESC`, bid, from, to);
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
         WHERE j.business_id = ? AND j.job_date BETWEEN ? AND ? ORDER BY j.job_date ASC, j.id ASC`, bid, from, to);
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
