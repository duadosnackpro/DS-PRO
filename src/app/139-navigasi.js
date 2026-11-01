/* ---------- Navigasi: tombol Kembali (P1, UX-03) ----------
   Aplikasi satu halaman: sheet dan sub-layar tidak punya entri riwayat, jadi gestur Kembali di Android bisa langsung keluar dari PWA (keranjang tetap tersimpan, tetapi alur terputus).
   Pola "perangkap": satu entri riwayat cadangan (state {duado: 1}) berada di atas entri dasar ({duado: 0}). Kembali jatuh ke entri dasar, lalu navDecide() memutuskan apa yang terjadi
   dan perangkap dipasang lagi. Navigasi lewat UI (tombol, chip "← Menu") tidak menyentuh riwayat, jadi tidak ada sinkronisasi dua arah yang bisa melenceng.
   Keputusan (urut): belum masuk = biarkan; permintaan berjalan = abaikan; sheet terbuka = tutup (bila boleh); sub-layar = kembali ke layar asal atau Menu (pengaturan yang belum disimpan
   minta Kembali dua kali); layar utama = "tekan sekali lagi untuk keluar", perangkap dicabut sebentar agar Kembali kedua benar-benar keluar.
   Chrome Android mengabaikan entri riwayat yang dibuat tanpa interaksi pengguna, maka perangkap dipasang pada sentuhan/tombol pertama setelah masuk (navArm), bukan saat memuat. */
const NAV = {cur: null, prev: null, armedUntil: 0, t: 0};
const NAV_EXIT_MS = 3000;
const navIsRoot = tab => ['dash', 'kasir', 'stok', 'produksi', 'menu'].indexOf(tab) >= 0 || (tab === 'riwayat' && !own());
/** @param {{auth:boolean,busy:boolean,sheet:boolean,closable:boolean,root:boolean,dirty:boolean,armed:boolean}} c */
function navDecide(c) {
  if (!c.auth) return 'leave';
  if (c.busy) return 'stay';
  if (c.sheet) return c.closable ? 'sheet' : 'stay';
  if (!c.root) return c.dirty && !c.armed ? 'warn-dirty' : 'screen';
  return 'warn-exit';
}
const sheetClosable = () => { const b = $('#sheet'); return !!b && !b.hidden && (!S.opin || S.opin.kind === 'alasan' || S.opin.kind === 'konfirm') && !S.busyOn; }; // sama dengan syarat tombol Esc
function navNote() { if (S.tab !== NAV.cur) { NAV.prev = NAV.cur; NAV.cur = S.tab; failClear(); } } // dipanggil render(): ingat layar asal; galat layar lama tidak ikut terbawa
function navArm() {
  clearTimeout(NAV.t);
  if (!(S.token && S.data)) return;
  const st = history.state; if (st && st.duado === 1) return; // sudah terpasang (mis. setelah muat ulang)
  try { if (!st || st.duado !== 0) history.replaceState({duado: 0}, ''); history.pushState({duado: 1}, ''); } catch (e) { /* riwayat tak bisa diubah: Kembali berperilaku seperti biasa */ }
}
function navBack(/** @type {PopStateEvent} */ e) {
  if (e.state && e.state.duado === 1) return; // maju ke perangkap (tombol Maju di desktop): tidak ada yang perlu dilakukan
  const b = $('#sheet'), now = Date.now();
  const act = navDecide({auth: !!(S.token && S.data), busy: !!S.busyOn, sheet: !!b && !b.hidden, closable: sheetClosable(), root: navIsRoot(S.tab), dirty: !!S.dirty, armed: now < NAV.armedUntil});
  if (act === 'leave') return;
  if (act === 'sheet') dismissSheet();
  else if (act === 'screen') { S.dirty = false; S.tab = NAV.prev && navIsRoot(NAV.prev) && tabAllowed(NAV.prev) ? NAV.prev : tabAllowed('menu') ? 'menu' : homeTab(); render(); }
  else if (act === 'warn-dirty') { NAV.armedUntil = now + NAV_EXIT_MS; toast('Perubahan belum disimpan. Tekan Kembali sekali lagi untuk membuangnya.'); }
  else if (act === 'warn-exit') {
    NAV.armedUntil = now + NAV_EXIT_MS; toast((S.cart && S.cart.length ? 'Keranjang masih terisi dan tersimpan. ' : '') + 'Tekan Kembali sekali lagi untuk keluar.');
    NAV.t = setTimeout(navArm, NAV_EXIT_MS); return; // tanpa perangkap selama jendela ini: Kembali kedua keluar dari aplikasi
  }
  navArm();
}
window.addEventListener('popstate', navBack);
['pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, () => { if (S.token && S.data && Date.now() >= NAV.armedUntil) navArm(); }, {capture: true, passive: true}));
