import "./globals.css";

export const metadata = {
  title: "Pencatat Laporan",
  description: "Pencatat pelanggan jasa dan laporan pemasukan harian sampai bulanan.",
  manifest: "/manifest.json",
  appleWebApp: { capable: true, title: "Pencatat Laporan", statusBarStyle: "black-translucent" },
  icons: { icon: "/icon-192.png", apple: "/icon-192.png" },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0284C7",
};

export default function RootLayout({ children }) {
  return (
    <html lang="id">
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{ if (localStorage.getItem('pencatat-theme') === 'light') document.documentElement.classList.add('theme-light'); var s = localStorage.getItem('pencatat-scheme'); var hex = { blue: '#0284C7', red: '#DC2626', green: '#16A34A', orange: '#EA580C', white: '#64748B', black: '#171717' }; if (s && hex[s]) { if (s !== 'blue') document.documentElement.classList.add('theme-' + s); var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', hex[s]); } }catch(e){}`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.addEventListener('beforeinstallprompt', function(e){ e.preventDefault(); window.__pencatatInstallPrompt = e; }); if ('serviceWorker' in navigator) { var refreshing = false; navigator.serviceWorker.addEventListener('controllerchange', function(){ if (!refreshing) { refreshing = true; window.location.reload(); } }); window.addEventListener('load', function(){ navigator.serviceWorker.register('/sw.js').catch(function(){}); }); }`,
          }}
        />
        {children}
      </body>
    </html>
  );
}
