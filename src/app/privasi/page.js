export const metadata = {
  title: "Kebijakan Privasi — Pencatat Laporan",
  description: "Kebijakan privasi Pencatat Laporan: data yang dikumpulkan dan cara penggunaannya.",
};

const sections = [
  {
    title: "1. Data yang dikumpulkan",
    body: "Saat masuk dengan Google, kami menerima nama, alamat email, dan foto profil dari akun Google Anda. Di dalam aplikasi, kami menyimpan data usaha yang Anda masukkan: profil usaha, data pelanggan, transaksi, dan harga layanan. Kami juga memakai cookie sesi untuk menjaga Anda tetap masuk.",
  },
  {
    title: "2. Penggunaan data",
    body: "Data dipakai hanya untuk menjalankan layanan: proses masuk, menampilkan data usaha Anda, menyusun laporan, dan membuat invoice. Data Anda tidak dijual kepada pihak ketiga.",
  },
  {
    title: "3. Pemisahan data",
    body: "Data setiap usaha terpisah dan hanya dapat diakses oleh pemilik usaha tersebut. Usaha lain tidak dapat melihat data usaha Anda.",
  },
  {
    title: "4. Cookie",
    body: "Kami memakai satu cookie sesi (HttpOnly) untuk menjaga status login Anda selama 7 hari. Cookie ini tidak dipakai untuk pelacakan iklan.",
  },
  {
    title: "5. Penyimpanan data",
    body: "Data disimpan pada infrastruktur Cloudflare yang dipakai layanan ini. Akses ke data dibatasi pada keperluan operasional layanan.",
  },
  {
    title: "6. Penghapusan data",
    body: "Menghapus sebuah usaha akan menghapus seluruh data usaha tersebut dan tidak dapat dipulihkan. Untuk meminta penghapusan akun beserta seluruh datanya, hubungi pengelola layanan.",
  },
  {
    title: "7. Perubahan kebijakan",
    body: "Kebijakan ini dapat diperbarui sewaktu-waktu. Versi terbaru berlaku sejak diterbitkan di halaman ini.",
  },
];

export default function Privasi() {
  return (
    <main className="min-h-screen px-4 pb-16">
      <div className="max-w-2xl mx-auto pt-10">
        <a href="/" className="text-zinc-400 hover:text-persona text-sm">← Kembali ke Login</a>
        <h1 className="font-bold text-3xl tracking-tight mt-6">Kebijakan Privasi</h1>
        <p className="text-zinc-400 text-sm mt-1">Terakhir diperbarui: 19 November 2026</p>
        <div className="bg-panel border border-line rounded-[28px] p-6 mt-6 shadow-xl space-y-6">
          {sections.map((s) => (
            <section key={s.title}>
              <h2 className="font-bold text-lg">{s.title}</h2>
              <p className="text-zinc-400 text-sm leading-relaxed mt-1">{s.body}</p>
            </section>
          ))}
        </div>
        <p className="text-zinc-500 text-xs text-center mt-6">© 2026 Pencatat Laporan</p>
      </div>
    </main>
  );
}
