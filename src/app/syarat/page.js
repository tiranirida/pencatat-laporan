export const metadata = {
  title: "Syarat Layanan — Pencatat Laporan",
  description: "Syarat penggunaan layanan Pencatat Laporan.",
};

const sections = [
  {
    title: "1. Layanan",
    body: "Pencatat Laporan adalah aplikasi pencatatan pelanggan jasa dan laporan pemasukan harian sampai bulanan. Layanan ini disediakan untuk membantu pemilik usaha jasa mencatat pelanggan, transaksi, dan laporan keuangannya.",
  },
  {
    title: "2. Akun",
    body: "Pendaftaran dan masuk menggunakan akun Google. Satu akun Google dapat membuat sampai 5 usaha. Setiap usaha memiliki datanya sendiri yang terpisah dari usaha lain. Pemilik akun bertanggung jawab menjaga keamanan akun Google yang digunakannya untuk masuk.",
  },
  {
    title: "3. Data pengguna",
    body: "Pengguna bertanggung jawab atas kebenaran data pelanggan, transaksi, dan harga layanan yang dimasukkannya. Jangan memasukkan data yang melanggar hukum atau hak orang lain.",
  },
  {
    title: "4. Penggunaan yang dilarang",
    body: "Layanan tidak boleh dipakai untuk penipuan, spam, penyebaran konten yang melanggar hukum, atau mengakses data milik usaha lain. Pelanggaran dapat menyebabkan akun atau usaha ditangguhkan dan datanya dihapus.",
  },
  {
    title: "5. Ketersediaan layanan",
    body: "Layanan disediakan apa adanya dan dapat berubah atau dihentikan dengan pemberitahuan terlebih dahulu. Tidak ada jaminan layanan selalu tersedia tanpa gangguan.",
  },
  {
    title: "6. Penghapusan usaha",
    body: "Pemilik usaha dapat menghapus usahanya sendiri. Data usaha yang sudah dihapus tidak dapat dipulihkan.",
  },
  {
    title: "7. Perubahan syarat",
    body: "Syarat ini dapat diperbarui sewaktu-waktu. Versi terbaru berlaku sejak diterbitkan di halaman ini.",
  },
];

export default function Syarat() {
  return (
    <main className="min-h-screen px-4 pb-16">
      <div className="max-w-2xl mx-auto pt-10">
        <a href="/" className="text-zinc-400 hover:text-persona text-sm">← Kembali ke Login</a>
        <h1 className="font-bold text-3xl tracking-tight mt-6">Syarat Layanan</h1>
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
