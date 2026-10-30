/* ---------- Kerangka ---------- */
const MENU_TABS = ['menu', 'master', 'users', 'settings', 'resep', 'laporan', 'shopee', 'cek', 'diag', 'tutup', 'transfer'];
function render() {
  if (!S.token || !S.data) return renderLogin();
  if (!tabAllowed(S.tab)) S.tab = homeTab();
  const d = S.data; if (!S.ch || !d.channels.some(c => c.id === S.ch)) S.ch = d.channels[0] && d.channels[0].id;
  const o = own(), tabs = [['dash', 'Beranda'], ['kasir', 'Kasir'], ['riwayat', 'Riwayat'], ['stok', 'Stok'], ['produksi', 'Produksi'], ['menu', 'Menu']].filter(t => tabAllowed(t[0]) && !(o && t[0] === 'riwayat')),
    inMenu = MENU_TABS.concat(o ? ['riwayat'] : []).indexOf(S.tab) >= 0;
  $('#app').innerHTML = '<header class="top"><img class="logo" src="icons/icon-192.png" alt="" width="38" height="38"><div class="brand"><b class="wordmark">' + esc(String(d.settings.nama_usaha || 'Duado Snack').toUpperCase()) + '</b>' + outletLabel() + '</div><button class="badge" id="badge" data-act="queue" aria-label="Status sinkronisasi"></button></header><div class="accent"></div><main id="main"></main><div id="cartbar"></div>' +
    '<nav class="nav" aria-label="Menu utama">' + tabs.map(t => { const on = S.tab === t[0] || (t[0] === 'menu' && inMenu); return '<button data-act="tab" data-t="' + t[0] + '"' + (on ? ' aria-current="page"' : '') + ' class="' + (on ? 'on' : '') + '"><span class="ni">' + svg(t[0], 22) + '</span><span>' + t[1] + '</span></button>'; }).join('') + '</nav>';
  badge();
  (APP.views[S.tab] || vKasir)();
  cartbar();
}
function badge() {
  const b = $('#badge');
  if (b) {
    const mineQ = S.data ? mineAll() : S.queue, p = mineQ.filter(q => q.status === 'pending').length, r = mineQ.filter(q => q.status === 'review').length, off = !navigator.onLine, busyNow = pending > 0 || mineQ.some(q => q.state === 'sending');
    let cls, txt;
    if (r) { cls = 'warn'; txt = r + ' perlu ditinjau'; }
    else if (off) { cls = 'off'; txt = 'Offline' + (p ? ' · ' + p : ''); }
    else if (busyNow) { cls = 'wait spin'; txt = 'Menyinkronkan'; }
    else if (p) { cls = 'wait'; txt = 'Menunggu kirim ' + p; }
    else { cls = 'ok'; txt = 'Tersinkron'; }
    b.className = 'badge ' + cls; b.textContent = txt;
  }
  qstatUpd(); if (S.qopen && !$('#sheet').hidden) queueSheet();
}
function qstatUpd() {
  const el = $('#qstat'); if (!el) return;
  const mineQ = S.data ? mineAll() : [], p = mineQ.filter(q => q.status === 'pending').length, r = mineQ.filter(q => q.status === 'review').length, sending = mineQ.some(q => q.state === 'sending'), off = !navigator.onLine;
  if (!p && !r && !off) { el.className = ''; el.innerHTML = ''; return; }
  const msg = r ? r + ' transaksi ditolak server, perlu ditinjau' : sending ? 'Mengirim ' + p + ' transaksi…' : off ? (p ? 'Offline: ' + p + ' transaksi tersimpan di perangkat, dikirim otomatis saat online' : 'Mode offline: transaksi tetap tersimpan di perangkat dan dikirim saat online') : p + ' transaksi menunggu dikirim';
  el.className = 'qstat ' + (r ? 'err' : off ? 'off' : 'wait'); el.innerHTML = '<span class="qdot"></span><span class="qt">' + esc(msg) + '</span>' + svg('chev', 16);
}
const qrefresh = () => { if (S.qopen && !$('#sheet').hidden) queueSheet(); else if (S.tab === 'riwayat') vRiwayat(); };
/* Visualizer antrean (v1.9.8). Setiap transaksi yang ditolak server diklasifikasikan (qinfo) agar kasir tahu APA yang terjadi dan APA yang harus dilakukan, bukan sekadar
   "Perlu ditinjau". Uang pelanggan mungkin sudah diterima, jadi transaksi bermasalah dimunculkan otomatis (notifyConflicts) sekali per kegagalan. */
function qinfo(q) {
  const e = String(q.error || '');
  if (/^Diskon/.test(e)) return {t: 'Butuh persetujuan Owner', h: 'Diskon melebihi batas kasir. Owner menyetujui dengan PIN (diverifikasi server), lalu transaksi dikirim ulang.', auth: true};
  /* F3: total struk yang berbeda dari hitungan server TIDAK punya jalur persetujuan di server. Dulu tombol "Otorisasi Owner" hanya menaruh token di antrean lokal tanpa efek. Kini: perbarui data lalu coba lagi, atau hapus dengan alasan (dicatat di server). */
  if (/^Total struk/.test(e)) return {t: 'Total berbeda dari hitungan server', h: 'Harga atau pengaturan berubah sejak transaksi dibuat. Karena barang dan uang sudah berpindah, pilih "Terima harga server": transaksi dicatat dengan harga server dan ditandai agar Owner meninjaunya. Hapus hanya bila transaksi memang batal (perlu persetujuan Owner).', accept: true};
  if (/^Stok .* tidak cukup/.test(e)) return {t: 'Stok di server kurang', h: 'Stok server lebih kecil dari yang terjual (mis. ada opname/transfer saat offline). Pilih "Terima harga server": penjualan dicatat, stok menjadi minus, dan transaksi ditandai agar Owner meninjau dan melakukan opname.', accept: true};
  if (/Buka sesi kasir/.test(e)) return {t: 'Kasir belum dibuka', h: 'Buka kasir di Menu, Tutup kasir (isi modal awal), lalu Coba lagi.'};
  if (/Harga belum diatur|Channel tidak valid/.test(e)) return {t: 'Harga atau channel berubah di server', h: 'Perbarui data (Menu, Perbarui), lalu Coba lagi. Bila produk memang tidak dijual lagi, Hapus dengan alasan.'};
  if (/Varian (tidak ditemukan|nonaktif)|Jumlah tidak valid/.test(e)) return {t: 'Produk dihapus atau dinonaktifkan', h: 'Produk di transaksi ini sudah tidak aktif. Minta Owner mengaktifkannya lalu Coba lagi, atau Hapus dengan alasan.'};
  if (/Metode bayar/.test(e)) return {t: 'Metode bayar dinonaktifkan', h: 'Minta Owner mengaktifkan metode ini di Pengaturan lalu Coba lagi, atau Hapus dengan alasan.'};
  if (/tersangkut setengah jalan/.test(e)) return {t: 'Tersangkut di server', h: 'Jangan dihapus. Minta Owner menyelesaikannya di Menu, Pemeriksaan data, lalu Coba lagi.'};
  return {t: 'Ditolak server', h: 'Bila uang pelanggan sudah diterima, jangan diabaikan: Coba lagi, atau Hapus dengan alasan agar tercatat di server.'};
}
function qitems(q) { // isi transaksi dalam kata-kata (maks. 5 baris, sisanya diringkas)
  const its = q.payload.items, shown = its.slice(0, 5).map(it => { const v = vById(it.variant_id); return esc((v ? vName(v) + (vSub(v) ? ' ' + vSub(v) : '') : '(produk tidak ada)') + ' ×' + qf(it.qty)); });
  return shown.join(', ') + (its.length > 5 ? ' +' + (its.length - 5) + ' lainnya' : '');
}
function notifyConflicts() {
  if (!S.data || !S.token) return;
  const bad = mineAll().filter(q => q.status === 'review' && !q.alerted); if (!bad.length) { S.conflictPending = false; return; }
  if (!$('#sheet').hidden || S.busyOn) { S.conflictPending = true; return; } // jangan memotong pembayaran atau struk yang sedang tampil: ditampilkan setelah layar itu ditutup
  S.conflictPending = false; bad.forEach(q => { q.alerted = true; }); LS.set('queue', S.queue); queueSheet();
}
function queueSheet() {
  S.qopen = true; const all = S.data ? mineAll() : S.queue, off = !navigator.onLine, rev = all.filter(q => q.status === 'review'), mineQ = rev.concat(all.filter(q => q.status !== 'review')), retryable = rev.filter(q => !qinfo(q).auth).length;
  const secs = n => n < 60 ? n + ' detik' : Math.round(n / 60) + ' menit', next = S.nextFlush && S.nextFlush > Date.now() ? 'Percobaan otomatis berikutnya sekitar ' + secs(Math.round((S.nextFlush - Date.now()) / 1000)) + '.' : '';
  const item = q => { const i = S.queue.indexOf(q), n = q.payload.items.reduce((a, x) => a + x.qty, 0), st = q.status === 'review' ? '<span class="tag red">Perlu ditinjau</span>' : q.state === 'sending' ? '<span class="tag busy">Mengirim…</span>' : '<span class="tag">Menunggu</span>', nf = q.status === 'review' ? qinfo(q) : null;
    return '<div class="li" style="display:block"><div class="kv"><b>' + rp(q.total) + '</b>' + st + '</div><div class="muted">' + esc(fmtDT(q.ts).slice(11)) + ' · ' + esc(q.ch) + ' · ' + n + ' item' + (q.tries ? ' · percobaan ke-' + q.tries : '') + '</div>' +
      '<div class="qitems">' + qitems(q) + '</div>' + (nf ? '<div class="qwhy"><b>' + esc(nf.t) + '</b><div>' + esc(nf.h) + '</div></div>' : '') + (q.error ? '<div style="color:var(--err);font-size:13px">' + esc(q.error) + '</div>' : '') +
      (q.status === 'review' ? '<div class="row2">' + (nf.auth ? '<button class="btn pri sm" data-act="qauth" data-i="' + i + '">Otorisasi Owner</button>' : '') + (nf.accept ? '<button class="btn pri sm" data-act="qaccept" data-i="' + i + '">Terima harga server</button>' : '') + '<button class="btn sec sm" data-act="qretry" data-i="' + i + '">Coba lagi</button><button class="btn dan sm" data-act="qdel" data-i="' + i + '">Hapus</button></div>' : '') + '</div>'; };
  sheet('<div class="grab"></div><h2>Antrean transaksi</h2>' + (rev.length ? '<div class="qwarn" role="alert"><b>' + rev.length + ' transaksi tidak bisa dikirim.</b> Uang pelanggan mungkin sudah diterima, jadi jangan diabaikan. Pilih tindakan di tiap transaksi.</div>' : '') +
    '<div class="qs-top"><span class="tag ' + (off ? '' : 'grn') + '">' + (off ? 'Offline' : 'Online') + '</span><span class="muted">Terakhir sinkron: ' + (S.lastSync ? fmtDT(S.lastSync).slice(11) : '-') + ' · penyimpanan: ' + Store.mode() + '</span></div>' +
    (mineQ.length ? mineQ.slice(0, lim('q')).map(item).join('') + moreBtn('q', mineQ.length) : '<div class="okmark sm">' + svg('check', 22) + '</div><p class="muted" style="text-align:center">Semua transaksi sudah terkirim ke server.</p>') + (next ? '<p class="muted">' + next + '</p>' : '') +
    (retryable > 1 ? '<button class="btn sec" data-act="qretryall">Coba lagi semua (' + retryable + ')</button>' : '') +
    (mineQ.some(q => q.status === 'pending') ? '<button class="btn pri" data-act="qnow">Kirim sekarang</button>' : '') + '<button class="btn sec" data-act="close">Tutup</button>');
  S.qopen = true; watchMore();
}
