// Service worker. Dua jalur (v1.9.8):
//  1) Aset INTI (CORE: index, css, js, ikon, font) = cache-first, terkunci per versi. Disimpan SEMUA sekaligus saat pemasangan (cache: 'reload' agar melewati cache HTTP
//     GitHub Pages); satu gagal = pemasangan batal. Sengaja TIDAK stale-while-revalidate: app.js, modules.js, config.js dan sw.js harus berasal dari rilis yang sama, sedangkan
//     SWR per berkas bisa menyimpan campuran versi lama dan baru (mis. saat GitHub Pages belum selesai menyebar) dan merusak aplikasi di tengah shift.
//     Pembaruan inti terjadi HANYA lewat penaikan VERSION di bawah (naikkan juga CONFIG.VERSION di js/config.js). Versi baru menunggu (tanpa skipWaiting otomatis) sampai
//     kasir menekan "Muat ulang" di banner; halaman juga menunda pemuatan ulang sampai tidak ada layar/permintaan yang berjalan (lihat 14-mulai.js).
//     Pada tingkat paket, ini sudah berperilaku stale-while-revalidate: browser memeriksa sw.js di latar belakang (updateViaCache: 'none') sementara versi lama tetap melayani.
//  2) Aset lain milik situs sendiri (di luar CORE) = stale-while-revalidate: dijawab dari cache seketika, lalu diperbarui di latar belakang untuk pemakaian berikutnya.
const VERSION = 'duado-v2.5.6';
const CORE = ['./', 'index.html', 'css/app.css', 'js/config.js', 'js/sb-adapter.js', 'js/app.js', 'js/modules.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-192.png', 'icons/icon-maskable-512.png', 'fonts/baloo2-600.woff2', 'fonts/baloo2-800.woff2'];
const OPTIONAL = []; // v1.9.7: font dan ikon kini dikirim di dalam paket dan wajib ada (diperiksa tests/release_check.js), jadi masuk CORE
const FOTO = 'duado-foto'; // cache foto produk: TIDAK ikut versi (tidak dihapus saat pembaruan); alamat foto tidak pernah berubah isinya, jadi aman cache-first. Isinya dirapikan oleh aplikasi (fotoWarm).
const fresh = u => fetch(new Request(u, {cache: 'reload'}));
const COREURL = new Set(CORE.map(u => new URL(u, /** @type {any} */ (self).registration.scope).href));
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(async c => {
    await Promise.all(CORE.map(async u => { const r = await fresh(u); if (!r.ok) throw new Error('Gagal memuat ' + u + ' (' + r.status + ')'); await c.put(u, r); })); // satu aset gagal = pemasangan dibatalkan, versi lama tetap dipakai
    await Promise.all(OPTIONAL.map(u => fresh(u).then(r => r.ok ? c.put(u, r) : null).catch(() => {})));
  })); // sengaja tanpa skipWaiting otomatis: menunggu pengguna menekan "Muat ulang"
});
self.addEventListener('message', e => { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== FOTO).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request, fu = new URL(r.url);
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return; // API (Supabase) dan situs lain tidak pernah lewat cache
  const core = r.mode === 'navigate' || COREURL.has(fu.origin + fu.pathname); let bgDone; /** @type {any} */ (e).waitUntil(new Promise(res => { bgDone = res; })); // waitUntil dipanggil sinkron; diselesaikan setelah pembaruan latar belakang
  const net = () => fetch(r).then(res => { if (res.ok && res.type === 'basic') { const cp = res.clone(); caches.open(VERSION).then(c => c.put(r, cp)).catch(() => {}); } return res; });
  e.respondWith(caches.match(r, {ignoreSearch: true}).then(hit => {
    if (hit && core) { bgDone(); return hit; } // inti: cache-first murni, tidak ada permintaan jaringan di belakang layar
    if (hit) { net().catch(() => {}).then(bgDone); return hit; } // non-inti: stale-while-revalidate
    return net().then(res => { bgDone(); return res; }, () => { bgDone(); return r.mode === 'navigate' ? caches.match('index.html') : Response.error(); });
  }));
});
