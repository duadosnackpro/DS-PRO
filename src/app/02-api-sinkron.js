/* ---------- API dan sinkronisasi ---------- */
let pending = 0;
const QUIET = {ping: 1, 'stock.get': 1, bootstrap: 1, login: 1, logout: 1, 'client.log': 1, 'client.errors': 1}; // aksi yang tidak memicu pemeriksaan versi (mereka sendiri yang menyinkronkan)
let staleT = null, seenV = ''; // seenV: versi terbaru yang pernah terlihat di jawaban server
function staleSoon() { if (staleT) return; staleT = setTimeout(() => { staleT = null; if (S.data && dverKey() !== seenV) checkUpdates(true); }, 400); } // bila saat timer berjalan data sudah sama dengan versi terakhir yang terlihat, tak perlu ping
function netState() { document.body.classList.toggle('net', pending > 0); badge(); }
async function api(action, payload, opt) {
  if (!window.SBAPI || !window.SBAPI.enabled()) throw new Error('SUPABASE_URL / SUPABASE_KEY belum diisi di js/config.js');
  const silent = !!(opt && opt.silent); if (!silent) { pending++; netState(); }
  try {
    return await window.SBAPI.call(action, payload, S.token, t => { S.token = t; LS.set('token', t); });
  } finally { if (!silent) { pending--; netState(); } }
}
/* Animasi loading: overlay untuk aksi simpan/muat ulang, bar di atas untuk semua panggilan server, skeleton untuk daftar */
async function busy(label, fn) {
  if (S.busyOn) return; S.busyOn = true;
  const el = $('#busy'); el.innerHTML = '<div class="busybox"><div class="loader"></div><div class="lbl">' + esc(label) + '</div></div>'; el.hidden = false;
  try { return await fn(); } finally { S.busyOn = false; el.hidden = true; el.innerHTML = ''; if (S.conflictPending && $('#sheet').hidden) setTimeout(notifyConflicts, 400); }
}
function busyLabel(t) { const l = document.querySelector('#busy .lbl'); if (l) l.textContent = t; }
const skel = n => Array.from({length: n || 3}, () => '<div class="sk"></div>').join('');
const sameOutlet = q => !q.payload.outlet_id || !S.data || !S.data.outlet || q.payload.outlet_id === S.data.outlet.id; // antrean outlet lain tidak memengaruhi stok outlet aktif
function applyQueueStock() {
  S.queue.forEach(q => { if (q.status === 'pending' && sameOutlet(q)) q.payload.items.forEach(it => { const v = vById(it.variant_id); if (v) v.stok = (Number(v.stok) || 0) - it.qty; }); });
}
async function loadData() { S.data = await api('bootstrap'); applyQueueStock(); S.lastSync = lastChk = Date.now(); // muat penuh = sekaligus pemeriksaan versi, ping berikutnya tidak perlu segera
  LS.set('lastsync', S.lastSync); LS.set('data', S.data); rtEnsure(); bootOnce(); if (S.cat !== 'Semua' && !S.data.products.some(p => p.kategori === S.cat)) S.cat = 'Semua'; setTimeout(fotoWarm, 1500); }
async function refreshStock() { // menyegarkan stok produk jadi dari server; false bila server belum mengenal stock.get (klien memuat penuh)
  let r; try { r = await api('stock.get', {}, {silent: true}); } catch (e) { if (e.server && /Aksi tidak dikenal/.test(e.message)) return false; throw e; }
  S.data.variants.forEach(v => { if (r.stok[v.id] !== undefined) v.stok = r.stok[v.id]; });
  applyQueueStock(); S.data.stock_ver = r.stock_ver; S.data.ver = r.ver; S.lastSync = lastChk = Date.now(); LS.set('lastsync', S.lastSync); LS.set('data', S.data); return true;
}
/* Sinkronisasi hanya bila perlu: ping senyap (hanya membaca versi di cache server, murah) lalu memuat ulang HANYA bagian yang berubah: katalog penuh bila cat_ver
   berubah, peta stok kecil bila hanya stock_ver (penjualan perangkat lain). Tanpa polling berkala; pemeriksaan terjadi saat aplikasi dibuka/kembali ke depan, saat online,
   saat membuka Beranda/Riwayat, dan bila jawaban server apa pun memuat versi yang belum dikenal. Permintaan serentak digabung menjadi satu ping.
   verSync -> 'cat' | 'stock' (ada yang dimuat ulang) | '' (sudah terbaru) | null (server tidak terjangkau). */
let lastChk = 0, chkP = null;
function verSync(maxAge) {
  if (!S.token || !S.data) return Promise.resolve('');
  if (chkP) return chkP;
  if (maxAge > 0 && Date.now() - lastChk < maxAge) return Promise.resolve('');
  lastChk = Date.now();
  return chkP = (async () => {
    try {
      const p = await api('ping', {}, {silent: true});
      if (p.cat_ver !== undefined) { // server baru
        if (p.cat_ver !== S.data.cat_ver) { await loadData(); return 'cat'; }
        if (p.stock_ver !== S.data.stock_ver) { if (await refreshStock()) return 'stock'; await loadData(); return 'cat'; }
      } else if (p.ver !== S.data.ver) { await loadData(); return 'cat'; }
      return '';
    } catch (e) { if (e.auth) { softLogout(); return ''; } return e.server ? '' : null; }
  })().finally(() => { chkP = null; });
}
const dverKey = () => S.data ? (S.data.cat_ver !== undefined ? S.data.cat_ver + '~' + S.data.stock_ver : String(S.data.ver)) : ''; // sidik versi data yang dipegang perangkat ini
function redrawFor(kind) { // tampilkan hasil sinkronisasi; perubahan stok saja cukup menggambar ulang daftar (tanpa menutup pencarian atau menggulung ulang layar)
  if (!$('#sheet').hidden || S.dirty) { S.deferRender = true; return; }
  if (kind === 'stock') {
    if (S.tab === 'kasir' && $('#grid')) { grid(); syncCart(); return; }
    if (S.tab === 'stok' && $('#sq')) { if (!(S.stab === 'bahan' && own())) stokList(); return; }
  }
  render();
}
/* Membaca data layar (Produksi, Pengguna, Tutup kasir, Laporan, Biaya, ...) dengan cache berbasis versi: hasil disimpan bersama sidik versi data + tanggal.
   Bila versi tidak berubah sejak hasil itu diambil, layar langsung diisi dari cache dan TIDAK ada permintaan ke server (selain satu ping murah bila pemeriksaan terakhir
   lebih dari 15 detik). Hasil cache baru ditampilkan setelah versinya terbukti masih berlaku (kecuali offline), jadi layar tidak pernah menampilkan data basi.
   paint(data, dariCache); opt: {force, silent, fail(err)}. Sidik diambil sebelum permintaan: bila data bergerak di sela, hasil tampak sedikit basi dan diambil ulang lain kali. */
let VC = {};
async function vload(action, payload, paint, opt) {
  opt = opt || {}; if (!S.data) return;
  const key = S.data.user.uid + '|' + action + '|' + JSON.stringify(payload || {}), ent = VC[key], off = navigator.onLine === false; let shown = false;
  if (ent && !opt.force && (off || ent.k === dverKey() + '|' + today())) { paint(ent.v, true); shown = true; }
  if (off) { if (!shown && opt.fail) opt.fail(new Error('Tidak ada koneksi ke server')); return; }
  try {
    await verSync(opt.force ? 0 : 15000); if (!S.data) return;
    const k = dverKey() + '|' + today();
    if (ent && !opt.force && ent.k === k) { if (!shown) paint(ent.v, true); return; }
    const v = await api(action, payload, opt.silent ? {silent: true} : undefined);
    VC[key] = {k: k, v: v}; const ks = Object.keys(VC); if (ks.length > 40) delete VC[ks[0]];
    paint(v, false);
  } catch (e) { if (e.auth) { softLogout(); return; } if (opt.fail && !shown) opt.fail(e); }
}
/* ---------- Realtime + polling cadangan (v2.5.2) ----------
   Sinyal Realtime (tabel sync_events, migrasi 0026) hanya MEMICU pemeriksaan versi yang sudah ada (verSync); datanya tetap dibaca lewat RPC/RLS seperti biasa.
   Bila Realtime tidak tersambung (offline, blokir jaringan, paket gratis habis kuota) aplikasi tetap tersinkron lewat polling ringan (lihat pollTick di 14-mulai.js). */
S.rt = 'off'; let rtSigT = null;
function rtSignal(sig) {
  if (!S.token || !S.data) return;
  if (sig && sig.outlet_id && S.data.outlet && sig.outlet_id !== S.data.outlet.id) return;   // sinyal outlet lain (peran lintas outlet): abaikan
  clearTimeout(rtSigT); rtSigT = setTimeout(() => checkUpdates(true), sig && sig.catchup ? 0 : 800);   // gabungkan sinyal beruntun; tersambung ulang = kejar yang terlewat
}
function rtEnsure() {
  const R = window.SBAPI && window.SBAPI.realtime; if (!R || !S.token || !window.SBAPI.enabled() || /** @type {any} */ (C).REALTIME === false) return;
  R.start(() => S.token, rtSignal, st => { S.rt = st; if (st === 'retry') remoteLog('rt', new Error('Realtime terputus'), 'rt'); });
}
function rtStop() { const R = window.SBAPI && window.SBAPI.realtime; if (R) R.stop(); S.rt = 'off'; }
const pollEvery = () => S.rt === 'on' ? 180000 : 45000;   // Realtime tersambung: hanya jaring pengaman 3 menit; tidak: 45 detik
function pollTick() { if (!S.token || !S.data || document.hidden || navigator.onLine === false) return; if (Date.now() - lastChk >= pollEvery()) checkUpdates(true); }
async function checkUpdates(force) {
  const r = await verSync(force ? 0 : 30000); if (!r) return;
  if (r === 'cat') toast('Data terbaru dimuat');
  redrawFor(r);
}
let flushing = false, flushDelay = 15000, flushTimer = null;
const mineAll = () => S.data ? S.queue.filter(q => q.uid === S.data.user.uid || q.by === S.data.user.uid) : []; // milik user ini, atau diambil alih Owner
const mine = () => S.queue.filter(x => x.status === 'pending' && (x.uid === S.data.user.uid || x.by === S.data.user.uid));
/* F-15: server memakai waktu perangkat (client_ts) HANYA bila transaksi ditandai tertunda. Tertunda = sudah pernah dicoba kirim dan gagal (tries > 1) atau menunggu > 90 detik di antrean;
   pengiriman pertama yang langsung berhasil memakai waktu server. */
const delayed = q => (q.tries || 0) > 1 || Date.now() - (q.ts || Date.now()) > 90000;
const payloadOf = q => { const b = delayed(q) ? Object.assign({}, q.payload, {offline: true}) : q.payload; return q.uid === S.data.user.uid ? b : Object.assign({}, b, {kasir_id: q.uid}); }; // Owner mengirim atas nama kasir asal
const hasPending = () => !!S.data && mine().length > 0;
const pendingQty = id => S.queue.reduce((a, q) => a + (q.status === 'pending' && sameOutlet(q) ? q.payload.items.filter(i => i.variant_id === id).reduce((b, i) => b + i.qty, 0) : 0), 0);
function scheduleFlush() { // percobaan ulang hanya selama ada transaksi tertunda, dengan jeda yang makin panjang
  clearTimeout(flushTimer); if (!hasPending()) { flushDelay = 15000; S.nextFlush = 0; return; }
  S.nextFlush = Date.now() + flushDelay; flushTimer = setTimeout(flush, flushDelay); flushDelay = Math.min(flushDelay * 2, 120000);
}
async function sendBatch(batch) { // satu permintaan untuk banyak transaksi; mundur ke satu per satu bila server lama belum mengenal sale.batch
  if (!S.noBatch) { try { return await api('sale.batch', {sales: batch.map(payloadOf)}); } catch (e) { if (!(e.server && /Aksi tidak dikenal/.test(e.message))) throw e; S.noBatch = true; } }
  const out = []; for (const q of batch) { try { out.push({ok: true, data: await api('sale.create', payloadOf(q))}); } catch (e) { if (!e.server) throw e; out.push({ok: false, error: e.message, retry: !!e.retry, code: e.code}); } } return out;
}
async function flush() {
  if (flushing || !S.token || !S.data || !hasPending()) return;
  if (!navigator.onLine) { badge(); return; }
  flushing = true; let netFail = false;
  try {
    while (hasPending() && !netFail) {
      /* batch kecil: kunci server dipegang singkat dan kasir lain tidak menunggu lama */ const batch = mine().slice(0, 4); batch.forEach(q => { q.state = 'sending'; q.tries = (q.tries || 0) + 1; q.lastTry = Date.now(); }); badge(); let res;
      try { res = await sendBatch(batch); }
      catch (e) {
        if (e.auth) { softLogout(); break; }
        const transient = !e.server || e.retry; // jaringan putus, atau server menandai galat sementara: tetap antre dan coba lagi dengan jeda makin panjang
        batch.forEach(q => { q.error = !e.server ? 'Tidak ada koneksi ke server' : e.retry ? 'Server sibuk, dicoba lagi otomatis' : e.message; if (!transient) { q.status = 'review'; q.state = 'error'; } else q.state = 'waiting'; });
        if (transient) netFail = true; LS.set('queue', S.queue); continue;
      }
      /* P1-2: 23505 "request_id sudah dipakai" biasanya berarti percobaan sebelumnya SUDAH tercatat tetapi jawabannya hilang. Periksa dulu ke server;
         bila transaksinya ada, anggap selesai (bukan 'perlu ditinjau'). Bila tidak ada, tetap ditinjau seperti biasa. */
      await Promise.all(res.map(async (r, i) => { if (r && !r.ok && r.code === '23505' && /request_id sudah dipakai/.test(r.error || '')) { try { const f = await api('sale.lookup', {request_id: batch[i].rid}, {silent: true}); if (f && f.sale) res[i] = {ok: true, data: {sale: f.sale}}; } catch (e) { /* tetap ditinjau */ } } }));
      batch.forEach((q, i) => { const r = res[i];
        if (r && r.ok) { const d = r.data || {}; if (d.sale) S.nomor[q.rid] = d.sale.nomor; if (d.peringatan) toast(d.peringatan); S.queue = S.queue.filter(x => x !== q); Object.keys(d.stok || {}).forEach(id => { const v = vById(id); if (v) v.stok = r6(d.stok[id] - pendingQty(id)); }); }
        else if (r && r.retry) { q.state = 'waiting'; q.error = 'Server sibuk, dicoba lagi otomatis'; netFail = true; }
        else { q.status = 'review'; q.state = 'error'; q.error = (r && r.error) || 'Ditolak server'; } });
      LS.set('queue', S.queue); refreshRc(); flushDelay = 15000;
    }
  } finally { flushing = false; S.queue.forEach(q => { if (q.state === 'sending') q.state = 'waiting'; }); LS.set('queue', S.queue); LS.set('data', S.data); badge(); if (S.tab === 'riwayat' && $('#sheet').hidden) vRiwayat(); scheduleFlush(); notifyConflicts(); }
}
function softLogout(msg) { rtStop(); S.rhist = null; VC = {}; S.token = null; LS.del('token'); renderLogin(msg || 'Sesi berakhir, silakan masuk lagi.'); }
function logout() { rtStop(); if (S.token && window.SBAPI && window.SBAPI.enabled()) { try { window.SBAPI.call('logout', {}, S.token); } catch (e) {} } S.rhist = null; VC = {}; S.token = null; S.data = null; S.cart = []; LS.del('token'); LS.del('data'); LS.del('cart');
  /* P1-4: "perangkat bersama" mengosongkan preferensi dan nama pengguna terakhir juga. Antrean transaksi TIDAK dihapus (uang pelanggan mungkin sudah diterima). */
  if (LS.get('shared', false)) ['lastUser', 'ownerUser', 'ch', 'metode', 'hideOut'].forEach(k => LS.del(k));
  renderLogin(); }

