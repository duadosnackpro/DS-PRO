/* Duado Snack POS - frontend local-first. Sumber ada di src/app/*.js; tools/build.js menyambungnya menjadi web/js/app.js (jangan mengedit hasil bangun). Data master disimpan di perangkat; transaksi masuk antrean lalu disinkronkan. */
(function () {
'use strict';
const C = window.CONFIG || {};
const $ = s => document.querySelector(s);
const rp = n => 'Rp\u00a0' + Math.round(Number(n) || 0).toLocaleString('id-ID');
const num = n => Math.round(Number(n) || 0).toLocaleString('id-ID');
/* angka dari keyboard Indonesia: "0,5" = 0.5; "1.250" = 1250; "1.250,5" = 1250.5; "0.125" = 0.125 */
function dnum(s) {
  if (typeof s === 'number') return s; s = String(s == null ? '' : s).trim().replace(/\s/g, ''); if (!s) return NaN;
  s = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) && !/^0\./.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(',', '.'); return Number(s);
}
const qf = n => (Math.round(Number(n) * 1000) / 1000).toLocaleString('id-ID', {maximumFractionDigits: 3});
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/* Penyimpanan lokal: IndexedDB (kapasitas besar, tidak memblokir layar) dengan cermin di memori agar pembacaan tetap sinkron.
   Cadangan ke localStorage bila IndexedDB tidak tersedia. Data lama di localStorage dimigrasi sekali. Kunci penting (antrean, keranjang) ditulis seketika; token sesi sengaja tidak dijurnal ke localStorage. */
const Store = (() => {
  const mem = {}, dirty = {}, CRIT = ['queue', 'cart', 'hideOut', 'metode', 'ch']   /* P1-4: 'token' TIDAK dijurnal ke localStorage (cukup ditulis ke IndexedDB; sesi dipulihkan lewat refresh token) */; let db = null, idb = false, timer = null, writing = Promise.resolve();
  const journal = (k, o) => { try { localStorage.setItem('j:' + k, JSON.stringify(o)); } catch (e) {} }; // jurnal sinkron: selamat walau halaman ditutup sebelum IndexedDB selesai menulis
  const open = () => new Promise((res, rej) => { const r = indexedDB.open('duado', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('blocked')); });
  const readAll = () => new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').openCursor(); q.onsuccess = () => { const c = q.result; if (c) { mem[c.key] = c.value; c.continue(); } else res(); }; q.onerror = () => rej(q.error); });
  function flushNow() {
    clearTimeout(timer); const keys = Object.keys(dirty); if (!idb || !keys.length) return writing;
    const batch = keys.map(k => [k, dirty[k]]); keys.forEach(k => delete dirty[k]);
    writing = writing.then(() => new Promise(res => {
      const undo = () => { batch.forEach(([k, op]) => { if (!(k in dirty)) dirty[k] = op; }); res(); };
      try { const tx = db.transaction('kv', 'readwrite'), st = tx.objectStore('kv'); batch.forEach(([k, op]) => { if (op === 2) st.delete(k); else st.put(mem[k], k); }); tx.oncomplete = () => { batch.forEach(([k]) => { if (!(k in dirty)) { try { localStorage.removeItem('j:' + k); } catch (e) {} } }); res(); }; tx.onerror = tx.onabort = undo; } catch (e) { undo(); }
    }));
    return writing;
  }
  async function init() {
    try { if (window.indexedDB) { db = await open(); await readAll(); idb = true; } } catch (e) { idb = false; }
    try { // terapkan jurnal yang belum sempat masuk IndexedDB (mis. aplikasi ditutup tepat setelah transaksi)
      if (idb) Object.keys(localStorage).filter(k => k.indexOf('j:') === 0).forEach(jk => { const k = jk.slice(2); try { const o = JSON.parse(localStorage.getItem(jk)); if (o && o.x) { delete mem[k]; dirty[k] = 2; } else if (o && 'v' in o) { mem[k] = o.v; dirty[k] = 1; } } catch (e) {} });
      if (idb && Object.keys(dirty).length) await flushNow();
    } catch (e) {}
    try {
      const moved = []; Object.keys(localStorage).forEach(k => { if (k.indexOf('j:') !== 0 && !(k in mem)) { try { const v = JSON.parse(localStorage.getItem(k)); if (v != null) { mem[k] = v; if (idb) dirty[k] = 1; moved.push(k); } } catch (e) {} } });
      if (idb && moved.length) { await flushNow(); if (!Object.keys(dirty).length) moved.forEach(k => localStorage.removeItem(k)); } // hapus salinan lama hanya setelah berhasil tertulis
    } catch (e) {}
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {} // minta agar data tidak dibersihkan otomatis oleh browser
  }
  return {
    init: init, flush: flushNow, mode: () => idb ? 'IndexedDB' : 'localStorage',
    get: (k, d) => mem[k] == null ? d : mem[k],
    set: (k, v, now) => { mem[k] = v; if (idb) { if (CRIT.indexOf(k) >= 0) journal(k, {v: v}); dirty[k] = 1; if (now) flushNow(); else { clearTimeout(timer); timer = setTimeout(flushNow, 400); } } else { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('Penyimpanan perangkat penuh'); } } },
    del: k => { delete mem[k]; if (idb) { if (CRIT.indexOf(k) >= 0) journal(k, {x: 1}); dirty[k] = 2; if (CRIT.indexOf(k) >= 0) flushNow(); else { clearTimeout(timer); timer = setTimeout(flushNow, 400); } } else { try { localStorage.removeItem(k); } catch (e) {} } }
  };
})();
const devId = () => { let d = LS.get('dev', ''); if (!/^[0-9a-f]{32}$/.test(d)) { const a = new Uint8Array(16); (window.crypto && window.crypto.getRandomValues) ? window.crypto.getRandomValues(a) : a.forEach((_, i) => { a[i] = Math.floor(Math.random() * 256); }); d = Array.from(a, b => ('0' + b.toString(16)).slice(-2)).join(''); LS.set('dev', d); } return d; }; // id perangkat untuk penguncian login (server hanya menyimpan hash-nya)
const LS = {get: Store.get, set: (k, v) => Store.set(k, v, ['queue', 'cart', 'token', 'hideOut', 'metode', 'ch'].indexOf(k) >= 0), del: Store.del};
const T = v => String(v).toUpperCase() === 'TRUE';
const APP = window.APP = {views: {}};
const S = {token: null, data: null, queue: [], tab: 'kasir', ch: null, cat: 'Semua', q: '',
  cart: [], diskon: '', metode: 'tunai', terima: '', catatan: '', nomor: {}, mt: 'products', stab: 'varian', day: null, pb: {items: [], ongkir: '', sup: ''}, rc: null,
  sq: '', scat: 'Semua', hideOut: false, dirty: false, rcustom: false, installEv: null};
/* P0-1: peran asli dari server dipakai apa adanya. Tampilan ditentukan oleh kemampuan (can), bukan oleh pemetaan peran ke 'owner'/'kasir'.
   Penegakan hak tetap di server (RLS/RPC); daftar ini hanya memilih layar. */
const ROLES = [['owner', 'Owner'], ['admin', 'Admin'], ['supervisor', 'Supervisor'], ['kasir', 'Kasir'], ['stok', 'Stok'], ['produksi', 'Produksi'], ['auditor', 'Auditor']];
/* F: penjelasan singkat hak tiap peran. Disusun dari aturan di server (supabase/migrations: require_role) dan CAPS di bawah; DRAF, mohon dikoreksi sesuai kebijakan usaha. */
const ROLE_INFO = {
  owner: 'Akses penuh: semua outlet, laporan, harga pokok, pengaturan, dan pengguna.',
  admin: 'Mengelola data, pengaturan, dan pengguna (kecuali Owner dan Admin lain). Melihat laporan dan harga pokok.',
  supervisor: 'Setujui diskon dan retur, mengelola stok dan produksi di outletnya. Tidak mengelola pengguna.',
  kasir: 'Menjual dan melihat transaksinya sendiri. Diskon besar dan retur perlu persetujuan.',
  stok: 'Mengelola stok, pembelian bahan, dan perpindahan stok. Tidak menjual.',
  produksi: 'Mencatat dan menyelesaikan produksi di dapur. Tidak menjual.',
  auditor: 'Hanya melihat transaksi, laporan, dan harga pokok. Tidak mengubah data.'
};
const roleName = r => { const x = ROLES.find(y => y[0] === r); return x ? x[1] : String(r || ''); };
/* F7: kapabilitas = cerminan matriks require_role di server (supabase/migrations). Layar mengikuti kapabilitas, bukan hanya own(). */
const CAPS = {manage: ['owner', 'admin'], users: ['owner', 'admin'], takeover: ['owner'], approve: ['owner', 'admin', 'supervisor'],
  sell: ['owner', 'admin', 'supervisor', 'kasir'], history: ['owner', 'admin', 'supervisor', 'kasir', 'auditor'], dash: ['owner', 'admin', 'auditor'],
  stockedit: ['owner', 'admin', 'supervisor', 'stok'], materials: ['owner', 'admin', 'supervisor', 'stok', 'produksi'], produce: ['owner', 'admin', 'supervisor', 'produksi'],
  transfer: ['owner', 'admin', 'supervisor', 'stok'], report: ['owner', 'admin', 'supervisor', 'auditor'], cost: ['owner', 'admin', 'auditor']};
const ASSIGNABLE = {owner: ROLES.map(r => r[0]), admin: ['supervisor', 'kasir', 'stok', 'produksi']};   // sama dengan aturan Edge Function admin-users dan rpc_membership_set
const can = (cap, role) => { const r = role || (S.data && S.data.user && S.data.user.role); return !!r && (CAPS[cap] || []).indexOf(r) >= 0; };
const own = () => can('manage');
/* Pembantu bertipe longgar (hindari galat tipe DOM baru di ratchet): nilai input berdasarkan id, dan dataset elemen. */
const vOf = id => { const e = /** @type {any} */ (document.getElementById(id)); return e ? String(e.value || '') : ''; };
const dsOf = el => /** @type {any} */ (el).dataset;
const TAB_CAP = {dash: 'dash', kasir: 'sell', tutup: 'sell', riwayat: 'history', produksi: 'produce', laporan: 'report', transfer: 'transfer'};
const OWN_TABS = ['master', 'users', 'settings', 'resep', 'shopee', 'cek', 'outlets'];
const tabAllowed = t => OWN_TABS.indexOf(t) >= 0 ? own() : TAB_CAP[t] ? can(TAB_CAP[t]) : true;
const homeTab = () => ['dash', 'kasir', 'riwayat', 'stok'].filter(tabAllowed)[0] || 'menu';
/* v1.9.9: indeks Map (O(1)) menggantikan pencarian linear. Dibangun malas dan dibuang bila larik data diganti atau berubah panjang; perubahan di tempat (patchMaster) memanggil idxReset(). */
let IDX = null;
function idxReset() { IDX = null; }
function idx() {
  const d = S.data; if (IDX && IDX.d === d && IDX.v === d.variants && IDX.nv === d.variants.length && IDX.p === d.products && IDX.np === d.products.length && IDX.pr === d.prices && IDX.npr === d.prices.length && IDX.c === d.channels && IDX.nc === d.channels.length) return IDX;
  const v = new Map(), p = new Map(), pr = new Map(), c = new Map();
  d.variants.forEach(x => { if (!v.has(x.id)) v.set(x.id, x); }); d.products.forEach(x => { if (!p.has(x.id)) p.set(x.id, x); });
  d.prices.forEach(x => { const k = x.variant_id + '|' + x.channel_id; if (!pr.has(k)) pr.set(k, x); }); d.channels.forEach(x => { if (!c.has(x.id)) c.set(x.id, x); });
  return IDX = {d: d, v: d.variants, nv: d.variants.length, p: d.products, np: d.products.length, pr: d.prices, npr: d.prices.length, c: d.channels, nc: d.channels.length, mv: v, mp: p, mpr: pr, mc: c};
}
const vById = id => idx().mv.get(id);
const pById = id => idx().mp.get(id);
const vName = v => { const p = pById(v.product_id); return p ? p.nama : '(produk dihapus)'; };
const lvl = x => /^\d+$/.test(String(x).trim()) ? 'Level ' + String(x).trim() : x;
const vSub = v => [v.ukuran, v.level_pedas === '' || v.level_pedas == null ? '' : lvl(v.level_pedas)].filter(x => x !== '' && x != null).join(' · ');
const r6 = x => Math.round(Number(x) * 1e6) / 1e6;
const priceOf = (vid, ch) => { const x = idx().mpr.get(vid + '|' + ch); return x ? Number(x.harga_jual) : null; };
const chName = id => { const c = idx().mc.get(id); return c ? c.nama : '-'; };
const p2 = n => ('0' + n).slice(-2);
const fmtDT = d => { d = new Date(d); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()); };
const today = () => fmtDT(new Date()).slice(0, 10);
/* Daftar bertahap (v1.9.8): DOM hanya memuat sebagian baris; sisanya muncul saat digulir mendekati ujung (IntersectionObserver) atau lewat tombol. Mencegah layar macet pada >100 baris.
   LIM menyimpan jumlah baris yang sedang ditampilkan per daftar; bertambah satu halaman tiap kali, dan di-reset pemanggil saat filter/hari berganti. */
const PGN = {grid: 60, cart: 40, hist: 50, q: 30}, LIM = {}; let moreIO = null;
const lim = k => LIM[k] || PGN[k];
function moreBtn(k, total) { const n = total - lim(k); return n > 0 ? '<button class="btn sec lmore" data-act="more" data-k="' + k + '">Tampilkan ' + Math.min(n, PGN[k]) + ' lagi (sisa ' + n + ')</button>' : ''; }
function watchMore() {
  if (moreIO) { moreIO.disconnect(); moreIO = null; }
  const els = document.querySelectorAll('.lmore'); if (!els.length || !window.IntersectionObserver) return; // tanpa IntersectionObserver tombol tetap bisa diketuk
  moreIO = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting && e.target.isConnected) { moreIO.unobserve(e.target); /** @type {HTMLElement} */ (e.target).click(); } }), {rootMargin: '300px'});
  els.forEach(e => moreIO.observe(e));
}
function toast(m) { const t = $('#toast'); t.textContent = m; t.className = 'show'; clearTimeout(toast.t); toast.t = setTimeout(() => t.className = '', 2600); }
/* A: selama sheet terbuka, halaman di belakangnya tidak boleh terbaca pembaca layar maupun terjangkau Tab/ketuk (inert + aria-hidden). */
function bgInert(on) { ['app', 'upd'].forEach(id => { const e = document.getElementById(id); if (!e) return; if (on) { e.setAttribute('inert', ''); e.setAttribute('aria-hidden', 'true'); } else { e.removeAttribute('inert'); e.removeAttribute('aria-hidden'); } }); }
function sheet(html) {
  const b = $('#sheet'), opening = b.hidden; if (opening) { S.sheetFrom = document.activeElement; bgInert(true); }
  b.innerHTML = '<div class="sheet-bg" data-act="close"></div><div class="sheet" role="dialog" aria-modal="true" tabindex="-1">' + html + '</div>'; b.hidden = false;
  const d = /** @type {HTMLElement|null} */ (b.querySelector('.sheet')), h = d && d.querySelector('h2');
  if (!d) return;
  if (h) { h.id = 'sheet-h'; d.setAttribute('aria-labelledby', 'sheet-h'); } else d.setAttribute('aria-label', 'Dialog'); // nama dialog = judulnya, bukan kata generik
  if (opening) d.focus({preventScroll: true}); // fokus masuk ke dialog (wadah, bukan kolom isian: keyboard layar tidak muncul sendiri)
}
/* Tab tetap berputar di dalam dialog yang terbuka (aria-modal): tanpa ini Tab keluar ke halaman di belakang sheet. */
function trapTab(/** @type {KeyboardEvent} */ e) {
  const b = $('#sheet'); if (!b || b.hidden || S.busyOn) return;
  const d = /** @type {HTMLElement|null} */ (b.querySelector('.sheet')); if (!d) return;
  const f = /** @type {HTMLElement[]} */ (Array.from(d.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'))).filter(x => x.offsetParent !== null);
  if (!f.length) { e.preventDefault(); d.focus(); return; }
  const first = f[0], last = f[f.length - 1], a = document.activeElement;
  if (!a || !d.contains(a) || a === d) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
  else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
}
function closeSheet() { if (S.opin) { const r = S.opin.res; S.opin = null; r(null); } const b = $('#sheet'); S.qopen = false; b.hidden = true; b.innerHTML = ''; bgInert(false); try { const f = S.sheetFrom; S.sheetFrom = null; if (f && f.isConnected && f.focus) f.focus({preventScroll: true}); } catch (e) {} if (S.deferRender) { S.deferRender = false; render(); } if (S.conflictPending) setTimeout(notifyConflicts, 250); }

/* ---------- API dan sinkronisasi ---------- */
let pending = 0;
const QUIET = {ping: 1, 'stock.get': 1, bootstrap: 1, login: 1, logout: 1}; // aksi yang tidak memicu pemeriksaan versi (mereka sendiri yang menyinkronkan)
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
  LS.set('lastsync', S.lastSync); LS.set('data', S.data); if (S.cat !== 'Semua' && !S.data.products.some(p => p.kategori === S.cat)) S.cat = 'Semua'; setTimeout(fotoWarm, 1500); }
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
function softLogout(msg) { S.rhist = null; VC = {}; S.token = null; LS.del('token'); renderLogin(msg || 'Sesi berakhir, silakan masuk lagi.'); }
function logout() { if (S.token && window.SBAPI && window.SBAPI.enabled()) { try { window.SBAPI.call('logout', {}, S.token); } catch (e) {} } S.rhist = null; VC = {}; S.token = null; S.data = null; S.cart = []; LS.del('token'); LS.del('data'); LS.del('cart');
  /* P1-4: "perangkat bersama" mengosongkan preferensi dan nama pengguna terakhir juga. Antrean transaksi TIDAK dihapus (uang pelanggan mungkin sudah diterima). */
  if (LS.get('shared', false)) ['lastUser', 'ownerUser', 'ch', 'metode', 'hideOut'].forEach(k => LS.del(k));
  renderLogin(); }

/* ---------- Ikon, tampilan, diagnostik, struk ---------- */
const cfg = k => (S.data && S.data.settings[k]);
const IC = {
  dash: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  kasir: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  riwayat: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
  stok: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  produksi: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  menu: '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
  laporan: '<line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/>',
  cek: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>',
  master: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  shopee: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  settings: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  sync: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  diag: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  chev: '<path d="m9 18 6-6-6-6"/>', search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>', check: '<path d="M20 6 9 17l-5-5"/>'
};
const svg = (n, sz) => '<svg class="ic" viewBox="0 0 24 24" width="' + (sz || 22) + '" height="' + (sz || 22) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + IC[n] + '</svg>';
const FLAME = 'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z';
const heatN = lv => { const n = parseInt(String(lv == null ? '' : lv).replace(/\D/g, ''), 10); return isNaN(n) ? -1 : Math.min(n, 5); };
function heat(lv) { // level pedas sebagai nyala api (1-5); teks biasa untuk level non-angka seperti "Original"
  const raw = String(lv == null ? '' : lv).trim(), n = heatN(lv); if (!raw) return '';
  if (n < 0) return '<span class="lv0">' + esc(raw) + '</span>';
  return '<span class="heat" title="Level pedas ' + n + '"><span class="sr">Level ' + n + '</span>' + [1, 2, 3, 4, 5].map(i => '<svg viewBox="0 0 24 24" width="13" height="13" class="' + (i <= n ? 'on' : '') + '" fill="currentColor" aria-hidden="true"><path d="' + FLAME + '"/></svg>').join('') + '</span>';
}
const skuAbbr = n => { const w = String(n || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean); if (!w.length) return 'PRD'; if (w.length > 1) return w.slice(0, 3).map(x => x[0]).join(''); let t = w[0][0] + w[0].slice(1).replace(/[AEIOU]/g, ''); if (t.length < 3) t = w[0]; return t.slice(0, 3); };
const skuSize = u => { const t = String(u == null ? '' : u).toUpperCase(), m = t.match(/(\d+(?:[.,]\d+)?)\s*(KG|GR|G|ML|LT|L|PCS|PACK)?/); if (m) return m[1].replace(/[.,]/g, '') + (m[2] || ''); const x = t.replace(/[^A-Z]/g, ''); return x ? x[0] : ''; };
const skuLevel = lv => { const raw = String(lv == null ? '' : lv).trim(); if (!raw) return ''; const n = parseInt(raw.replace(/\D/g, ''), 10); return isNaN(n) ? raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) : 'L' + n; };
function genSkuLocal(f, selfId) {
  const p = pById(f.product_id), base = [skuAbbr(p && p.nama), skuSize(f.ukuran), skuLevel(f.level_pedas)].filter(Boolean).join('-'), taken = new Set(S.data.variants.filter(v => v.id !== selfId).map(v => String(v.sku || '').trim().toUpperCase()));
  let sku = base, i = 2; while (taken.has(sku)) sku = base + '-' + i++; return sku;
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const idDate = d => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? (+m[3]) + ' ' + MON[+m[2] - 1] + ' ' + m[1] : String(d || ''); };
const idRange = (a, b) => { if (a === b) return idDate(a); if (a.slice(0, 7) === b.slice(0, 7)) return (+a.slice(8, 10)) + ' – ' + idDate(b); if (a.slice(0, 4) === b.slice(0, 4)) return (+a.slice(8, 10)) + ' ' + MON[+a.slice(5, 7) - 1] + ' – ' + idDate(b); return idDate(a) + ' – ' + idDate(b); };
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00'); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); };
const emptyState = (ic, t, d, a) => '<div class="empty-s"><div class="es-i">' + svg(ic, 34) + '</div><h3>' + t + '</h3><p>' + d + '</p>' + (a || '') + '</div>';
const wrapChips = h => '<div class="chips-wrap"><div class="chips">' + h + '</div></div>';
function initFades() { // petunjuk geser: gradient di tepi chip yang bisa digeser, dan chip aktif otomatis terlihat
  document.querySelectorAll('.chips-wrap').forEach(w => {
    const c = w.firstElementChild; if (!c) return;
    const upd = () => { w.classList.toggle('fade-r', c.scrollWidth - c.clientWidth - c.scrollLeft > 4); w.classList.toggle('fade-l', c.scrollLeft > 4); };
    if (!c._fx) { c._fx = 1; c.addEventListener('scroll', upd, {passive: true}); }
    if (!c._sc) { c._sc = 1; const on = c.querySelector('.chip.on,.seg button.on'); if (on) c.scrollLeft = Math.max(0, on.offsetLeft - (c.clientWidth - on.offsetWidth) / 2); }
    upd();
  });
}
const isAddon = v => String((pById(v.product_id) || {}).kategori || '').trim().toLowerCase() === 'tambahan'; // produk tambahan (mis. kantong kresek) tampil di menu pembayaran, bukan di daftar produk
const lvText = lv => { const raw = String(lv == null ? '' : lv).trim(); return !raw ? '' : /^\d+$/.test(raw) ? 'Lv ' + raw : raw; };
IC.install = '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>';
const buzz = () => { try { navigator.vibrate && navigator.vibrate(12); } catch (e) {} };
/* Galat milik ekstensi browser (chrome-extension://, moz-extension://, dan sejenisnya) bukan galat aplikasi: tidak dicatat */
const foreign = e => { const t = String((e && e.stack) || '') + ' ' + String((e && e.filename) || ''); return /(chrome|moz|safari-web|ms-browser)-extension:\/\//.test(t) && t.indexOf(location.origin) < 0; };
function logErr(e, ctx) { if (foreign(e)) return; try { const l = LS.get('errlog', []); l.unshift({t: Date.now(), c: ctx || '', m: String((e && e.message) || e), s: String((e && e.stack) || '').split('\n').slice(0, 3).join(' | ')}); LS.set('errlog', l.slice(0, 20)); } catch (x) {} }
window.addEventListener('error', ev => { if (/-extension:\/\//.test(String(ev.filename || ''))) return; logErr(ev.error || ev.message, 'error'); });
window.addEventListener('unhandledrejection', ev => logErr(ev.reason, 'promise'));
/* struk: satu sumber untuk layar, WhatsApp, dan printer. receiptDoc() menyusun baris struk (teks, tebal, ukuran, rata); tiap keluaran hanya menerjemahkannya.
   Lebar mengikuti pengaturan: 32 = kertas 58 mm (area cetak 48 mm), 48 = kertas 80 mm (area cetak 72 mm); font A printer = 12 titik per karakter.
   Nama usaha TIDAK dicetak bila logo aktif (logo sudah memuat nama). Header (di bawah logo) dan footer (di bawah struk) bisa diisi sendiri atau dimatikan.
   Dalam catatan, baris yang dibungkus *bintang* dicetak tebal. */
const rcWidth = () => Number(cfg('lebar_struk')) === 48 ? 48 : 32;
function wrapWords(t, w) { // turun baris per kata; kata yang lebih panjang dari lebar dipotong
  const o = [];
  String(t == null ? '' : t).split(/\r?\n/).forEach(par => {
    const ws = par.trim().split(/\s+/).filter(Boolean); if (!ws.length) { o.push(''); return; }
    let cur = '';
    ws.forEach(x => {
      while (x.length > w) { if (cur) { o.push(cur); cur = ''; } o.push(x.slice(0, w)); x = x.slice(w); }
      if (!cur) cur = x; else if (cur.length + 1 + x.length <= w) cur += ' ' + x; else { o.push(cur); cur = x; }
    });
    if (cur) o.push(cur);
  });
  return o;
}
const ljust = (s, n) => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
const rjust = (s, n) => ' '.repeat(Math.max(0, n - s.length)) + s;
const lr = (a, b, w) => { a = String(a); b = String(b); return a + ' '.repeat(Math.max(1, w - a.length - b.length)) + b; };
const padC = (s, n) => ' '.repeat(Math.max(0, (n - s.length) >> 1)) + s;
const dmy = d => { d = new Date(d); return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + d.getFullYear(); };
const hms = d => { d = new Date(d); return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()); };
function noteLines(t, w) { // catatan header/footer: rata tengah, *tebal*, baris kosong di ujung dibuang
  const o = [];
  String(t == null ? '' : t).split(/\r?\n/).forEach(p => { p = p.trim(); const m = /^\*(.+)\*$/.exec(p); if (m) p = m[1].trim(); wrapWords(p, w).forEach(s => o.push({s: s, a: 'c', b: !!m})); });
  while (o.length && !o[o.length - 1].s) o.pop(); while (o.length && !o[0].s) o.shift();
  return o;
}
function receiptDoc(rc, o) { // o: {w: lebar, rich: ukuran ganda + QR bawaan printer, logo: logo yang dicetak}
  o = o || {}; const w = o.w || rcWidth(), rich = !!o.rich, wide = w >= 48, D = [], pay = String(rc.metode || '');
  const add = (s, x) => D.push(Object.assign({s: s}, x)), hr = () => add('-'.repeat(w));
  if (!o.logo) { const nm = String(cfg('nama_usaha') || 'Duado Snack').toUpperCase(), z = rich && nm.length * 2 <= w; wrapWords(nm, z ? w >> 1 : w).forEach(x => add(x, {a: 'c', b: true, z: z ? 2 : 1})); }
  if (cfgOn('header_aktif', true)) noteLines(cfg('header_struk'), w).forEach(x => D.push(x));
  hr();
  const nomor = S.nomor[rc.rid] || '(menunggu sinkron)', kasir = String(rc.kasir || ''), kv = (k, v, lw, n) => ljust(k, lw) + ': ' + String(v).slice(0, n);
  if (wide) { add(ljust(kv('No', nomor, 8, 18), 28) + kv('Waktu', hms(rc.time), 6, 12)); add(ljust(kv('Tanggal', dmy(rc.time), 8, 18), 28) + kv('Kasir', kasir, 6, 12)); add(kv('Via', rc.ch, 8, 38)); }
  else { add(kv('No', nomor, 6, 24)); add(kv('Waktu', dmy(rc.time) + ' ' + hms(rc.time), 6, 24)); if (kasir) add(kv('Kasir', kasir, 6, 24)); add(kv('Via', rc.ch, 6, 24)); }
  hr();
  if (wide) { // tabel: ITEM | QTY | HARGA | TOTAL (satu baris per item; nama panjang turun ke baris berikutnya)
    const Q = 4, H = 10, TT = 11, N = w - Q - H - TT - 3;
    add(ljust('ITEM', N) + ' ' + rjust('QTY', Q) + ' ' + rjust('HARGA', H) + ' ' + rjust('TOTAL', TT), {b: true}); hr();
    rc.lines.forEach(l => wrapWords(l.n, N).forEach((x, i) => add(i ? x : ljust(x, N) + ' ' + rjust(String(l.q), Q) + ' ' + rjust(num(l.h), H) + ' ' + rjust(num(l.q * l.h), TT))));
  } else rc.lines.forEach(l => { wrapWords(l.n, w).forEach(x => add(x)); add(lr('  ' + l.q + ' x ' + num(l.h), num(l.q * l.h), w)); });
  const ind = wide ? 20 : 0, pad = ' '.repeat(ind), S2 = (a, b) => add(pad + lr(a, b, w - ind));
  hr(); S2('Subtotal', num(rc.sub)); if (rc.dis) S2('Diskon', '-' + num(rc.dis)); if (rc.ppn) S2(T(cfg('ppn_inklusif')) ? 'PPN (incl.)' : 'PPN', num(rc.ppn));
  hr(); const tz = rich && 'TOTAL'.length + 1 + num(rc.total).length <= w >> 1; add(lr('TOTAL', num(rc.total), tz ? w >> 1 : w), {b: true, z: tz ? 2 : 1});
  hr(); S2(pay === 'qris' ? 'QRIS' : pay.charAt(0).toUpperCase() + pay.slice(1), num(rc.terima)); if (pay === 'tunai') S2('Kembalian', num(rc.kembali));
  const ft = cfgOn('footer_aktif', true) ? noteLines(cfg('footer_struk'), w) : [], qr = String(cfg('qr_struk') || '').trim();
  if (ft.length || qr) hr();
  ft.forEach(x => D.push(x));
  if (qr) { if (rich) D.push({qr: qr}); else wrapWords(qr, w).forEach(x => add(x, {a: 'c'})); }
  return D;
}
const docText = (D, w) => D.map(x => x.qr ? '' : (x.a === 'c' ? padC(x.s, w) : x.s).replace(/ +$/, '')).join('\n');
const receiptText = rc => { const w = rcWidth(); return docText(receiptDoc(rc, {w: w}), w); };
function docHtml(D, w) { // pratinjau layar dan cetak browser
  return D.map(x => {
    if (x.qr) return qrImg(x.qr);
    const z = x.z === 2, s = x.a === 'c' ? padC(x.s, z ? w >> 1 : w) : x.s; let h = esc(s);
    if (x.b) h = '<b>' + h + '</b>'; return z ? '<span class="z2">' + h + '</span>' : h;
  }).join('\n');
}
const ascii = t => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[·•–—]/g, '-').replace(/[^\x20-\x7E]/g, '?');
/* QR sendiri (tanpa pustaka): mode byte (UTF-8), koreksi M, versi 1-7 (maks. 122 byte). Dicetak sebagai gambar seperti logo, jadi tidak bergantung pada fitur QR bawaan printer. */
const QR_T = [null, [26, 10, 1, 16], [44, 16, 1, 28], [70, 26, 1, 44], [100, 18, 2, 32], [134, 24, 2, 43], [172, 16, 4, 27], [196, 18, 4, 31]]; // [kata kode total, EC per blok, jumlah blok, data per blok]
function qrMake(text) { // -> matriks [baris][kolom] berisi 1 (gelap) / 0, atau null bila terlalu panjang
  const bytes = Array.from(unescape(encodeURIComponent(String(text)))).map(c => c.charCodeAt(0)); let v = 1;
  while (v <= 7 && bytes.length > QR_T[v][2] * QR_T[v][3] - 2) v++; if (v > 7) return null;
  const tot = QR_T[v][0], ecn = QR_T[v][1], nb = QR_T[v][2], dpb = QR_T[v][3], nd = nb * dpb, size = 17 + 4 * v, bits = [], put = (x, n) => { for (let i = n - 1; i >= 0; i--) bits.push((x >> i) & 1); };
  put(4, 4); put(bytes.length, 8); bytes.forEach(x => put(x, 8)); put(0, Math.min(4, nd * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  const cw = []; for (let i = 0; i < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2)); for (let pd = 0xEC; cw.length < nd; pd ^= 0xFD) cw.push(pd);
  const ex = new Array(512), lg = new Array(256); for (let i = 0, x = 1; i < 255; i++) { ex[i] = x; lg[x] = i; x <<= 1; if (x & 256) x ^= 0x11D; } for (let i = 255; i < 512; i++) ex[i] = ex[i - 255];
  const mul = (x, y) => x && y ? ex[lg[x] + lg[y]] : 0; let g = [1];
  for (let i = 0; i < ecn; i++) { const nn = new Array(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { nn[j] ^= g[j]; nn[j + 1] ^= mul(g[j], ex[i]); } g = nn; }
  const rs = d => { const r = new Array(ecn).fill(0); d.forEach(x => { const f = x ^ r[0]; r.shift(); r.push(0); if (f) for (let j = 0; j < ecn; j++) r[j] ^= mul(g[j + 1], f); }); return r; };
  const blk = [], ecs = []; for (let i = 0; i < nb; i++) { const d = cw.slice(i * dpb, (i + 1) * dpb); blk.push(d); ecs.push(rs(d)); }
  const fin = []; for (let i = 0; i < dpb; i++) blk.forEach(x => fin.push(x[i])); for (let i = 0; i < ecn; i++) ecs.forEach(x => fin.push(x[i]));
  const fb = []; fin.forEach(x => { for (let i = 7; i >= 0; i--) fb.push((x >> i) & 1); });
  const m = [], fn = []; for (let y = 0; y < size; y++) { m.push(new Array(size).fill(0)); fn.push(new Array(size).fill(false)); }
  const set = (x, y, val) => { m[y][x] = val ? 1 : 0; fn[y][x] = true; };
  [[0, 0], [size - 7, 0], [0, size - 7]].forEach(f => { for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) { const x = f[0] + dx, y = f[1] + dy; if (x < 0 || y < 0 || x >= size || y >= size) continue; const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3)); set(x, y, d <= 1 || d === 3); } });
  for (let i = 0; i < size; i++) { if (!fn[6][i]) set(i, 6, i % 2 === 0); if (!fn[i][6]) set(6, i, i % 2 === 0); }
  const ap = v === 1 ? [] : v <= 6 ? [6, 4 * v + 10] : [6, 22, 38];
  const ae = ap[ap.length - 1]; ap.forEach(cy => ap.forEach(cx => { if ((cx === 6 && cy === 6) || (cx === 6 && cy === ae) || (cy === 6 && cx === ae)) return; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }));
  for (let i = 0; i < 9; i++) { fn[8][i] = fn[i][8] = true; } for (let i = 0; i < 8; i++) { fn[8][size - 1 - i] = fn[size - 1 - i][8] = true; } set(8, size - 8, 1);
  if (v >= 7) { let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25); const vb = (v << 12) | r; for (let i = 0; i < 18; i++) { const bt = (vb >>> i) & 1, a2 = size - 11 + i % 3, b2 = Math.floor(i / 3); set(a2, b2, bt); set(b2, a2, bt); } }
  let bi = 0, up = true; for (let x = size - 1; x > 0; x -= 2) { if (x === 6) x--; for (let k = 0; k < size; k++) { const y = up ? size - 1 - k : k; for (let dx = 0; dx < 2; dx++) if (!fn[y][x - dx]) m[y][x - dx] = bi < fb.length ? fb[bi++] : 0; } up = !up; }
  const MC = [(i, j) => (i + j) % 2 === 0, (i) => i % 2 === 0, (i, j) => j % 3 === 0, (i, j) => (i + j) % 3 === 0, (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0, (i, j) => (i * j) % 2 + (i * j) % 3 === 0, (i, j) => ((i * j) % 2 + (i * j) % 3) % 2 === 0, (i, j) => ((i + j) % 2 + (i * j) % 3) % 2 === 0];
  const penalty = q => {
    let pn = 0, dark = 0; const line = a => { let run = 1; for (let i = 1; i <= a.length; i++) { if (i < a.length && a[i] === a[i - 1]) run++; else { if (run >= 5) pn += 3 + run - 5; run = 1; } } const t = a.join(''); [/10111010000/g, /00001011101/g].forEach(re => { const mm = t.match(re); if (mm) pn += 40 * mm.length; }); };
    for (let y = 0; y < size; y++) { line(q[y]); line(q.map(r => r[y])); for (let x = 0; x < size; x++) { if (q[y][x]) dark++; if (x + 1 < size && y + 1 < size && q[y][x] === q[y][x + 1] && q[y][x] === q[y + 1][x] && q[y][x] === q[y + 1][x + 1]) pn += 3; } }
    return pn + (Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1) * 10;
  };
  let best = null, bp = 1e9;
  for (let mk = 0; mk < 8; mk++) {
    const q = m.map(r => r.slice()), sf = (x, y, val) => { q[y][x] = val; };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MC[mk](y, x)) q[y][x] ^= 1;
    let r = mk; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537); const fm = ((mk << 10) | r) ^ 0x5412, bt = i => (fm >>> i) & 1;
    for (let i = 0; i <= 5; i++) sf(8, i, bt(i)); sf(8, 7, bt(6)); sf(8, 8, bt(7)); sf(7, 8, bt(8)); for (let i = 9; i < 15; i++) sf(14 - i, 8, bt(i));
    for (let i = 0; i < 8; i++) sf(size - 1 - i, 8, bt(i)); for (let i = 8; i < 15; i++) sf(8, size - 15 + i, bt(i)); sf(8, size - 8, 1);
    const pnl = penalty(q); if (pnl < bp) { bp = pnl; best = q; }
  }
  return best;
}
function qrBitmap(text, maxW) { // QR -> bitmap 1-bit (zona tenang 2 modul), modul 2-5 titik mengikuti lebar kertas
  const q = qrMake(text); if (!q) return null;
  const n = q.length, sc = Math.max(2, Math.min(5, Math.floor(maxW / (n + 4)))), H = (n + 4) * sc, W = Math.ceil(H / 8) * 8, off = (W - n * sc) >> 1, mono = new Uint8Array(W * H);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q[y][x]) for (let dy = 0; dy < sc; dy++) for (let dx = 0; dx < sc; dx++) mono[(2 * sc + y * sc + dy) * W + off + x * sc + dx] = 1;
  return {w: W, h: H, mode: 't', bytes: logoPack(mono, W, H)};
}
function qrImg(text) { // pratinjau layar
  if (typeof document === 'undefined') return '<span class="qrbox">QR</span>';
  const b = qrBitmap(text, paperDots()); if (!b) return '<i>(isi QR terlalu panjang, maks. 120 karakter)</i>';
  const cv = document.createElement('canvas'); logoPaint(cv, b); return '<img class="lg-cv" alt="QR" src="' + cv.toDataURL('image/png') + '" style="width:' + Math.min(100, b.w / paperDots() * 100).toFixed(1) + '%">';
}
function escpos(rc) { // byte ESC/POS untuk printer thermal (dikirim lewat RawBT atau BLE langsung)
  const lg = logoOn(), w = rcWidth(), D = receiptDoc(rc, {w: w, rich: true, logo: lg}), out = [0x1B, 0x40], add = a => { for (const c of ascii(a)) out.push(c.charCodeAt(0)); out.push(10); };
  if (lg) { out.push(0x1B, 0x61, 1); const r = logoRaster(logoFit(lg, paperDots())); for (let i = 0; i < r.length; i++) out.push(r[i]); out.push(10, 0x1B, 0x61, 0); } // logo di tengah, atas struk
  D.forEach(x => {
    if (x.qr) { const qb = qrBitmap(x.qr, paperDots()); if (qb) { out.push(0x1B, 0x61, 1); logoRaster(qb).forEach(v => out.push(v)); out.push(10, 0x1B, 0x61, 0); } return; }
    out.push(0x1B, 0x61, x.a === 'c' ? 1 : 0, 0x1B, 0x45, x.b ? 1 : 0, 0x1D, 0x21, x.z === 2 ? 0x11 : 0); add(x.s);
  });
  out.push(0x1B, 0x61, 0, 0x1B, 0x45, 0, 0x1D, 0x21, 0, 0x1B, 0x64, 4); return new Uint8Array(out);
}
/* ---------- Logo struk: bitmap 1-bit untuk printer thermal ----------
   Disimpan di pengaturan `logo_data` sebagai "L1;<lebar>x<tinggi>;<t|h>;<base64>" (1 = titik hitam, MSB dahulu, per baris).
   t = hitam-putih tegas (ambang), h = halftone (Floyd-Steinberg). Dicetak dengan perintah raster ESC/POS `GS v 0`.
   Ukuran logo sudah final saat disimpan (persen dari lebar kertas); bila kertas diganti jadi lebih sempit, logo dikecilkan saat cetak. */
const LOGO_MAX_H = 256, LOGO_BAND = 64, LOGO_RE = /^L1;(\d{1,3})x(\d{1,3});([th]);([A-Za-z0-9+\/]+={0,2})$/;
const paperDots = () => rcWidth() === 48 ? 576 : 384; // 203 dpi = 8 titik per mm (58 mm: 384 titik, 80 mm: 576 titik)
const cfgOn = (k, def) => { const v = cfg(k); return v == null || v === '' ? !!def : T(v); };
function logoPack(mono, w, h) { // mono: Uint8Array w*h (1 = hitam) -> byte per baris, bit tertinggi = titik paling kiri
  const bpr = w >> 3, out = new Uint8Array(bpr * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mono[y * w + x]) out[y * bpr + (x >> 3)] |= 0x80 >> (x & 7);
  return out;
}
const logoEncode = lg => 'L1;' + lg.w + 'x' + lg.h + ';' + lg.mode + ';' + b64(lg.bytes);
function logoDecode(str) {
  const m = LOGO_RE.exec(String(str || '')); if (!m) return null;
  const w = +m[1], h = +m[2]; if (w < 8 || w % 8 || w > 576 || h < 1 || h > LOGO_MAX_H) return null;
  let bin; try { bin = atob(m[4]); } catch (e) { return null; }
  if (bin.length !== (w >> 3) * h) return null;
  const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return {w: w, h: h, mode: m[3], bytes: bytes};
}
const LGC = {s: null, v: null, url: null}; // logo tersimpan (didekode sekali per perubahan data)
function logoGet() { const s = String(cfg('logo_data') || ''); if (s !== LGC.s) { LGC.s = s; LGC.v = logoDecode(s); LGC.url = null; } return LGC.v; }
const logoOn = () => cfgOn('logo_aktif', false) ? logoGet() : null;
const toGray = (rgba, n) => { const g = new Uint8Array(n); for (let i = 0; i < n; i++) g[i] = (rgba[4 * i] * 77 + rgba[4 * i + 1] * 150 + rgba[4 * i + 2] * 29) >> 8; return g; };
function otsu(g) { // ambang otomatis yang memisahkan latar dan gambar; titik dengan nilai < hasil dicetak hitam
  const hst = new Array(256).fill(0), n = g.length; for (let i = 0; i < n; i++) hst[g[i]]++;
  let sum = 0, sb = 0, wb = 0, best = -1, thr = 128; for (let i = 0; i < 256; i++) sum += i * hst[i];
  for (let t = 0; t < 256; t++) { wb += hst[t]; if (!wb) continue; const wf = n - wb; if (!wf) break; sb += t * hst[t]; const mb = sb / wb, mf = (sum - sb) / wf, v = wb * wf * (mb - mf) * (mb - mf); if (v > best) { best = v; thr = t + 1; } }
  return thr;
}
const monoThreshold = (g, thr) => { const m = new Uint8Array(g.length); for (let i = 0; i < g.length; i++) m[i] = g[i] < thr ? 1 : 0; return m; };
function monoDither(g, w, h, bias) { // Floyd-Steinberg; bias > 0 = lebih terang. Lewat kurva gamma: putih murni tetap putih, hitam murni tetap hitam (tanpa titik liar di latar)
  const lut = new Float32Array(256), gm = Math.pow(2, -bias / 64); for (let i = 0; i < 256; i++) lut[i] = 255 * Math.pow(i / 255, gm);
  const f = new Float32Array(w * h), m = new Uint8Array(w * h); for (let i = 0; i < f.length; i++) f[i] = lut[g[i]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, o = f[i], nv = o < 128 ? 0 : 255, er = o - nv; m[i] = nv === 0 ? 1 : 0;
    if (x + 1 < w) f[i + 1] += er * 7 / 16;
    if (y + 1 < h) { if (x > 0) f[i + w - 1] += er * 3 / 16; f[i + w] += er * 5 / 16; if (x + 1 < w) f[i + w + 1] += er / 16; }
  }
  return m;
}
function isColorImg(rgba, n) { // berwarna bila >4% titik bukan-putih punya selisih kanal RGB yang jelas
  let ink = 0, col = 0;
  for (let i = 0; i < n; i++) { const r = rgba[4 * i], g = rgba[4 * i + 1], b = rgba[4 * i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mn > 235) continue; ink++; if (mx - mn > 48) col++; }
  return ink > 0 && col / ink > 0.04;
}
function logoFit(lg, maxW) { // kecilkan logo bila lebih lebar dari kertas (rata-rata area lalu dibuat 1-bit lagi)
  if (lg.w <= maxW) return lg;
  const w = maxW & ~7, h = Math.max(1, Math.round(lg.h * w / lg.w)), g = new Uint8Array(w * h), sx = lg.w / w, sy = lg.h / h, bpr = lg.w >> 3;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x * sx), x1 = Math.min(lg.w, Math.max(x0 + 1, Math.ceil((x + 1) * sx))), y0 = Math.floor(y * sy), y1 = Math.min(lg.h, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
    let on = 0; for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) if (lg.bytes[yy * bpr + (xx >> 3)] & (0x80 >> (xx & 7))) on++;
    g[y * w + x] = Math.round(255 * (1 - on / ((x1 - x0) * (y1 - y0))));
  }
  return {w: w, h: h, mode: lg.mode, bytes: logoPack(lg.mode === 'h' ? monoDither(g, w, h, 0) : monoThreshold(g, 128), w, h)};
}
function logoRaster(lg) { // GS v 0 per pita LOGO_BAND baris: printer murah dengan buffer kecil tidak kebanjiran
  const bpr = lg.w >> 3, out = [];
  for (let y = 0; y < lg.h; y += LOGO_BAND) {
    const n = Math.min(LOGO_BAND, lg.h - y); out.push(0x1D, 0x76, 0x30, 0, bpr & 255, bpr >> 8, n & 255, n >> 8);
    for (let i = y * bpr; i < (y + n) * bpr; i++) out.push(lg.bytes[i]);
  }
  return out;
}
function logoPaint(cv, lg) { // gambar bitmap 1-bit ke kanvas (pratinjau, struk di layar)
  cv.width = lg.w; cv.height = lg.h; const cx = cv.getContext('2d'), im = cx.createImageData(lg.w, lg.h), bpr = lg.w >> 3;
  for (let y = 0; y < lg.h; y++) for (let x = 0; x < lg.w; x++) { const i = (y * lg.w + x) * 4, v = lg.bytes[y * bpr + (x >> 3)] & (0x80 >> (x & 7)) ? 0 : 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; }
  cx.putImageData(im, 0, 0);
}
function logoURL(lg) {
  if (!lg) return ''; if (lg === LGC.v && LGC.url != null) return LGC.url;
  let u = ''; try { const cv = document.createElement('canvas'); logoPaint(cv, lg); u = cv.toDataURL('image/png'); } catch (e) { logErr(e, 'logo'); }
  if (lg === LGC.v) LGC.url = u; return u;
}
const logoPct = lg => Math.min(100, lg.w / paperDots() * 100).toFixed(1) + '%';

/* editor: pilih gambar -> pratinjau langsung -> simpan */
let LGE = null;
const loadImg = f => new Promise((ok, no) => { const u = URL.createObjectURL(f), im = new Image(); im.onload = () => { URL.revokeObjectURL(u); ok(im); }; im.onerror = () => { URL.revokeObjectURL(u); no(new Error('gambar')); }; im.src = u; });
function logoDraw(src, sw, sh, w, h) { // skala bertahap (maks. 2x per langkah) agar gambar besar tetap halus; latar transparan menjadi putih
  const mk = (a, b) => { const c = document.createElement('canvas'); c.width = a; c.height = b; const x = c.getContext('2d', {willReadFrequently: true}); x.fillStyle = '#fff'; x.fillRect(0, 0, a, b); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; return [c, x]; };
  let cur = src, cw = sw, ch = sh;
  while (cw > w * 2 || ch > h * 2) { const nw = Math.max(w, Math.ceil(cw / 2)), nh = Math.max(h, Math.ceil(ch / 2)), p = mk(nw, nh); p[1].drawImage(cur, 0, 0, nw, nh); cur = p[0]; cw = nw; ch = nh; }
  const p = mk(w, h); p[1].drawImage(cur, 0, 0, w, h); return p[0];
}
function logoSize(e) { // lebar final (kelipatan 8) dari persen lebar kertas; tinggi dibatasi LOGO_MAX_H
  let w = Math.max(8, Math.round(paperDots() * e.pct / 100 / 8) * 8), h = Math.max(1, Math.round(w * e.sh / e.sw));
  if (h > LOGO_MAX_H) { w = Math.max(8, Math.floor(LOGO_MAX_H * e.sw / e.sh / 8) * 8); h = Math.min(LOGO_MAX_H, Math.max(1, Math.round(w * e.sh / e.sw))); }
  return {w: w, h: h};
}
function logoCompute(e, rgba, w, h) { // rgba: piksel gambar pada ukuran final -> bitmap 1-bit sesuai pilihan
  let g = toGray(rgba, w * h); if (e.inv) g = g.map(v => 255 - v);
  const bw = !e.color || e.bw; // gambar tidak berwarna selalu hitam-putih tegas
  return {w: w, h: h, mode: bw ? 't' : 'h', bytes: logoPack(bw ? monoThreshold(g, e.thr) : monoDither(g, w, h, 128 - e.thr + 20), w, h)}; // +20: titik thermal melebar, halftone dibuat sedikit lebih terang
}
function logoRender() {
  const e = LGE, pv = $('#lg_cv'); if (!e || !pv) return;
  const d = logoSize(e), cv = logoDraw(e.src, e.sw, e.sh, d.w, d.h);
  e.out = logoCompute(e, cv.getContext('2d').getImageData(0, 0, d.w, d.h).data, d.w, d.h);
  logoPaint(pv, e.out); pv.style.width = logoPct(e.out);
  const inf = $('#lg_info'); if (inf) inf.textContent = d.w + ' × ' + d.h + ' titik · lebar ± ' + (d.w / 8) + ' mm · ' + (e.out.bytes.length / 1024).toFixed(1) + ' KB';
}
function logoEdit(el) {
  const e = LGE; if (!e) return; const k = el.dataset.lg;
  e[k] = el.type === 'checkbox' ? el.checked : (k === 'thr' || k === 'pct') ? Number(el.value) : el.value;
  cancelAnimationFrame(e.raf); e.raf = requestAnimationFrame(logoRender);
}
async function logoLoad(file) {
  if (!file) return;
  if (!/^image\//.test(file.type || '')) return toast('Pilih file gambar (PNG, JPG, atau WebP)');
  if (file.size > 10 * 1024 * 1024) return toast('Gambar terlalu besar (maks. 10 MB)');
  let src; try { src = typeof createImageBitmap === 'function' ? await createImageBitmap(file) : await loadImg(file); } catch (e1) { try { src = await loadImg(file); } catch (e2) { return toast('Gambar tidak bisa dibaca. Gunakan PNG atau JPG.'); } }
  const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight; if (!sw || !sh) return toast('Gambar tidak bisa dibaca. Gunakan PNG atau JPG.');
  const k = Math.min(1, 1152 / Math.max(sw, sh)), rw = Math.max(1, Math.round(sw * k)), rh = Math.max(1, Math.round(sh * k));
  const base = logoDraw(src, sw, sh, rw, rh); if (src.close) { try { src.close(); } catch (e3) {} }
  const sk = Math.min(1, 96 / Math.max(rw, rh)), sc = logoDraw(base, rw, rh, Math.max(1, Math.round(rw * sk)), Math.max(1, Math.round(rh * sk))), sd = sc.getContext('2d').getImageData(0, 0, sc.width, sc.height).data;
  const color = isColorImg(sd, sc.width * sc.height), thr = Math.min(215, Math.max(40, otsu(toGray(sd, sc.width * sc.height))));
  LGE = {src: base, sw: rw, sh: rh, color: color, bw: true, inv: false, thr: thr, pct: 60, out: null, raf: 0};
  logoSheet();
}
function logoSheet() {
  const e = LGE, pcts = [30, 40, 50, 60, 70, 80, 90, 100], kertas = rcWidth() === 48 ? '80' : '58';
  sheet('<div class="grab"></div><h2>Logo struk</h2><p class="muted">Pratinjau memakai lebar kertas ' + kertas + ' mm. Printer thermal hanya mencetak titik hitam atau putih.</p>' +
    '<div class="lg-paper"><canvas id="lg_cv" class="lg-cv" aria-label="Pratinjau logo"></canvas></div><p class="muted c" id="lg_info"></p>' +
    (e.color ? '<div class="lg-note">Logo berwarna terdeteksi. Warna tidak bisa dicetak, jadi gambar perlu diubah ke hitam-putih.</div>' +
      '<label class="sw"><input type="checkbox" data-lg="bw" checked><span class="sw-t" aria-hidden="true"></span><span class="sw-l"><b>Ubah ke hitam-putih (B&amp;W)</b><small>Aktif: garis dan teks tegas, cocok untuk logo. Nonaktif: halftone (titik-titik) agar gradasi tetap terlihat.</small></span></label>' : '') +
    '<label>Ketebalan hitam<input type="range" class="lg-rng" data-lg="thr" min="20" max="235" value="' + e.thr + '"></label><p class="muted" style="margin:-6px 0 8px">Bagian terang (mis. kuning) ikut hilang? Geser ke kanan. Terlalu pekat? Geser ke kiri.</p>' +
    '<label class="sw"><input type="checkbox" data-lg="inv"><span class="sw-t" aria-hidden="true"></span><span class="sw-l"><b>Balik hitam dan putih</b><small>Aktifkan bila logo berwarna putih atau latarnya transparan.</small></span></label>' +
    '<label>Ukuran logo (% lebar kertas)<select class="inp" data-lg="pct">' + pcts.map(p => '<option value="' + p + '"' + (p === e.pct ? ' selected' : '') + '>' + p + '%</option>').join('') + '</select></label>' +
    '<div class="row2"><button class="btn sec" data-act="close">Batal</button><button class="btn pri" data-act="logosave">Simpan logo</button></div>');
  logoRender();
}
function logoSave() {
  const e = LGE; if (!e || !e.out) return; const first = !logoGet();
  return busy('Menyimpan logo…', async () => { try { await api('setting.logo', {data: logoEncode(e.out), aktif: first}); await loadData(); closeSheet(); render(); toast('Logo disimpan'); } catch (er) { toast(er.message); } });
}
function logoDel() {
  if (S.dirty) return toast('Simpan perubahan pengaturan dulu.');
  if (!confirm('Hapus logo struk?')) return;
  return busy('Menghapus logo…', async () => { try { await api('setting.logo', {data: ''}); await loadData(); render(); toast('Logo dihapus'); } catch (er) { toast(er.message); } });
}
function logoCard() { // isi kartu "Logo struk" di Pengaturan (di luar tombol-tombol sakelar)
  const lg = logoGet(), url = lg ? logoURL(lg) : '';
  return '<input type="file" id="logo_file" accept="image/*" hidden>' + (lg ?
    '<div class="lg-paper">' + (url ? '<img class="lg-cv" alt="Logo struk" src="' + url + '" style="width:' + logoPct(lg) + '">' : '') + '</div><p class="muted c">' + lg.w + ' × ' + lg.h + ' titik · lebar ± ' + (lg.w / 8) + ' mm · ' + (lg.mode === 'h' ? 'halftone' : 'hitam-putih') + '</p>' :
    '<p class="muted">Belum ada logo. Pilih gambar (PNG, JPG, atau WebP); aplikasi mengubahnya menjadi hitam-putih untuk printer thermal.</p>') +
    '<div class="row2"><button class="btn sec sm" data-act="logopick">' + (lg ? 'Ganti logo' : 'Pilih gambar logo') + '</button>' + (lg ? '<button class="btn dan sm" data-act="logodel">Hapus logo</button>' : '') + '</div>';
}
const b64 = u8 => { let t = ''; for (let i = 0; i < u8.length; i += 0x8000) t += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(t); };
function go(url, blank) { const a = document.createElement('a'); a.href = url; if (blank) { a.target = '_blank'; a.rel = 'noopener'; } a.style.display = 'none'; document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 800); }
const isAndroid = () => /Android/i.test(navigator.userAgent);
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BT_SERVICES = ['000018f0-0000-1000-8000-00805f9b34fb', '0000ff00-0000-1000-8000-00805f9b34fb', '49535343-fe7d-4ae5-8fa9-9fafd205e455', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '0000ffe0-0000-1000-8000-00805f9b34fb', '0000fee7-0000-1000-8000-00805f9b34fb'];
const BT = {dev: null, chr: null};
async function btConnect(pick) { // Web Bluetooth: hanya printer BLE (bukan Bluetooth klasik/SPP)
  if (!navigator.bluetooth) throw new Error('Browser ini tidak mendukung Web Bluetooth');
  if (!BT.dev && !pick && navigator.bluetooth.getDevices) { try { const ds = await navigator.bluetooth.getDevices(), n = LS.get('btname', ''); BT.dev = ds.find(d => d.name === n) || null; } catch (e) {} }
  if (!BT.dev || pick) { BT.dev = await navigator.bluetooth.requestDevice({acceptAllDevices: true, optionalServices: BT_SERVICES}); BT.chr = null; LS.set('btname', BT.dev.name || ''); if (BT.dev.addEventListener) BT.dev.addEventListener('gattserverdisconnected', () => { BT.chr = null; }); }
  if (!BT.dev.gatt.connected) { BT.chr = null; await BT.dev.gatt.connect(); }
  if (!BT.chr) {
    for (const sv of await BT.dev.gatt.getPrimaryServices()) { const w = (await sv.getCharacteristics()).find(c => c.properties.writeWithoutResponse || c.properties.write); if (w) { BT.chr = w; break; } }
    if (!BT.chr) throw new Error('Printer tidak menyediakan jalur tulis BLE yang dikenali. Pastikan printer BLE, atau pakai RawBT di Android.');
  }
  return BT.chr;
}
async function btPrint(rc) {
  const bytes = escpos(rc), chr = await btConnect(false);
  for (let i = 0; i < bytes.length; i += 100) { const part = bytes.slice(i, i + 100); if (chr.properties.writeWithoutResponse) await chr.writeValueWithoutResponse(part); else await chr.writeValue(part); await sleep(25); }
}
function iosHelp() {
  sheet('<div class="grab"></div><h2>Cetak dari iPhone</h2><p class="muted">Safari dan Chrome di iPhone tidak bisa mengirim data ke printer Bluetooth. Pilihan yang bisa dipakai:</p>' +
    '<div class="li" style="display:block"><b>1. Browser dengan Web Bluetooth</b><div class="muted">Pasang browser seperti Bluefy, buka alamat aplikasi ini di sana, lalu tekan Cetak Bluetooth. Printer harus tipe <b>BLE</b>; printer Bluetooth klasik (kebanyakan printer murah) tidak dikenali iPhone.</div><button class="btn sec sm" data-act="copyurl">Salin alamat aplikasi</button></div>' +
    '<div class="li" style="display:block"><b>2. AirPrint atau PDF</b><div class="muted">Tombol Cetak memakai menu cetak iOS (printer AirPrint, atau simpan sebagai PDF).</div><button class="btn sec sm" data-act="print">Cetak</button></div>' +
    '<div class="li" style="display:block"><b>3. Bagikan struk</b><div class="muted">Kirim ke WhatsApp atau aplikasi printer lain lewat menu bagikan iOS.</div><button class="btn sec sm" data-act="share">Bagikan…</button></div>' +
    '<div class="li" style="display:block"><b>4. Android + RawBT</b><div class="muted">Untuk printer Bluetooth klasik, gunakan HP Android dengan aplikasi RawBT.</div></div><button class="btn pri" data-act="close">Mengerti</button>');
}
async function printBT(rc) {
  if (!rc) return toast('Tidak ada struk untuk dicetak');
  const direct = !!LS.get('btdirect', false);
  if (isAndroid() && !(direct && navigator.bluetooth)) return go('intent:base64,' + b64(escpos(rc)) + '#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;');
  if (navigator.bluetooth) {
    try { toast('Mencetak ke printer…'); await btPrint(rc); toast('Struk dikirim ke printer'); }
    catch (e) { logErr(e, 'btprint'); BT.chr = null; if (e && e.name === 'NotFoundError') toast('Pemilihan printer dibatalkan'); else toast('Gagal mencetak: ' + e.message); }
    return;
  }
  if (isIOS()) return iosHelp();
  toast('Bluetooth tidak tersedia di browser ini. Memakai cetak browser.'); printBrowser();
}
const PG = {rule: null};
function printBrowser() {
  const d = document.querySelector('#rtxt'); if (d && d.closest('details')) d.closest('details').open = true;
  try { // @page lewat CSSOM pada app.css (diizinkan CSP; elemen <style> sisipan tidak)
    const ss = Array.from(document.styleSheets).find(x => /css\/app\.css/.test(x.href || '')) || document.styleSheets[0];
    if (PG.rule) { const i = Array.prototype.indexOf.call(ss.cssRules, PG.rule); if (i >= 0) ss.deleteRule(i); }
    PG.rule = ss.cssRules[ss.insertRule('@page{size:' + (rcWidth() === 48 ? 80 : 58) + 'mm auto;margin:0}', ss.cssRules.length)]; // ukuran kertas mengikuti pengaturan
  } catch (e) { logErr(e, 'cetak'); }
  setTimeout(() => window.print(), 60);
}
function waSend(rc, number) {
  let n = String(number || '').replace(/\D/g, ''); if (n.indexOf('0') === 0) n = '62' + n.slice(1); else if (n.indexOf('8') === 0) n = '62' + n;
  go((n ? 'https://wa.me/' + n : 'https://api.whatsapp.com/send') + '?text=' + encodeURIComponent('```' + receiptText(rc) + '```'), true);
}
async function copyText(t, msg) {
  msg = msg || 'Struk disalin. Tempel di WhatsApp atau aplikasi lain.';
  try { await navigator.clipboard.writeText(t); toast(msg); }
  catch (e) { const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (x) {} ta.remove(); toast(ok ? msg : 'Tidak bisa menyalin.'); }
}
async function shareRc(rc) {
  const text = receiptText(rc);
  if (navigator.share) { try { await navigator.share({title: 'Struk ' + (cfg('nama_usaha') || 'Duado Snack'), text: text}); } catch (e) { if (e && e.name !== 'AbortError') copyText(text); } } else copyText(text);
}
const testRc = () => { S.nomor.uji = 'UJI-001'; return {rid: 'uji', time: Date.now(), kasir: String((S.data && S.data.user && S.data.user.nama) || 'Kasir'), ch: 'Uji coba', metode: 'tunai', terima: 20000, kembali: 3000, sub: 17000, dis: 0, ppn: 0, total: 17000, lines: [{n: 'Contoh Produk A 80gr', q: 1, h: 7000}, {n: 'Contoh Produk B 100gr', q: 1, h: 10000}]}; };

/* ---------- Login ---------- */
function renderLogin(msg) {
  $('#app').innerHTML = '<div class="login"><div class="lg-hero"><img src="icons/icon-192.png" alt="Duado Snack" width="116" height="116"><h1 class="wordmark">DUADO SNACK</h1><p>Jajanan Cemilan Pedas</p></div><div class="lg-card">' +
    '<label>Username<input id="lu" class="inp" autocomplete="username" autocapitalize="none" value="' + esc(LS.get('lastUser', '')) + '"></label>' +
    '<label>PIN atau kata sandi<input id="lp" class="inp" type="password" autocomplete="current-password"></label>' +
    '<label class="sw"><input type="checkbox" id="lsh"' + (LS.get('shared', false) ? ' checked' : '') + '><span class="sw-t" aria-hidden="true"></span><span class="sw-l"><b>Perangkat bersama</b><small>Hapus data lokal saat keluar</small></span></label>' +
    '<button class="btn pri big" data-act="login">Masuk</button><div class="err" id="lerr" role="alert">' + esc(msg || '') + '</div>' +
    (S.queue.length ? '<div class="muted">' + S.queue.length + ' transaksi menunggu dikirim setelah masuk.</div>' : '') + '</div></div>';
}
async function doLogin() {
  const u = $('#lu').value.trim(), p = $('#lp').value; if (!u || !p) return;
  $('#lerr').textContent = '';
  await busy('Masuk…', async () => { try {
    const r = await api('login', {username: u, pin: p, dev: devId()}); S.token = r.token;
    /* Penguncian ganti user: antrean pengguna lain yang belum terkirim tidak boleh tertinggal atau tercampur. */
    const other = S.queue.filter(q => q.uid !== r.uid);
    if (other.length) {
      if (can('takeover', r.role) && confirm('Ada ' + other.length + ' transaksi pengguna lain yang belum terkirim di perangkat ini.\n\nKirim atas nama mereka sekarang (diambil alih Owner)? Pilih Batal untuk membatalkan login.')) other.forEach(q => { q.by = r.uid; });
      else { try { await api('logout', {}, {silent: true}); } catch (e) {} S.token = null; throw Object.assign(new Error(can('takeover', r.role) ? 'Login dibatalkan. Antrean pengguna lain belum terkirim.' : 'Masih ada ' + other.length + ' transaksi pengguna lain yang belum terkirim di perangkat ini. Masuk sebagai pengguna tersebut dulu agar antrean terkirim, atau hubungi Owner.'), {server: true}); }
      LS.set('queue', S.queue);
    }
    LS.set('token', r.token); LS.set('lastUser', u); LS.set('shared', !!($('#lsh') && $('#lsh').checked));
    await loadData(); await shiftCheck(); S.tab = homeTab(); render(); flush();
    if (r.pin_lemah) setTimeout(() => toast(own() ? 'PIN Anda lemah. Ganti di Menu, Pengguna.' : 'PIN Anda lemah. Minta Owner menggantinya.'), 900);
  } catch (e) { S.token = null; $('#lerr').textContent = e.server ? e.message : 'Tidak dapat terhubung ke server. ' + e.message; } });
}

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
/* ---------- Kasir ---------- */
function calc() {
  const s = S.data.settings; let sub = 0; S.cart.forEach(l => { sub += l.qty * (priceOf(l.v, S.ch) || 0); });
  const dis = Math.min(Math.max(Number(S.diskon) || 0, 0), sub), base = sub - dis, pp = Number(s.ppn_persen) || 0; let ppn = 0, total = base;
  if (T(s.ppn_aktif) && pp > 0) { if (T(s.ppn_inklusif)) ppn = Math.round(base * pp / (100 + pp)); else { ppn = Math.round(base * pp / 100); total = base + ppn; } }
  return {sub: sub, dis: dis, ppn: ppn, total: total};
}
const cartQty = id => { const l = S.cart.find(x => x.v === id); return l ? l.qty : 0; };
const saveCart = () => LS.set('cart', S.cart);
const chShort = n => /whatsapp/i.test(n) ? 'WA / IG' : n;
const isWide = () => !!(window.matchMedia && matchMedia('(min-width: 768px)').matches); // tablet: layar terbagi, daftar produk kiri dan pesanan kanan
function vKasir() {
  const d = S.data, wide = isWide(); S.cart = S.cart.filter(l => vById(l.v));
  const withAny = new Set(d.variants.map(v => v.product_id)), withV = new Set(d.variants.filter(v => !isAddon(v)).map(v => v.product_id)), cats = ['Semua'].concat(Array.from(new Set(d.products.filter(p => withV.has(p.id)).map(p => String(p.kategori == null ? '' : p.kategori)).filter(Boolean)))), noV = d.products.filter(p => !withAny.has(p.id)).length;
  if (S.cat !== 'Semua' && cats.indexOf(S.cat) < 0) S.cat = 'Semua';
  const ctl = (shiftNeeded() ? '<div class="notice"><span>Kasir belum dibuka. Isi modal awal dulu agar penjualan bisa tercatat.</span><button class="chip" data-act="go_tutup">Buka kasir</button></div>' : '') + (own() && noV ? '<div class="notice"><span>' + noV + ' produk belum punya varian, jadi belum tampil di sini.</span><button class="chip" data-act="go_cek">Periksa data</button></div>' : '') + '<button id="qstat" data-act="queue"></button>' +
    '<div class="chips-wrap seg-wrap"><div class="chips seg" role="group" aria-label="Channel penjualan">' + d.channels.map(c => '<button class="' + (c.id === S.ch ? 'on' : '') + '" aria-pressed="' + (c.id === S.ch) + '" data-act="chan" data-c="' + esc(c.id) + '">' + esc(chShort(c.nama)) + '</button>').join('') + '</div></div>',
    flt = '<label class="search">' + svg('search', 18) + '<input id="q" class="inp" data-in="q" placeholder="Cari produk atau SKU" value="' + esc(S.q) + '" aria-label="Cari produk"></label>' +
    wrapChips(cats.map(c => '<button class="chip ' + (c === S.cat ? 'on' : '') + '" aria-pressed="' + (c === S.cat) + '" data-act="cat" data-c="' + esc(c) + '">' + esc(c) + '</button>').join('')) +
    '<div class="krow"><span class="muted" id="kcount"></span><label class="sw sm"><input type="checkbox" data-act="hideout"' + (S.hideOut ? ' checked' : '') + '><span class="sw-t" aria-hidden="true"></span><span class="sw-l">Sembunyikan yang habis</span></label></div>',
    top = wide ? '<div class="kasir-top">' + ctl + flt + '</div>' : '<div class="kasir-ctl">' + ctl + '</div><div class="kasir-top">' + flt + '</div>'; // v1.9.9 ponsel: pemilih channel ikut tergulir; hanya cari + kategori yang menempel (hemat ~1/4 layar)
  const m = $('#main'); m.className = wide ? 'split' : '';
  m.innerHTML = wide ? '<div class="kleft">' + top + '<div class="grid" id="grid"></div></div><aside class="kright" id="cpanel">' + cartInner(true) + '</aside>' : top + '<div class="grid" id="grid"></div>';
  grid(); if (wide) mountCart(); qstatUpd();
}
const isOff = v => priceOf(v.id, S.ch) == null || (T(cfg('blokir_stok_minus')) && (Number(v.stok) || 0) <= 0);
const TILE = [['#E0A23C', '#B8741E'], ['#E07B3C', '#9E4514'], ['#C9482A', '#8A2410'], ['#D9A441', '#8F5A1C'], ['#B8602A', '#6B1409'], ['#E7B25A', '#C07A22']];
const tileOf = v => { let h = 0; String(v.product_id || v.id).split('').forEach(c => { h = (h * 31 + c.charCodeAt(0)) >>> 0; }); return TILE[h % TILE.length]; };
/* ===== v1.9.1 (tahap 2): foto produk. Foto = satu per PRODUK (semua varian memakainya), disimpan di Supabase Storage (bucket product-photos); products.photo_url menyimpan alamatnya ===== */
const fotoOf = p => p && /^https:\/\//.test(p.foto_url || '') ? p.foto_url : '';
const photoInner = (p, name) => '<span class="ini">' + esc(String(name).trim().charAt(0).toUpperCase()) + '</span>' + (fotoOf(p) ? '<img src="' + esc(fotoOf(p)) + '" alt="" crossorigin="anonymous" referrerpolicy="no-referrer" decoding="async" loading="lazy" data-foto="1">' : '');
const photoHtml = v => photoInner(pById(v.product_id), vName(v));
function fotoErr(im) { // gagal muat: sekali coba tanpa CORS (hanya online, tidak masuk cache); gagal lagi = buang gambar, huruf awal di bawahnya tampil
  if (!im.dataset.r && im.hasAttribute('crossorigin')) { im.dataset.r = '1'; im.removeAttribute('crossorigin'); im.src = im.src; } else im.remove();
}
const FOTO = {side: 480, target: 32 * 1024, small: 40 * 1024, cache: 'duado-foto'};
const blobB64 = b => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = () => no(new Error('baca')); r.readAsDataURL(b); });
const toBlob = (cv, type, q) => new Promise(ok => { try { cv.toBlob(ok, type, q); } catch (e) { ok(null); } });
async function fotoPrepare(file) { // -> {b64, bytes}. File kecil (WebP/JPEG <= 40 KB, <= 640 px) dikirim apa adanya; selain itu dipotong persegi di tengah, dikecilkan ke 480 px, dikodekan WebP (JPEG bila WebP tak didukung)
  let src; try { src = typeof createImageBitmap === 'function' ? await createImageBitmap(file, {imageOrientation: 'from-image'}) : await loadImg(file); } catch (e1) { try { src = await loadImg(file); } catch (e2) { throw new Error('Foto tidak bisa dibaca. Gunakan JPG, PNG, atau WebP.'); } }
  const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight; if (!sw || !sh) throw new Error('Foto tidak bisa dibaca. Gunakan JPG, PNG, atau WebP.');
  if ((file.type === 'image/webp' || file.type === 'image/jpeg') && file.size <= FOTO.small && Math.max(sw, sh) <= 640) { if (src.close) src.close(); return {b64: await blobB64(file), bytes: file.size}; }
  const s = Math.min(sw, sh), m = Math.min(s, FOTO.side * 2), c0 = document.createElement('canvas'); c0.width = c0.height = m;
  const x0 = c0.getContext('2d'); x0.fillStyle = '#fff'; x0.fillRect(0, 0, m, m); x0.imageSmoothingEnabled = true; x0.imageSmoothingQuality = 'high'; x0.drawImage(src, (sw - s) >> 1, (sh - s) >> 1, s, s, 0, 0, m, m);
  if (src.close) src.close();
  let side = Math.min(FOTO.side, m), best = null, type = null;
  for (let pass = 0; pass < 3; pass++) {
    const cv = logoDraw(c0, m, m, side, side);
    if (!type) { const pr = await toBlob(cv, 'image/webp', 0.8); type = pr && pr.type === 'image/webp' ? 'image/webp' : 'image/jpeg'; } // Safari lama menjawab PNG untuk WebP
    for (const q of [0.82, 0.72, 0.62, 0.52, 0.42]) {
      const b = await toBlob(cv, type, q); if (!b) throw new Error('Foto tidak bisa dikompres di perangkat ini.');
      if (!best || b.size < best.size) best = b; if (b.size <= FOTO.target) return {b64: await blobB64(b), bytes: b.size};
    }
    side = Math.max(160, Math.round(side * 0.85)); // masih di atas target: kecilkan ukuran lalu ulangi
  }
  return {b64: await blobB64(best), bytes: best.size};
}
function fotoInner(id) {
  const p = S.data.products.find(x => x.id === id); if (!p) return '';
  const t = tileOf({id: id}), has = !!fotoOf(p);
  return '<div class="fprev ph" style="--t1:' + t[0] + ';--t2:' + t[1] + '">' + photoInner(p, p.nama) + '</div><div class="fact"><b>Foto produk</b><span class="muted">Tampil di halaman Kasir untuk semua varian. Dikecilkan otomatis (±480 px, ±30 KB).</span><div class="row2"><button class="btn sec sm" data-act="fotopick">' + (has ? 'Ganti foto' : 'Pilih foto') + '</button>' + (has ? '<button class="btn dan sm" data-act="fotodel">Hapus foto</button>' : '') + '</div></div>';
}
const fotoBox = id => id ? '<input type="file" id="foto_file" accept="image/*" hidden><div class="fbox" id="fbox">' + fotoInner(id) + '</div>' : '<p class="muted">Simpan produk dulu, lalu buka lagi untuk menambahkan foto.</p>';
function fotoApply(pid, url) {
  const p = S.data.products.find(x => x.id === pid); if (p) p.foto_url = url; LS.set('data', S.data);
  const b = $('#fbox'); if (b && S.fotoFor === pid) b.innerHTML = fotoInner(pid);
  if (S.tab === 'kasir' && $('#grid')) grid(); setTimeout(fotoWarm, 300);
}
async function fotoLoad(file) {
  const pid = S.fotoFor; if (!file || !pid) return;
  if (!/^image\//.test(file.type || '')) return toast('Pilih file gambar (JPG, PNG, atau WebP)');
  if (file.size > 25 * 1024 * 1024) return toast('Foto terlalu besar (maks. 25 MB)');
  if (navigator.onLine === false) return toast('Tidak ada koneksi. Foto hanya bisa diunggah saat online.');
  return busy('Menyiapkan foto…', async () => {
    let r; try { r = await fotoPrepare(file); } catch (e) { return toast(e.message); }
    busyLabel('Mengunggah foto (' + Math.max(1, Math.round(r.bytes / 1024)) + ' KB)…');
    try { const out = await api('produk.foto', {product_id: pid, data: r.b64}); fotoApply(pid, out.foto_url); toast('Foto tersimpan'); } catch (e) { toast(e.message); }
  });
}
async function fotoDel() {
  const pid = S.fotoFor; if (!pid || !confirm('Hapus foto produk ini?')) return;
  return busy('Menghapus foto…', async () => { try { await api('produk.foto', {product_id: pid, data: ''}); fotoApply(pid, ''); toast('Foto dihapus'); } catch (e) { toast(e.message); } });
}
document.addEventListener('error', ev => { const t = ev.target; if (t && t.tagName === 'IMG' && t.hasAttribute('data-foto')) fotoErr(t); }, true); // error gambar tidak menggelembung: ditangkap di fase capture (CSP v1.9.7 melarang onerror inline; sebelumnya fotoErr juga tidak terjangkau dari atribut)
let fotoBusy = false;
async function fotoWarm() { // simpan semua foto katalog ke cache offline (satu per satu, ringan) dan buang yang sudah tidak dipakai
  if (fotoBusy || !S.data || !window.caches || navigator.onLine === false) return; fotoBusy = true;
  try {
    const urls = Array.from(new Set((S.data.products || []).map(fotoOf).filter(Boolean))), keep = new Set(urls.map(u => new URL(u).href)), c = await caches.open(FOTO.cache);
    for (const u of urls) { try { if (!(await c.match(u, {ignoreVary: true}))) { const r = await fetch(u, {mode: 'cors', credentials: 'omit'}); if (r.ok) await c.put(u, r); } } catch (e) { /* offline atau tanpa CORS: tampil saat online saja */ } }
    for (const k of await c.keys()) if (!keep.has(k.url)) await c.delete(k);
  } catch (e) { logErr(e, 'foto'); } finally { fotoBusy = false; }
}
/* Kartu yang belum di keranjang = satu tombol "tambah". Kartu yang sudah di keranjang memuat tombol - dan + sungguhan; di dalam role=button anak-anaknya dianggap dekoratif (tak terbaca pembaca layar), jadi kartu itu menjadi group. */
const cardAttrs = v => cartQty(v.id) ? {role: 'group', 'aria-label': vName(v)} : {role: 'button', tabindex: '0', 'aria-disabled': isOff(v) ? 'true' : 'false'};
const cardRole = v => { const a = cardAttrs(v); return Object.keys(a).map(k => ' ' + k + '="' + esc(a[k]) + '"').join(''); };
function cardHtml(v) {
  const pr = priceOf(v.id, S.ch), st = Number(v.stok) || 0, q = cartQty(v.id), off = isOff(v), lv = lvText(v.level_pedas), t = tileOf(v);
  const stk = st <= 0 ? '' : st <= 5 ? '<span class="stk low">Sisa ' + num(st) + '</span>' : '<span class="stk">Stok ' + num(st) + '</span>';
  const bad = pr == null ? '<span class="badge-out warn">Harga?</span>' : st <= 0 ? '<span class="badge-out">HABIS</span>' : '';
  return '<div class="ph" style="--t1:' + t[0] + ';--t2:' + t[1] + '">' + photoHtml(v) + bad + heat(v.level_pedas) + '</div><div class="bd"><b class="pn">' + esc(vName(v)) + (lv ? ' <span class="lvt">· ' + esc(lv) + '</span>' : '') + '</b>' + (v.ukuran ? '<div class="pm"><span class="sz">' + esc(v.ukuran) + '</span></div>' : '') +
    '<div class="pf"><div class="pp"><span class="pr">' + (pr == null ? 'Harga belum diatur' : rp(pr)) + '</span>' + stk + '</div>' +
    (q ? '<div class="step"><button data-act="dec1" data-v="' + esc(v.id) + '" aria-label="Kurangi ' + esc(vName(v)) + '">−</button><b>' + q + '</b><button data-act="inc1" data-v="' + esc(v.id) + '" aria-label="Tambah ' + esc(vName(v)) + '">+</button></div>' : '<span class="plus' + (off ? ' dis' : '') + '" aria-hidden="true">+</span>') + '</div></div>';
}
function grid() {
  const d = S.data, q = S.q.toLowerCase(), avail = v => (Number(v.stok) || 0) > 0;
  const base = d.variants.filter(v => !isAddon(v) && (S.cat === 'Semua' || String((pById(v.product_id) || {}).kategori) === S.cat) && (!q || (vName(v) + ' ' + vSub(v) + ' ' + v.sku).toLowerCase().indexOf(q) >= 0));
  let list = S.hideOut ? base.filter(avail) : base;
  list = list.map((v, i) => [v, i]).sort((x, y) => (avail(y[0]) - avail(x[0])) || (x[1] - y[1])).map(x => x[0]); // tersedia di atas, habis di bawah, urutan asli dijaga
  const sig = S.cat + '|' + q + '|' + S.hideOut; if (S.gsig !== sig) { S.gsig = sig; delete LIM.grid; const mn = $('#main'); if (mn) mn.scrollTop = 0; } // filter berganti: mulai dari halaman pertama dan dari atas (tanpa ini browser menahan posisi di dasar daftar baru dan sentinel memuat berantai sampai semua baris)
  const kc = $('#kcount'); if (kc) kc.textContent = list.length + ' produk' + (S.hideOut && base.length > list.length ? ' · ' + (base.length - list.length) + ' habis disembunyikan' : '');
  $('#grid').innerHTML = (list.slice(0, lim('grid')).map(v => {
    const off = isOff(v), n = heatN(v.level_pedas);
    return '<div class="card pc h' + (n < 0 ? 'x' : n) + (off ? ' off' : '') + (cartQty(v.id) ? ' in' : '') + '" data-act="add" data-v="' + esc(v.id) + '"' + cardRole(v) + '>' + cardHtml(v) + '</div>';
  }).join('') + moreBtn('grid', list.length)) || (S.hideOut && base.length ? emptyState('stok', 'Semua produk habis', 'Matikan "Sembunyikan yang habis" untuk melihat daftar lengkap.', '<button class="btn sec" data-act="showout">Tampilkan yang habis</button>') :
    own() ? emptyState('stok', 'Belum ada produk untuk dijual', 'Produk harus punya varian dan harga agar tampil di sini.', '<button class="btn pri" data-act="go_cek">Periksa data</button>') : emptyState('stok', 'Belum ada produk', 'Tidak ada produk di kategori ini.', ''));
  watchMore();
}
function updCard(id) { // perbarui satu kartu saja, tanpa menggambar ulang seluruh daftar
  const el = document.querySelector('#grid .card[data-v="' + id + '"]'), v = vById(id); if (!el || !v) return;
  const had = el.contains(document.activeElement); // pengguna keyboard: fokus jangan hilang saat isi kartu diganti
  el.innerHTML = cardHtml(v); el.classList.toggle('in', cartQty(id) > 0);
  ['role', 'tabindex', 'aria-disabled', 'aria-label'].forEach(a => el.removeAttribute(a));
  const at = cardAttrs(v); Object.keys(at).forEach(k => el.setAttribute(k, at[k]));
  if (had) { const nx = /** @type {HTMLElement|null} */ (cartQty(id) > 0 ? el.querySelector('[data-act="inc1"]') : el); if (nx) nx.focus({preventScroll: true}); } el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
}
function barRender() {
  const el = $('#cartbar'); if (!el) return;
  if (S.tab !== 'kasir' || !S.cart.length) { el.innerHTML = ''; return; }
  const c = calc(), n = S.cart.reduce((a, l) => a + l.qty, 0);
  el.innerHTML = '<button class="cartbar" data-act="cart"><span class="cb-i">' + svg('kasir', 20) + '<em>' + n + '</em></span><span class="cb-t"><small>' + n + ' item</small><b>' + rp(c.total) + '</b></span><span class="cb-go">Bayar ' + svg('chev', 18) + '</span></button>';
}
function cartbar() { // ponsel: bilah bawah; tablet: panel pesanan di kanan
  if (isWide()) { const b = $('#cartbar'); if (b) b.innerHTML = ''; if (S.tab === 'kasir' && $('#cpanel')) { cartLines(); cashBox(); upd(); } return; }
  barRender();
}
function addToCart(id) {
  const v = vById(id); if (!v) return;
  if (priceOf(id, S.ch) == null) return toast('Harga belum diatur untuk channel ini');
  const l = S.cart.find(x => x.v === id), q = (l ? l.qty : 0) + 1, st = Number(v.stok) || 0;
  if (T(cfg('blokir_stok_minus')) && q > st) return toast(st > 0 ? 'Stok tidak cukup' : 'Stok habis');
  if (l) l.qty = q; else { S.cart.push({v: id, qty: 1}); if (S.cart.length > lim('cart')) LIM.cart = S.cart.length; } // baris baru selalu terlihat
  saveCart(); updCard(id); syncCart(); buzz();
}
function dropFromCart(id) {
  const i = S.cart.findIndex(x => x.v === id); if (i < 0) return;
  S.cart[i].qty--; if (S.cart[i].qty <= 0) S.cart.splice(i, 1); saveCart(); updCard(id); syncCart();
}
const payMethods = () => ['tunai', 'transfer', 'qris'].filter(m => { const v = cfg('bayar_' + m); return v === undefined || v === '' || T(v); }); // whitelist dari Pengaturan
const methodChips = () => payMethods().map(m => '<button class="chip ' + (S.metode === m ? 'on' : '') + '" aria-pressed="' + (S.metode === m) + '" data-act="metode" data-m="' + m + '">' + m.toUpperCase() + '</button>').join('');
function cartLines() {
  const el = $('#cl'); if (!el) return;
  if (!S.cart.length) { delete LIM.cart; el.innerHTML = '<div class="cp-empty">' + svg('kasir', 34) + '<p>Ketuk produk di sebelah kiri untuk menambahkannya ke pesanan.</p></div>'; return; }
  el.innerHTML = S.cart.slice(0, lim('cart')).map((l, i) => { const v = vById(l.v), p = priceOf(l.v, S.ch) || 0;
    return '<div class="li cl-i"><div class="cl-n"><b>' + esc(vName(v)) + '</b><div class="muted">' + esc([vSub(v), rp(p)].filter(Boolean).join(' · ')) + '</div></div><div class="qty"><button data-act="dec" data-i="' + i + '" aria-label="Kurangi">−</button><span>' + l.qty + '</span><button data-act="inc" data-i="' + i + '" aria-label="Tambah">+</button></div><b class="cl-t">' + rp(p * l.qty) + '</b></div>'; }).join('') + moreBtn('cart', S.cart.length); watchMore();
}
function cashBox() {
  const el = $('#cashbox'); if (!el) return;
  if (S.metode !== 'tunai') { const mn = Number(cfg('bayar_referensi_min')), req = mn > 0 && calc().total >= mn;   // F-10: referensi transfer/QRIS untuk rekonsiliasi dengan mutasi penyedia
    el.innerHTML = '<p class="muted">Pembayaran ' + esc(S.metode.toUpperCase()) + ' dicatat lunas saat disimpan.</p><label>No. referensi ' + (req ? '(wajib)' : '(disarankan)') + '<input class="inp" data-in="ref" maxlength="60" autocomplete="off" placeholder="Dari bukti ' + esc(S.metode.toUpperCase()) + '" value="' + esc(S.ref || '') + '"></label>'; return; }
  const t = calc().total, q = [t].concat([5000, 10000, 20000, 50000, 100000].map(n => Math.ceil(t / n) * n)).filter((x, i, a) => x > 0 && a.indexOf(x) === i).slice(0, 4);
  el.innerHTML = '<label>Uang diterima (Rp)<input class="inp" data-in="terima" inputmode="numeric" placeholder="' + num(t) + '" value="' + esc(S.terima) + '"></label><div class="chips">' + q.map((x, i) => '<button class="chip" data-act="qk" data-n="' + x + '">' + (i === 0 ? 'Uang pas' : num(x)) + '</button>').join('') + '</div>';
}
function cartInner(panel) {
  return (panel ? '<div class="cp-h"><h2>Pesanan</h2><span class="muted">' + esc(chName(S.ch)) + '</span></div>' : '<div class="grab"></div><div class="sh-h"><h2>Pembayaran</h2><span class="muted">' + esc(chName(S.ch)) + '</span></div>') +
    '<div id="cl"></div><div id="addons"></div><div class="paybox"><div class="chips" id="mchips">' + methodChips() + '</div><div id="cashbox"></div></div>' +
    '<details class="more"' + (S.diskon || S.catatan ? ' open' : '') + '><summary>Diskon dan catatan</summary><label>Diskon (Rp)<input class="inp" data-in="diskon" inputmode="numeric" value="' + esc(S.diskon) + '"></label><label>Catatan<input class="inp" data-in="catatan" value="' + esc(S.catatan) + '"></label></details>' +
    '<div id="tot"></div><button class="btn pri big" id="paybtn" data-act="pay">Bayar</button>';
}
function addonsRender() { // menu pembayaran: "Tambahan" seperti retail modern (kantong kresek, dll.)
  const el = $('#addons'); if (!el) return; const L = S.data.variants.filter(v => isAddon(v) && priceOf(v.id, S.ch) != null), block = T(cfg('blokir_stok_minus'));
  if (!L.length) { el.innerHTML = own() ? '<p class="muted ad-none">Belum ada produk tambahan (mis. kantong kresek). Buat di Pengaturan, kartu "Kantong & Tambahan".</p>' : ''; return; }
  el.innerHTML = '<div class="ad-h">Tambahan</div>' + L.map(v => { const q = cartQty(v.id), st = Number(v.stok) || 0, out = block && st <= 0, nm = esc(vName(v) + (v.ukuran ? ' ' + v.ukuran : ''));
    return '<div class="ad-row"><div class="ad-n"><b>' + nm + '</b><small>' + rp(priceOf(v.id, S.ch)) + (out ? ' · habis' : '') + '</small></div>' +
      (q ? '<div class="qty"><button data-act="dec1" data-v="' + esc(v.id) + '" aria-label="Kurangi ' + nm + '">−</button><span>' + q + '</span><button data-act="inc1" data-v="' + esc(v.id) + '" aria-label="Tambah ' + nm + '">+</button></div>' : '<button class="chip ad-add" data-act="inc1" data-v="' + esc(v.id) + '"' + (out ? ' aria-disabled="true"' : '') + '>+ Tambah</button>') + '</div>'; }).join('');
}
function refreshCart() { cartLines(); addonsRender(); cashBox(); upd(); if (!S.cart.length && !isWide() && $('#sheet') && !$('#sheet').hidden && $('#cl')) closeSheet(); }
const syncCart = () => { if ($('#cl')) refreshCart(); else cartbar(); };
const mountCart = () => { cartLines(); addonsRender(); cashBox(); upd(); };
function cartSheet() { if (isWide() || !S.cart.length) return; sheet(cartInner(false)); mountCart(); }
function upd() {
  const c = calc(), s = S.data.settings, kv = (a, b, cl) => '<div class="kv ' + (cl || '') + '"><span>' + a + '</span><span>' + b + '</span></div>', tunai = S.metode === 'tunai', terima = S.terima === '' ? null : Number(S.terima) || 0;
  let h = kv('Subtotal', rp(c.sub)); if (c.dis) h += kv('Diskon', '-' + rp(c.dis)); if (c.ppn) h += kv(T(s.ppn_inklusif) ? 'PPN (sudah termasuk)' : 'PPN', rp(c.ppn));
  h += kv('Total', rp(c.total), 'big'); if (tunai && terima !== null) h += kv(terima >= c.total ? 'Kembalian' : 'Kurang', rp(Math.abs(terima - c.total)), terima >= c.total ? 'ok-r' : 'err-r');
  const t = $('#tot'); if (t) t.innerHTML = h;
  const b = $('#paybtn'); if (b) { const short = tunai && terima !== null && terima < c.total; b.disabled = short || !S.cart.length; b.textContent = !S.cart.length ? 'Bayar' : short ? 'Uang kurang ' + rp(c.total - terima) : 'Bayar ' + rp(c.total); }
  if (!isWide()) barRender();
}
/* Otorisasi Owner di perangkat ini: Owner mengetik PIN, server memberi token sekali pakai untuk satu transaksi (PIN tidak disimpan). */
function askOwner(msg, kind, rid, nilai, ref) {
  return new Promise(res => {
    S.opin = {res: res, kind: kind, rid: rid, nilai: nilai, ref: ref};
    sheet('<div class="grab"></div><h2>Otorisasi Owner / Supervisor</h2><p class="muted">' + esc(msg) + '</p><label>Username Owner / Supervisor<input class="inp" id="ou" autocapitalize="none" value="' + esc(LS.get('ownerUser', 'owner')) + '"></label><label>PIN Owner / Supervisor<input class="inp" id="op" type="password" inputmode="numeric" autocomplete="off"></label><div class="err" id="oerr"></div><button class="btn pri" data-act="opin_ok">Setujui</button><button class="btn sec" data-act="close">Batal</button>');
  });
}
async function opinOk() {
  const o = S.opin; if (!o) return; const u = ($('#ou') || {}).value, pw = ($('#op') || {}).value; if (!u || !pw) return;
  $('#oerr').textContent = '';
  try { const r = await api('override.grant', {kind: o.kind, request_id: o.rid, nilai: o.nilai, ref_id: o.ref, username: u.trim(), pin: pw, dev: devId()}); LS.set('ownerUser', u.trim()); S.opin = null; closeSheet(); o.res(r.token); }
  catch (e) { $('#oerr').textContent = e.server ? e.message : 'Otorisasi butuh koneksi internet.'; }
}
async function pay() {
  if (S.paying || !S.cart.length) return;
  if (S.cart.some(l => !vById(l.v))) { S.cart = S.cart.filter(l => vById(l.v)); saveCart(); toast('Ada produk yang sudah tidak tersedia; keranjang diperbarui'); if (S.cart.length) { if (!isWide()) cartSheet(); } else closeSheet(); cartbar(); return; }
  const c = calc(), tunai = S.metode === 'tunai', terima = tunai ? (S.terima === '' ? c.total : Number(S.terima) || 0) : c.total;
  if (tunai && terima < c.total) return toast('Uang diterima kurang');
  { const mn = Number(cfg('bayar_referensi_min')); if (!tunai && mn > 0 && c.total >= mn && !String(S.ref || '').trim()) return toast('Isi nomor referensi ' + S.metode.toUpperCase() + ' (transaksi Rp' + num(mn) + ' ke atas)'); }
  if (payMethods().indexOf(S.metode) < 0) { S.metode = payMethods()[0] || 'tunai'; LS.set('metode', S.metode); const mc = $('#mchips'); if (mc) mc.innerHTML = methodChips(); cashBox(); upd(); return toast('Metode bayar tidak tersedia, dipilih ' + S.metode.toUpperCase()); }
  S.paying = true; let rc;
  const rid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2), ts = Date.now(), override = {};
  if (!own()) { // kontrol kasir: diskon di atas batas butuh PIN Owner (diverifikasi server saat ini juga)
    const raw = cfg('diskon_maks_persen'), mp = Number(raw), maks = raw === undefined || raw === '' || isNaN(mp) ? 100 : mp;
    if (c.dis > c.sub * maks / 100 + 0.5) {
      const tok = await askOwner('Diskon ' + rp(c.dis) + ' melebihi batas ' + maks + '% dari subtotal. Minta Owner memasukkan PIN untuk menyetujui.', 'diskon', rid, c.dis);
      if (!tok) { S.paying = false; if (!isWide()) cartSheet(); return; }
      override.diskon = tok;
    }
  }
  try {
    const payload = {request_id: rid, outlet_id: S.data.outlet ? S.data.outlet.id : undefined, channel_id: S.ch, items: S.cart.map(l => ({variant_id: l.v, qty: l.qty})), diskon: c.dis, metode_bayar: S.metode, catatan: S.catatan, client_ts: ts, total_klien: c.total};
    if (!tunai && String(S.ref || '').trim()) payload.referensi_bayar = String(S.ref).trim().slice(0, 60);
    if (override.diskon) payload.override = override;
    rc = {rid: rid, time: ts, kasir: String((S.data.user && (S.data.user.nama || S.data.user.username)) || ''), ch: chName(S.ch), metode: S.metode, terima: terima, kembali: terima - c.total, sub: c.sub, dis: c.dis, ppn: c.ppn, total: c.total,
      lines: S.cart.map(l => { const v = vById(l.v); return {n: (vName(v) + ' ' + vSub(v)).trim(), q: l.qty, h: priceOf(l.v, S.ch)}; })};
    S.queue.push({rid: rid, payload: payload, status: 'pending', state: 'waiting', ts: Date.now(), uid: S.data.user.uid, total: c.total, ch: rc.ch}); LS.set('queue', S.queue);
    S.cart.forEach(l => { const v = vById(l.v); if (v) v.stok = r6((Number(v.stok) || 0) - l.qty); }); LS.set('data', S.data);
  } catch (e) { S.paying = false; logErr(e, 'bayar'); return toast('Transaksi gagal disimpan: ' + e.message); }
  /* transaksi sudah aman di antrean: kosongkan keranjang lebih dulu agar tidak pernah tersisa, apa pun yang terjadi setelah ini */
  S.cart = []; S.diskon = ''; S.terima = ''; S.catatan = ''; S.ref = ''; LS.del('cart'); closeSheet();
  try { render(); } catch (e) { logErr(e, 'render'); }
  try { showReceipt(rc); } catch (e) { logErr(e, 'struk'); toast('Transaksi tersimpan, tetapi struk gagal ditampilkan.'); }
  if (T(cfg('auto_cetak'))) { try { printBT(rc); } catch (e) { logErr(e, 'cetak'); } }
  S.paying = false; flush();
}
function showReceipt(rc) {
  S.rc = rc; const tunai = rc.metode === 'tunai';
  sheet('<div class="grab"></div><div class="okmark">' + svg('check', 30) + '</div><h2 class="c">Pembayaran berhasil</h2><div class="rc-sum"><div><small>Total</small><b>' + rp(rc.total) + '</b></div><div><small>' + (tunai ? 'Kembalian' : 'Metode') + '</small><b>' + (tunai ? rp(Math.max(rc.kembali, 0)) : esc(rc.metode.toUpperCase())) + '</b></div></div>' +
    '<label>No. WhatsApp pelanggan (opsional)<input class="inp" id="wa" inputmode="tel" placeholder="08xxxxxxxxxx"></label>' +
    '<div class="row2"><button class="btn wa" data-act="wa">Kirim WhatsApp</button><button class="btn dark" data-act="rawbt">Cetak Bluetooth</button></div>' +
    '<div class="row3"><button class="btn sec sm" data-act="share">Bagikan…</button><button class="btn sec sm" data-act="copyrc">Salin</button><button class="btn sec sm" data-act="print">Cetak</button></div>' +
    '<details class="more"><summary>Lihat struk</summary><pre class="rc" id="rtxt"></pre></details><button class="btn pri big" data-act="close">Transaksi baru</button>');
  refreshRc();
}
function refreshRc() { // pratinjau + cetak browser: logo (bila aktif) di atas teks struk
  const el = $('#rtxt'); if (!el || !S.rc) return; const lg = logoOn(), u = lg ? logoURL(lg) : '', w = rcWidth();
  el.className = 'rc' + (w === 48 ? ' w48' : '');
  el.innerHTML = (u ? '<img class="lg-cv lg-rc" alt="Logo" src="' + u + '" style="width:' + logoPct(lg) + '">' : '') + docHtml(receiptDoc(S.rc, {w: w, rich: true, logo: lg}), w);
}

/* ---------- Riwayat ---------- */
async function vRiwayat() {
  const t0 = today(), day = S.day || t0; if (S.rlimDay !== day) { S.rlimDay = day; delete LIM.hist; } // hari berganti: mulai dari halaman pertama
  const yd = addDays(t0, -1), pre = S.rcustom ? 'custom' : day === t0 ? 'today' : day === yd ? 'yday' : 'custom';
  $('#main').innerHTML = wrapChips('<button class="chip ' + (pre === 'today' ? 'on' : '') + '" data-act="rday" data-p="today">Hari ini</button><button class="chip ' + (pre === 'yday' ? 'on' : '') + '" data-act="rday" data-p="yday">Kemarin</button><button class="chip ' + (pre === 'custom' ? 'on' : '') + '" data-act="rday" data-p="custom">Pilih tanggal</button>') +
    '<p class="muted rcap">' + esc(idDate(day)) + '</p>' + (pre === 'custom' ? '<label>Tanggal<input type="date" class="inp" data-chg="day" value="' + day + '"></label>' : '') + '<div id="rq"></div><div id="rsum"></div><div id="rlist">' + skel(3) + '</div>';
  const qs = S.queue.map((q, i) => q.uid !== S.data.user.uid && q.by !== S.data.user.uid ? '' : '<div class="li"><div><b>' + rp(q.total) + '</b> <span class="muted">' + esc(q.ch) + ' · ' + fmtDT(q.ts).slice(11) + '</span>' +
    (q.status === 'review' ? '<div class="muted" style="color:var(--err)">' + esc(q.error) + '</div>' : '') + '</div><div class="r"><span class="tag ' + (q.status === 'review' ? 'red' : '') + '">' + (q.status === 'review' ? 'Perlu ditinjau' : 'Menunggu kirim') + '</span>' +
    (q.status === 'review' ? '<div>' + (qinfo(q).accept ? '<button class="chip" data-act="qaccept" data-i="' + i + '">Terima harga server</button> ' : '') + '<button class="chip" data-act="qretry" data-i="' + i + '">Coba lagi</button> <button class="chip" data-act="qdel" data-i="' + i + '">Hapus</button></div>' : '') + '</div></div>').join('');
  $('#rq').innerHTML = qs;
  const uid = S.data.user.uid, hist = S.rhist && S.rhist.uid === uid ? S.rhist : (S.rhist = {uid: uid, d: {}}), ent = hist.d[day];
  const paint = e => {
    if (S.tab !== 'riwayat' || !$('#rlist') || !$('#rsum')) return; const rows = e.rows; S.rcur = e;
    const sm = e.sum || (() => { const dn = rows.filter(r => r.status === 'selesai'); return {omzet: dn.reduce((a, r) => a + Number(r.total), 0), nTrx: dn.filter(r => !r.ref_sale_id).length, nDone: dn.length}; })(), nTrx = sm.nTrx, omzet = sm.omzet, avg = nTrx ? omzet / nTrx : 0; // v1.9.9: ringkasan dari server (semua transaksi), bukan hanya halaman yang dimuat; // retur (nilai minus) mengurangi omzet tetapi tidak dihitung sebagai transaksi
    $('#rsum').innerHTML = '<div class="kgrid"><div class="kpi"><div class="muted">Omzet</div><b>' + rp(omzet) + '</b></div><div class="kpi"><div class="muted">Transaksi</div><b>' + nTrx + '</b></div><div class="kpi wide"><div class="muted">Rata-rata per transaksi</div><b>' + rp(avg) + '</b></div>' + (own() ? '<div class="kpi wide"><div class="muted">Produk terlaris</div><b id="rtop">' + (sm.nDone ? (e.top || 'Memuat…') : '-') + '</b></div>' : '') + '</div>';
    if (own() && sm.nDone && !e.top && !e.topReq) { e.topReq = true; api('report.get', {type: 'penjualan', from: day, to: day}, {silent: true}).then(r => { const best = r.rows.slice().sort((a, b) => b[2] - a[2])[0]; e.top = best ? esc((best[0] + ' ' + best[1]).trim()) + ' <small class="muted">' + qf(best[2]) + ' terjual</small>' : '-'; const el = $('#rtop'); if (el && S.tab === 'riwayat') el.innerHTML = e.top; }).catch(() => { const el = $('#rtop'); if (el && !e.top) el.textContent = '-'; }); }
    paintList(e);
  };
  const paintList = e => { // v1.9.8: daftar bertahap; "Tampilkan lagi" hanya menggambar ulang daftar (KPI tidak dihitung ulang)
    if (S.tab !== 'riwayat' || !$('#rlist')) return; const rows = e.rows;
    const rest = e.srv ? e.total - rows.length : 0; $('#rlist').innerHTML = (e.srv ? rows : rows.slice(0, lim('hist'))).map(r => '<div class="li"><div><b>' + esc(r.nomor) + '</b>' + (r.ref_sale_id ? ' <span class="tag red">Retur</span>' : '') + (r.review ? ' <span class="tag red">Perlu ditinjau</span>' : '') + '<div class="muted">' + esc(String(r.tanggal).slice(11, 16)) + ' · ' + esc(chName(r.channel_id)) + ' · ' + esc(r.metode_bayar) + '</div>' + (r.review && r.review_note ? '<div class="muted" style="color:var(--err)">' + esc(r.review_note) + '</div>' : '') + '</div><div class="r"><b>' + rp(r.total) + '</b>' + (r.review && can('approve') ? '<div><button class="chip" data-act="sreview" data-id="' + esc(r.id) + '">Tandai ditinjau</button></div>' : '') + (r.status === 'selesai' && !r.ref_sale_id ? '<div><button class="chip" data-act="retur" data-id="' + esc(r.id) + '">Retur</button></div>' : '') + '</div></div>').join('') + (e.srv ? (rest > 0 ? '<button class="btn sec lmore" data-act="more" data-k="hist">Tampilkan ' + Math.min(rest, PGN.hist) + ' lagi (sisa ' + rest + ')</button>' : '') : moreBtn('hist', rows.length)) ||
      emptyState('riwayat', 'Belum ada transaksi', 'Tidak ada transaksi pada ' + esc(idDate(day)) + '.', '<button class="btn pri" data-act="tab" data-t="kasir">Mulai transaksi</button>');
    watchMore();
  };
  S.rlist = paintList;
  S.rmore = async () => { // halaman berikutnya dari server; hindari ganda lewat id (transaksi baru menggeser urutan)
    const e = S.rcur; if (!e || !e.srv || e.loading || e.rows.length >= e.total) return; e.loading = true;
    try { const r = await api('sales.list', {tanggal: day, limit: PGN.hist, offset: e.rows.length}, {silent: true}); if (r && r.rows) { const seen = new Set(e.rows.map(x => x.id)); r.rows.forEach(x => { if (!seen.has(x.id)) e.rows.push(x); }); e.total = r.total; } }
    catch (er) { toast('Gagal memuat transaksi berikutnya: ' + er.message); } finally { e.loading = false; if (S.rcur === e) paintList(e); }
  };
  try {
    if (ent) paint(ent); // tampil seketika dari hasil terakhir; diperbarui hanya bila ada data baru
    if (ent && navigator.onLine === false) return;
    await verSync(15000); if (S.tab !== 'riwayat' || !$('#rlist')) return; // cek versi murah dulu; muat daftar penuh hanya bila versi berubah
    const k = dverKey(); if (ent && ent.k === k) return;
    const res = await api('sales.list', {tanggal: day, limit: PGN.hist}); if (S.tab !== 'riwayat' || !$('#rlist')) return;
    const ne = Array.isArray(res) ? {k: k, rows: res} : {k: k, rows: res.rows, total: res.total, sum: res.summary, srv: true}; /* server lama menjawab larik penuh */ hist.d[day] = ne; Object.keys(hist.d).slice(0, -8).forEach(x => delete hist.d[x]); paint(ne); // maks. 8 hari disimpan di memori
  } catch (e) { if ($('#rlist') && !ent) $('#rlist').innerHTML = '<p class="muted">Tidak bisa memuat riwayat dari server (' + esc(e.message) + ').</p>'; }
}

/* ---------- Stok dan pembelian ---------- */
const stState = (st, min, thr) => st <= 0 ? 'out' : (min > 0 ? st <= min : st < thr) ? 'low' : 'ok';
const stBadge = x => x === 'out' ? '<span class="bdg out">Habis</span>' : x === 'low' ? '<span class="bdg low">Menipis</span>' : '';
function vStok() {
  const o = can('materials'), bahan = S.stab === 'bahan' && o;
  const tabs = o ? wrapChips('<button class="chip ' + (S.stab === 'varian' ? 'on' : '') + '" data-act="stab" data-s="varian">Produk jadi</button><button class="chip ' + (S.stab === 'bahan' ? 'on' : '') + '" data-act="stab" data-s="bahan">Bahan dan kemasan</button>') : '';
  const cats = bahan ? ['Semua', 'bahan', 'kemasan', 'barang jadi beli'] : ['Semua'].concat(Array.from(new Set(S.data.variants.map(v => String((pById(v.product_id) || {}).kategori || '')).filter(Boolean))));
  if (cats.indexOf(S.scat) < 0) S.scat = 'Semua';
  $('#main').innerHTML = tabs + (bahan && can('stockedit') ? '<button class="btn pri" data-act="pbopen" style="margin-top:0">+ Pembelian bahan</button>' : '') +
    '<label class="search" style="margin-top:8px">' + svg('search', 18) + '<input id="sq" class="inp" data-in="sq" placeholder="' + (bahan ? 'Cari bahan' : 'Cari produk atau SKU') + '" value="' + esc(S.sq) + '" aria-label="Cari stok"></label>' +
    wrapChips(cats.map(c => '<button class="chip ' + (c === S.scat ? 'on' : '') + '" data-act="scat" data-c="' + esc(c) + '">' + esc(c === 'Semua' || !bahan ? c : c.charAt(0).toUpperCase() + c.slice(1)) + '</button>').join('')) + '<div id="ssum" class="ssum"></div><div id="slist"></div>';
  stokList();
}
function stokList() {
  const o = can('materials'), cost = can('cost'), edit = can('stockedit'), bahan = S.stab === 'bahan' && o, q = S.sq.toLowerCase(), thr = Number(cfg('stok_menipis')) > 0 ? Number(cfg('stok_menipis')) : 5; let rows;
  if (bahan) rows = S.data.materials.filter(m => (S.scat === 'Semua' || m.tipe === S.scat) && (!q || (m.nama + ' ' + m.satuan).toLowerCase().indexOf(q) >= 0)).map(m => ({id: m.id, t: 'bahan', name: String(m.nama), lv: '', sub: cost ? 'HPP rata-rata ' + rp(m.hpp_rata2) + '/' + m.satuan : m.satuan, val: qf(m.stok) + ' ' + m.satuan, st: stState(Number(m.stok) || 0, Number(m.stok_minimum) || 0, thr)}));
  else rows = S.data.variants.filter(v => (S.scat === 'Semua' || String((pById(v.product_id) || {}).kategori) === S.scat) && (!q || (vName(v) + ' ' + vSub(v) + ' ' + v.sku).toLowerCase().indexOf(q) >= 0)).map(v => ({id: v.id, t: 'varian', name: String(vName(v)), lv: lvText(v.level_pedas), sub: [v.ukuran].filter(Boolean).join('') + (cost ? ' · HPP ' + rp(v.hpp_rata2) : ''), val: num(v.stok), st: stState(Number(v.stok) || 0, 0, thr)}));
  const rank = {out: 0, low: 1, ok: 2}; rows.sort((a, b) => rank[a.st] - rank[b.st] || a.name.localeCompare(b.name, 'id') || a.sub.localeCompare(b.sub, 'id')); // habis dan menipis di atas
  const nOut = rows.filter(r => r.st === 'out').length, nLow = rows.filter(r => r.st === 'low').length, ss = $('#ssum');
  if (ss) ss.innerHTML = nOut || nLow ? (nOut ? '<span class="bdg out">' + nOut + ' habis</span>' : '') + (nLow ? '<span class="bdg low">' + nLow + ' menipis</span>' : '') : '<span class="muted">' + rows.length + ' item · semua stok aman</span>';
  const row = r => { const body = '<div class="st-n"><b>' + esc(r.name) + (r.lv ? ' <span class="lvt">· ' + esc(r.lv) + '</span>' : '') + '</b><div class="muted">' + esc(r.sub) + '</div></div><div class="st-v"><b>' + esc(r.val) + '</b>' + stBadge(r.st) + '</div>';
    return edit ? '<button class="li st-row" data-act="adj" data-t="' + r.t + '" data-id="' + esc(r.id) + '">' + body + svg('chev', 18) + '</button>' : '<div class="li st-row">' + body + '</div>'; };
  $('#slist').innerHTML = rows.length ? rows.map(row).join('') : (S.sq || S.scat !== 'Semua' ? emptyState('stok', 'Tidak ditemukan', 'Coba kata kunci atau kategori lain.', '') :
    bahan ? emptyState('stok', 'Belum ada bahan', 'Tambahkan bahan dan kemasan yang dipakai resep di Data Master.', '<button class="btn pri" data-act="rimat">Tambah bahan</button>') :
    emptyState('stok', 'Belum ada produk', o ? 'Tambahkan produk, varian, dan stok awal di Data Master.' : 'Minta owner menambahkan produk.', o ? '<button class="btn pri" data-act="go_master">Buka Data Master</button>' : ''));
}
function adjSheet(t, id) {
  const it = t === 'bahan' ? S.data.materials.find(m => m.id === id) : vById(id); if (!it) return;
  sheet('<h2>Penyesuaian stok</h2><p class="muted">' + esc(t === 'bahan' ? it.nama : vName(it) + ' ' + vSub(it)) + ' · stok sekarang ' + qf(it.stok) + '</p><label>Stok baru<input class="inp" id="a_s" inputmode="decimal" value="' + esc(String(it.stok).replace('.', ',')) + '"></label>' +
    '<label>HPP rata-rata (kosongkan jika tidak diubah; isi untuk stok awal)<input class="inp" id="a_h" inputmode="decimal" placeholder="' + esc(it.hpp_rata2) + '"></label><label>Alasan<input class="inp" id="a_r" value="Stok opname"></label>' +
    '<button class="btn pri" data-act="adjsave" data-t="' + t + '" data-id="' + esc(id) + '">Simpan</button>');
}
async function adjSave(t, id) {
  return busy('Menyimpan stok…', async () => {
  try {
    const r = await api('stock.adjust', {tipe: t, id: id, stok_baru: dnum($('#a_s').value), hpp: $('#a_h').value.trim() === '' ? '' : dnum($('#a_h').value), alasan: $('#a_r').value});
    const it = t === 'bahan' ? S.data.materials.find(m => m.id === id) : vById(id); it.stok = r.stok; it.hpp_rata2 = r.hpp_rata2; LS.set('data', S.data); closeSheet(); render(); toast('Stok disimpan');
  } catch (e) { toast(e.message); }
  });
}
function pbSheet() {
  const m = S.data.materials, pb = S.pb, tot = pb.items.reduce((a, i) => a + i.qty * i.harga, 0);
  sheet('<h2>Pembelian bahan</h2><label>Supplier<select class="inp" data-in="pbsup"><option value="">- tanpa supplier -</option>' + S.data.suppliers.map(s => '<option value="' + esc(s.id) + '"' + (s.id === pb.sup ? ' selected' : '') + '>' + esc(s.nama) + '</option>').join('') + '</select></label>' +
    pb.items.map((i, n) => { const x = m.find(y => y.id === i.id); return '<div class="li"><div><b>' + esc(x ? x.nama : '?') + '</b><div class="muted">' + qf(i.qty) + ' ' + esc(x ? x.satuan : '') + ' @ ' + rp(i.harga) + '</div></div><button class="chip" data-act="pbdel" data-i="' + n + '">Hapus</button></div>'; }).join('') +
    '<label>Bahan<select class="inp" id="pb_m">' + m.map(x => '<option value="' + esc(x.id) + '">' + esc(x.nama) + ' (' + esc(x.satuan) + ')</option>').join('') + '</select></label><div class="row2"><div style="flex:1"><label>Jumlah<input class="inp" id="pb_q" inputmode="decimal"></label></div><div style="flex:1"><label>Harga satuan (Rp)<input class="inp" id="pb_h" inputmode="decimal"></label></div></div>' +
    '<button class="btn sec" data-act="pbadd">Tambah ke daftar</button><label>Ongkir (Rp, dialokasikan ke HPP)<input class="inp" data-in="pbongkir" inputmode="numeric" value="' + esc(pb.ongkir) + '"></label>' +
    '<div class="kv big"><span>Total</span><span>' + rp(tot + (Number(pb.ongkir) || 0)) + '</span></div><button class="btn pri" data-act="pbsave">Simpan pembelian</button><button class="btn sec sm" data-act="pbhist">Riwayat pembelian / batalkan</button>');
}
/* F-16: riwayat pembelian + pembatalan (supervisor ke atas). Stok bahan dikurangi kembali; ditolak bila bahan sudah terpakai. */
async function pbHist() {
  sheet('<h2>Riwayat pembelian</h2><div id="pbh">' + skel(3) + '</div>');
  try {
    const L = await api('purchase.list', {}), sup = id => { const s = (S.data.suppliers || []).find(x => x.id === id); return s ? s.nama : ''; };
    $('#pbh').innerHTML = L.length ? L.map(x => '<div class="li" style="display:block"><div class="kv"><b>' + esc(String(x.waktu).slice(0, 10)) + (sup(x.supplier_id) ? ' · ' + esc(sup(x.supplier_id)) : '') + '</b><span>' + rp(x.total) + '</span></div>' +
      (x.status === 'cancelled' ? '<div class="muted"><span class="tag red">Dibatalkan</span> ' + esc(x.alasan_batal) + '</div>' : (can('approve') ? '<button class="chip" data-act="pbcancel" data-id="' + esc(x.id) + '">Batalkan</button>' : '')) + '</div>').join('') : '<p class="muted">Belum ada pembelian.</p>';
  } catch (e) { $('#pbh').innerHTML = '<p class="err">' + esc(e.message) + '</p>'; }
}
async function pbCancel(id) {
  const why = prompt('Alasan membatalkan pembelian ini (min. 3 huruf):'); if (why === null) return; if (why.trim().length < 3) return toast('Alasan wajib diisi');
  return busy('Membatalkan…', async () => { try { await api('purchase.cancel', {id: id, alasan: why.trim()}); await loadData(); toast('Pembelian dibatalkan, stok bahan dikembalikan'); pbHist(); } catch (e) { toast(e.message); } });
}
async function pbSave() {
  return busy('Menyimpan pembelian…', async () => {
  const pb = S.pb; if (!pb.items.length) return toast('Daftar masih kosong');
  try {
    const r = await api('purchase.create', {supplier_id: pb.sup, ongkir: Number(pb.ongkir) || 0, items: pb.items.map(i => ({material_id: i.id, qty: i.qty, harga_satuan: i.harga}))});
    r.materials.forEach(u => { const m = S.data.materials.find(x => x.id === u.id); if (m) { m.stok = u.stok; if (u.hpp_rata2 !== undefined) m.hpp_rata2 = u.hpp_rata2; } });   // server hanya mengirim stok; jangan menghapus HPP yang ada
    LS.set('data', S.data); S.pb = {items: [], ongkir: '', sup: ''}; closeSheet(); render(); toast('Pembelian tersimpan, HPP diperbarui');
  } catch (e) { toast(e.message); }
  });
}

/* ---------- Menu, data master, pengguna, pengaturan ---------- */
const standalone = () => !!((window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true);
function confirmLogout() {
  const p = S.queue.length; if (!confirm(p ? 'Masih ada ' + p + ' transaksi yang belum terkirim ke server. Transaksi itu tetap tersimpan di perangkat dan dikirim saat Anda masuk lagi. Tetap keluar?' : 'Keluar dari akun ini?')) return;
  S.dirty = false; logout();
}
function vMenu() {
  const u = S.data.user, o = own(), nIssue = o && APP.issueCount ? APP.issueCount() : 0;
  const mi = (a, ic, t, sub, cl, bd) => '<button class="mi ' + (cl || '') + '" data-act="' + a + '"><span class="mi-i">' + svg(ic, 20) + '</span><span class="mi-t"><b>' + t + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</span>' + (bd ? '<span class="mi-b" aria-label="' + bd + ' masalah">' + bd + '</span>' : '') + svg('chev', 18) + '</button>';
  const inst = S.installEv && !standalone() ? '<div class="grp">' + mi('install', 'install', 'Pasang Aplikasi', 'Tambahkan ke layar utama agar terbuka seperti aplikasi') + '</div>' :
    (isIOS() && !standalone() ? '<div class="li" style="display:block"><b>Pasang di layar utama</b><div class="muted">Di Safari, ketuk tombol Bagikan lalu pilih "Tambah ke Layar Utama".</div></div>' : '');
  $('#main').innerHTML = '<div class="profile"><div class="av">' + esc(String(u.nama || '?').charAt(0).toUpperCase()) + '</div><div class="pi"><b>' + esc(u.nama) + '</b><div class="muted">' + esc(u.role) + ' · versi ' + esc(C.VERSION || '') + '</div></div><span class="badge ' + (navigator.onLine ? 'ok' : 'off') + '">' + (navigator.onLine ? 'Online' : 'Offline') + '</span></div>' +
    '<p class="muted note">Data terakhir diperbarui: ' + (S.lastSync ? fmtDT(S.lastSync).slice(11) : 'dari cache perangkat') + '. Aplikasi hanya memuat ulang jika ada data baru.</p>' + inst +
    ((o || can('report') || can('transfer') || can('sell') || can('history')) ? '<div class="grp"><h3>Operasional</h3>' + (o || (can('history') && !can('sell')) ? mi('go_riwayat', 'riwayat', 'Riwayat penjualan', 'Transaksi per tanggal') : '') + (can('report') ? mi('go_laporan', 'laporan', 'Laporan', can('cost') ? 'Laba rugi, penjualan, HPP, stok' : 'Penjualan, stok, produksi, pembelian') : '') + (can('transfer') ? mi('go_transfer', 'master', 'Transfer stok', 'Kirim dan terima stok antar outlet') : '') + (can('sell') ? mi('go_tutup', 'riwayat', 'Buka dan tutup kasir', 'Modal awal, kas masuk/keluar, hitung uang laci') : '') + (o ? mi('go_cek', 'cek', 'Pemeriksaan data', nIssue ? nIssue + ' hal perlu diperbaiki' : 'Kelengkapan data dan kesesuaian stok', '', nIssue) : '') + '</div>' : '') + (o ?
      '<div class="grp"><h3>Data</h3>' + mi('go_master', 'master', 'Data Master', 'Produk, varian, harga, bahan, resep, biaya') + mi('go_shopee', 'shopee', 'Impor pesanan Shopee', 'Dari file CSV') + mi('go_users', 'users', 'Pengguna', 'Owner dan kasir') + (S.data.outlets ? mi('go_outlets', 'master', 'Outlet', 'Tambah outlet, atur status dan pengguna') : '') + mi('go_settings', 'settings', 'Pengaturan', 'Usaha, PPN, stok, printer, HPP') + '</div>' : '') +
    '<div class="grp"><h3>Sistem</h3>' + mi('sync', 'sync', 'Perbarui data', own() ? 'Muat ulang semua dari spreadsheet dan kirim antrean' : 'Cek data baru dan kirim antrean') + mi('go_diag', 'diag', 'Diagnostik dan uji cetak', 'Cek koneksi, WhatsApp, dan printer') + '</div>' +
    '<div class="grp grp-out">' + mi('logout', 'out', 'Keluar', 'Keluar dari akun ini', 'danger') + '</div>';
}
function vDiag() {
  setTimeout(() => { // bandingkan versi config.js dengan versi cache sw.js: beda = unggahan web/ tidak lengkap, sehingga banner pembaruan tidak akan muncul
    const el = $('#dver'); if (!el || !window.caches) return;
    caches.keys().then(ks => {
      const sw = ks.filter(k => /^duado-v/.test(k)).map(k => k.slice(7)), me = String(C.VERSION || ''), kv = (a, b) => '<div class="kv"><span>' + a + '</span><span>' + b + '</span></div>'; if (!$('#dver')) return;
      $('#dver').innerHTML = kv('Versi cache (sw.js)', esc(sw.join(', ') || '-')) +
        (sw.length > 1 ? '<p class="muted">Pembaruan sudah diunduh dan menunggu. Tutup lalu buka ulang aplikasi, atau tekan Muat ulang pada banner.</p>' : sw.length === 1 && sw[0] !== me ? '<p class="err">Versi config.js (' + esc(me) + ') dan sw.js (' + esc(sw[0]) + ') tidak sama. Unggah ulang SELURUH isi folder web/ (isi API_URL di config.js tetap milik Anda), lalu buka ulang aplikasi.</p>' : '');
    }).catch(() => {});
  }, 0);
  const q = S.queue, errs = LS.get('errlog', []), kv = (a, b) => '<div class="kv"><span>' + a + '</span><span>' + b + '</span></div>', standalone = window.matchMedia && matchMedia('(display-mode: standalone)').matches;
  $('#main').innerHTML = '<button class="chip" data-act="tab" data-t="menu">← Menu</button><div class="card-s"><h3>Info perangkat</h3>' + kv('Versi aplikasi', esc(C.VERSION || '-')) + '<div id="dver"></div>' + kv('Versi data', esc(dverKey() || '-')) + kv('Layar tersimpan (cache)', Object.keys(VC).length + ' hasil') + kv('Mode', standalone ? 'Terpasang (layar utama)' : 'Browser') + kv('Koneksi', navigator.onLine ? 'Online' : 'Offline') +
    kv('Android (untuk RawBT)', isAndroid() ? 'Ya' : 'Tidak') + kv('Fitur Bagikan', navigator.share ? 'Tersedia' : 'Tidak tersedia') + kv('Antrean transaksi', q.filter(x => x.status === 'pending').length + ' menunggu, ' + q.filter(x => x.status === 'review').length + ' perlu ditinjau') + kv('Lebar struk', rcWidth() + ' karakter') + '</div>' +
    '<div class="card-s"><h3>Uji koneksi dan kecepatan server</h3><button class="btn sec" data-act="dping">Uji koneksi</button><div id="dres" class="muted" style="margin-top:6px"></div></div>' +
    '<div class="card-s"><h3>Printer Bluetooth</h3>' + kv('Android (RawBT)', isAndroid() ? 'Ya' : 'Tidak') + kv('iPhone / iPad', isIOS() ? 'Ya' : 'Tidak') + kv('Web Bluetooth (BLE langsung)', navigator.bluetooth ? 'Tersedia' : 'Tidak tersedia') + kv('Printer tersimpan', esc(LS.get('btname', '') || '-')) + '<label style="margin:8px 0"><input type="checkbox" data-act="btdirect"' + (LS.get('btdirect', false) ? ' checked' : '') + '> Cetak langsung via BLE (tanpa RawBT)</label><button class="btn sec" data-act="btpick">Pilih printer BLE</button>' + (isIOS() ? '<p class="muted">iPhone: gunakan browser dengan Web Bluetooth (mis. Bluefy) dan printer BLE.</p>' : '') + '</div>' +
    '<div class="card-s"><h3>Uji struk</h3><p class="muted">Memeriksa WhatsApp dan printer tanpa membuat transaksi.</p><div class="row2"><button class="btn wa" data-act="dtwa">Uji WhatsApp</button><button class="btn dark" data-act="dtbt">Uji cetak Bluetooth</button></div><button class="btn sec" data-act="dtshare">Uji Bagikan</button>' +
    '<p class="muted">Cetak Bluetooth memakai aplikasi <b>RawBT</b> (Android): pasang dari Play Store, pasangkan printer di dalam RawBT, lalu coba cetak dari RawBT dulu.</p></div>' +
    '<div class="card-s"><h3>Catatan kesalahan</h3>' + (errs.length ? errs.slice(0, 8).map(e => '<div class="muted" style="margin-bottom:6px">' + esc(fmtDT(e.t).slice(5)) + ' · ' + esc(e.c) + ': ' + esc(e.m) + '</div>').join('') : '<p class="muted">Belum ada.</p>') + '<div class="row2"><button class="btn sec" data-act="dcopy">Salin log</button><button class="btn sec" data-act="dclear">Hapus catatan</button></div><p class="muted">Galat dari ekstensi browser tidak ikut dicatat.</p></div>';
}
const RT = {};
const MT = {
  products: {l: 'Produk', k: 'products', f: [['nama', 'Nama produk'], ['kategori', 'Kategori (mis. Basreng)']], t: r => r.nama + (r.kategori ? ' · ' + r.kategori : '')},
  product_variants: {l: 'Varian', k: 'variants', f: [['product_id', 'Produk', 'ref:products'], ['sku', 'SKU (kosongkan untuk otomatis)'], ['ukuran', 'Ukuran kemasan (mis. 100 g)'], ['level_pedas', 'Level pedas (mis. Level 3)']], t: r => vName(r) + ' · ' + vSub(r)},
  channel_prices: {l: 'Harga jual', k: 'prices', f: [['variant_id', 'Varian', 'ref:variants'], ['channel_id', 'Channel', 'ref:channels'], ['harga_jual', 'Harga jual (Rp)', 'number']], t: r => { const v = vById(r.variant_id); return (v ? vName(v) + ' ' + vSub(v) : '?') + ' · ' + chName(r.channel_id) + ' · ' + rp(r.harga_jual); }},
  materials: {l: 'Bahan dan kemasan', k: 'materials', f: [['nama', 'Nama'], ['tipe', 'Tipe', 'sel:bahan,kemasan,barang jadi beli'], ['satuan', 'Satuan (kg, gram, pcs)'], ['stok_minimum', 'Stok minimum', 'number'], ['satuan_kecil', 'Satuan kecil untuk resep (opsional, mis. ml)'], ['faktor_kecil', 'Isi satuan kecil per 1 satuan (mis. 1000)', 'number']], t: r => r.nama + ' (' + r.satuan + ')'},
  suppliers: {l: 'Supplier', k: 'suppliers', f: [['nama', 'Nama'], ['kontak', 'Kontak'], ['catatan', 'Catatan']], t: r => r.nama},
  expenses: {l: 'Biaya operasional', k: 'expenses', f: [['tanggal', 'Tanggal', 'date'], ['kategori', 'Kategori', 'sel:Gas,Listrik,Air,Sewa,Gaji/Tenaga kerja,Transport,Pemasaran,Lain-lain'], ['nominal', 'Nominal (Rp)', 'number'], ['lingkup', 'Dicatat pada', 'sel2:outlet|Outlet aktif,pusat|Pusat (semua outlet; tidak dibagi otomatis)'], ['catatan', 'Catatan']], t: r => String(r.tanggal).slice(0, 10) + ' · ' + r.kategori + ' · ' + rp(r.nominal)},
  channels: {l: 'Channel', k: 'channels', f: [['nama', 'Nama'], ['fee_persen', 'Fee (%)', 'number'], ['fee_tetap', 'Fee tetap (Rp)', 'number'], ['basis_fee', 'Fee dihitung dari', 'sel2:total|Total bayar (termasuk PPN),subtotal|Subtotal (sebelum diskon),omzet|Omzet bersih (tanpa PPN)']], t: r => r.nama + ' · fee ' + (r.fee_persen || 0) + '%'}
};
Object.keys(MT).forEach(k => RT[MT[k].k] = MT[k].t);
function field(f, val) {
  const k = f[0], l = f[1], t = f[2] || '', v = val == null ? '' : val;
  if (t.indexOf('ref:') === 0) { const key = t.slice(4); return '<label>' + l + '<select class="inp" data-f="' + k + '"><option value="">- pilih -</option>' + S.data[key].map(r => '<option value="' + esc(r.id) + '"' + (r.id === v ? ' selected' : '') + '>' + esc(RT[key](r)) + '</option>').join('') + '</select></label>'; }
  if (t.indexOf('sel:') === 0) return '<label>' + l + '<select class="inp" data-f="' + k + '">' + t.slice(4).split(',').map(o => '<option' + (o === v ? ' selected' : '') + '>' + o + '</option>').join('') + '</select></label>';
  if (t.indexOf('sel2:') === 0) return '<label>' + l + '<select class="inp" data-f="' + k + '">' + t.slice(5).split(',').map(o => { const p = o.split('|'); return '<option value="' + p[0] + '"' + (p[0] === v ? ' selected' : '') + '>' + p[1] + '</option>'; }).join('') + '</select></label>';
  if (t.indexOf('area') === 0) return '<label>' + l + '<textarea class="inp ta" rows="3" maxlength="' + (Number(t.slice(5)) || 300) + '" data-f="' + k + '">' + esc(v) + '</textarea></label>';
  if (t === 'date') return '<label>' + l + '<input type="date" class="inp" data-f="' + k + '" value="' + esc(String(v).slice(0, 10)) + '"></label>';
  const uq = a => Array.from(new Set(a.filter(Boolean))), D = S.data || {products: [], variants: []};
  const sug = k === 'kategori' ? uq((D.products || []).map(p => p.kategori)) : k === 'ukuran' ? uq((D.variants || []).map(x => x.ukuran).concat(['50 g', '100 g', '250 g', '500 g'])) :
    k === 'level_pedas' ? uq((D.variants || []).map(x => x.level_pedas).concat(['Original', 'Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5'])) : null;
  return '<label>' + l + '<input class="inp" data-f="' + k + '"' + (sug ? ' list="dl_' + k + '"' : '') + (t === 'number' ? ' inputmode="decimal"' : '') + ' value="' + esc(v) + '">' +
    (sug ? '<datalist id="dl_' + k + '">' + sug.map(x => '<option value="' + esc(x) + '">').join('') + '</datalist>' : '') + '</label>';
}
function readForm() { const o = {}; document.querySelectorAll('#sheet [data-f]').forEach(e => o[e.dataset.f] = e.type === 'checkbox' ? e.checked : e.value); return o; }
function vMaster(noLoad) {
  const cfg = MT[S.mt], rows = S.mt === 'expenses' ? (S.exp || []) : (S.data[cfg.k] || []);
  $('#main').innerHTML = '<button class="chip" data-act="tab" data-t="menu">← Menu</button><div class="chips" style="margin-top:8px">' + Object.keys(MT).map(k => '<button class="chip ' + (k === S.mt ? 'on' : '') + '" data-act="mt" data-k="' + k + '">' + MT[k].l + '</button>').join('') + '<button class="chip" data-act="go_resep">Resep</button></div>' +
    '<button class="btn pri" data-act="medit" data-id="">+ Tambah ' + cfg.l.toLowerCase() + '</button><div style="height:8px"></div>' +
    rows.map(r => '<button class="li" style="width:100%;border:0;font:inherit;text-align:left" data-act="medit" data-id="' + esc(r.id) + '"><span' + (r.dibatalkan || r.pembalik ? ' style="text-decoration:' + (r.dibatalkan ? 'line-through' : 'none') + ';opacity:.7"' : '') + '>' + esc(cfg.t(r)) + (r.dibatalkan ? ' (dibatalkan)' : r.pembalik ? ' (pembatalan)' : '') + '</span><span class="muted">' + (S.mt === 'expenses' ? 'Rincian' : 'Ubah') + '</span></button>').join('') + (S.mt === 'expenses' && !S.expLoaded ? skel(3) : '');
  if (S.mt === 'expenses' && !noLoad) loadExp();
}
async function loadExp() { await vload('master.list', {table: 'expenses'}, r => { S.exp = r; S.expLoaded = true; if (S.tab === 'master' && S.mt === 'expenses') vMaster(true); }, {fail: e => toast(e.message)}); }
function meditSheet(id) {
  const cfg = MT[S.mt], r = id ? (S.mt === 'expenses' ? S.exp : S.data[cfg.k]).find(x => x.id === id) : {tanggal: today()};
  S.fotoFor = S.mt === 'products' ? id : null;
  if (S.mt === 'expenses' && id) { // F-16: biaya tidak diubah; salah catat dibatalkan (baris pembalik + alasan), lalu dicatat ulang dengan benar
    const st = r.dibatalkan ? '<p class="muted">Biaya ini sudah dibatalkan.</p>' : r.pembalik ? '<p class="muted">Ini baris pembatalan; tidak dapat dibatalkan lagi.</p>' : r.dari_laci ? '<p class="muted">Berasal dari kas keluar laci (uang sudah keluar dari laci), tidak bisa dibatalkan di sini.</p>' :
      '<label>Alasan pembatalan<input class="inp" id="xv_r" placeholder="Min. 3 huruf"></label><button class="btn dan" data-act="expvoid" data-id="' + esc(id) + '">Batalkan biaya</button>';
    sheet('<h2>Rincian biaya</h2><div class="li" style="display:block"><div class="kv"><span>Tanggal</span><span>' + esc(r.tanggal) + '</span></div><div class="kv"><span>Kategori</span><span>' + esc(r.kategori) + '</span></div><div class="kv"><span>Nominal</span><span>' + rp(r.nominal) + '</span></div><div class="muted">' + esc(r.catatan) + '</div></div>' + st); return;
  }
  sheet('<h2>' + (id ? 'Ubah ' : 'Tambah ') + cfg.l.toLowerCase() + '</h2>' + (S.mt === 'products' ? fotoBox(id) : '') + cfg.f.map(f => field(f, r[f[0]])).join('') + (S.mt === 'product_variants' ? '<button class="btn sec sm" data-act="skugen" data-id="' + esc(id) + '">Buat SKU otomatis</button>' : '') + '<button class="btn pri" data-act="msave" data-id="' + esc(id) + '">Simpan</button>' + (id ? '<button class="btn dan" data-act="mdel" data-id="' + esc(id) + '">Hapus</button>' : ''));
}
async function mSave(id) {
  return busy('Menyimpan data…', async () => {
  const data = readForm(); if (id) data.id = id;
  ['harga_jual', 'fee_persen', 'fee_tetap', 'stok_minimum', 'nominal', 'faktor_kecil'].forEach(k => { if (k in data) data[k] = dnum(data[k]) || 0; });
  try { const rec = await api('master.save', {table: S.mt, data: data}); S.expLoaded = false; if (!patchMaster(S.mt, rec)) await loadData(); closeSheet(); render(); toast('Tersimpan'); } catch (e) { toast(e.message); }
  });
}
/* Setelah simpan, server mengembalikan rekaman terbaru: perangkat cukup memperbarui satu baris, tanpa mengunduh ulang seluruh data (dulu: dua permintaan berurutan). */
const PATCH_KEY = {products: 'products', product_variants: 'variants', channel_prices: 'prices', channels: 'channels', materials: 'materials', suppliers: 'suppliers'};
function patchMaster(t, rec) {
  const k = PATCH_KEY[t]; if (!k || !rec || !rec.id || !S.data[k] || String(rec.aktif) === 'false') return false;
  if (t === 'product_variants' && !S.data.products.some(p => p.id === rec.product_id)) return false;
  rec = Object.assign({}, rec); delete rec.created_at; delete rec.updated_at;
  if (t === 'product_variants' || t === 'materials') { const old = S.data[k].find(x => x.id === rec.id); if (old) { rec.stok = old.stok; rec.hpp_rata2 = own() ? rec.hpp_rata2 : old.hpp_rata2; } } // stok hanya berubah lewat transaksi
  const i = S.data[k].findIndex(x => x.id === rec.id); if (i >= 0) S.data[k][i] = Object.assign({}, S.data[k][i], rec); else S.data[k].push(rec);
  idxReset(); LS.set('data', S.data); return true;
}
function patchRecipe(r) {
  if (!r || !r.recipe || !S.data.recipes) return false; const rec = Object.assign({}, r.recipe); delete rec.created_at; delete rec.updated_at;
  const i = S.data.recipes.findIndex(x => x.id === rec.id); if (i >= 0) S.data.recipes[i] = rec; else S.data.recipes.push(rec);
  S.data.recipe_items = (S.data.recipe_items || []).filter(x => x.recipe_id !== rec.id).concat(r.items); LS.set('data', S.data); return true;
}
async function mDel(id) {
  return busy('Menghapus…', async () => {
  if (!confirm('Hapus data ini?')) return;
  try { await api('master.remove', {table: S.mt, id: id}); S.expLoaded = false; await loadData(); closeSheet(); render(); toast('Dihapus'); } catch (e) { toast(e.message); }
  });
}
async function vUsers() {
  $('#main').innerHTML = '<button class="chip" data-act="tab" data-t="menu">← Menu</button><button class="btn pri" data-act="uedit" data-id="">+ Tambah pengguna</button><div id="ul">' + skel(3) + '</div>';
  await vload('user.list', undefined, users => { S.users = users; if (!$('#ul')) return; $('#ul').innerHTML = S.users.map(u => '<button class="li" style="width:100%;border:0;font:inherit;text-align:left;margin-top:8px" data-act="uedit" data-id="' + esc(u.id) + '"><span><b>' + esc(u.nama) + '</b> <span class="muted">@' + esc(u.username) + '</span></span><span class="urow-b"><span class="badge role">' + esc(roleName(u.role)) + '</span>' + (String(u.aktif) === 'false' ? '<span class="tag red">Nonaktif</span>' : '') + (u.terkunci ? '<span class="tag red">Terkunci</span>' : '') + '</span></button>').join(''); },
    {fail: e => { if ($('#ul')) $('#ul').innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; }});
}
/* F8: Owner/Admin/Auditor memakai kata sandi (min. 10 karakter, huruf+angka); peran operasional memakai PIN 6-10 angka. Aturan yang sama ditegakkan Edge Function admin-users. */
const PRIV_ROLES = ['owner', 'admin', 'auditor'];
function credLabel(role, id) { return (PRIV_ROLES.indexOf(role) >= 0 ? 'Kata sandi (min. 10 karakter, huruf dan angka)' : 'PIN (6-10 angka, tidak berurutan/berulang)') + (id ? ', kosongkan jika tidak diganti' : ''); }
function credProblem(secret, role) {
  if (PRIV_ROLES.indexOf(role) >= 0) return secret.length < 10 ? 'Kata sandi Owner/Admin/Auditor minimal 10 karakter.' : (!/[A-Za-z]/.test(secret) || !/\d/.test(secret)) ? 'Kata sandi harus memuat huruf dan angka.' : null;
  return /^\d{6,10}$/.test(secret) ? null : 'PIN harus 6-10 angka.';
}
/* P0-1: pilihan peran = peran yang boleh diberikan pemanggil + peran pengguna saat ini (supaya tidak berpindah diam-diam saat form dibuka). */
function roleOptions(cur) {
  const allow = ASSIGNABLE[S.data.user.role] || [];
  return ROLES.filter(r => allow.indexOf(r[0]) >= 0 || r[0] === cur);
}
function ueditSheet(id) {
  const u = id ? S.users.find(x => x.id === id) : {role: 'kasir', aktif: true};
  const opts = roleOptions(u.role), known = ROLES.some(r => r[0] === u.role);
  sheet('<h2>' + (id ? 'Ubah' : 'Tambah') + ' pengguna</h2>' + field(['nama', 'Nama'], u.nama) + field(['username', 'Username'], u.username) +
    selF('role', 'Peran', (known ? [] : [['', '- pilih peran -']]).concat(opts), u.role) + '<p class="muted role-info" id="role-info" aria-live="polite">' + esc(ROLE_INFO[u.role] || 'Pilih peran untuk melihat hak aksesnya.') + '</p>' +
    '<label id="pin-lbl">' + credLabel(u.role, id) + '<input class="inp" data-f="pin" type="password" autocomplete="new-password"></label><label class="sw"><input type="checkbox" data-f="aktif"' + (String(u.aktif) !== 'false' ? ' checked' : '') + '><span class="sw-t" aria-hidden="true"></span><span class="sw-l"><b>Aktif</b><small>Nonaktif: tidak bisa masuk</small></span></label>' + (id && u.terkunci ? '<div class="notice"><span>Akun ini terkunci sementara karena terlalu banyak percobaan masuk yang salah.</span><button class="chip" data-act="uunlock" data-id="' + esc(id) + '">Buka kunci</button></div>' : '') + '<button class="btn pri" data-act="usave" data-id="' + esc(id) + '">Simpan</button>');
}
async function uSave(id) {
  return busy('Menyimpan pengguna…', async () => {
  const d = readForm(); if (id) { d.id = id; const cur = (S.users.find(x => x.id === id) || {}).role; if (!d.role || d.role === cur) delete d.role; }   // P0-1: kirim peran hanya bila benar-benar diubah
  if (!id && !d.role) { toast('Pilih peran.'); return; }
  { const role = d.role || (S.users.find(x => x.id === id) || {}).role, cp = d.pin ? credProblem(String(d.pin), role) : null; if (cp) { toast(cp); return; } }   // server tetap memeriksa ulang
  try { await api('user.save', d); closeSheet(); vUsers(); toast('Tersimpan'); } catch (e) { toast(e.message); }
  });
}
const selF = (k, l, pairs, cur) => '<label>' + l + '<select class="inp" data-f="' + k + '">' + pairs.map(p => '<option value="' + p[0] + '"' + (String(cur) === p[0] ? ' selected' : '') + '>' + p[1] + '</option>').join('') + '</select></label>';
const setSnap = () => JSON.stringify(Array.from(document.querySelectorAll('#sf [data-f]')).map(e => e.type === 'checkbox' ? e.checked : e.value));
function sDepUpd() { // field yang bergantung: tarif PPN hanya saat PPN aktif; overhead sesuai cara hitung yang dipilih
  const on = k => { const e = document.querySelector('#sf [data-f=' + k + ']'); return e && e.checked; }, m = (document.querySelector('#sf [data-f=metode_overhead]') || {}).value || 'per_unit';
  const set = (id, show) => { const e = $('#' + id); if (e) e.hidden = !show; };
  set('ppn-x', on('ppn_aktif')); set('hdr-x', on('header_aktif')); set('ftr-x', on('footer_aktif')); set('oh-unit', m === 'per_unit'); set('oh-batch', m === 'per_batch');
  const h = $('#oh-hint'); if (h) h.textContent = m === 'per_batch' ? 'Biaya overhead (gas, listrik, dll.) dihitung tetap setiap sekali produksi, berapa pun hasilnya.' : 'Biaya overhead (gas, listrik, dll.) dihitung per bungkus yang dihasilkan. Contoh: Rp300 × 118 bungkus.';
}
function sDirty() { S.dirty = setSnap() !== S.sSnap; const b = $('#ssavebtn'); if (b) b.disabled = !S.dirty; sDepUpd(); }
function addonSheet() {
  sheet('<div class="grab"></div><h2>Buat produk tambahan</h2><p class="muted">Contoh: kantong kresek. Muncul di menu pembayaran kasir sebagai "Tambahan". Harga berlaku untuk semua channel; stok berkurang otomatis setiap terjual.</p>' +
    '<label>Nama<input class="inp" id="ad_n" value="Kantong Kresek"></label><div class="row2"><div style="flex:1"><label>Harga jual (Rp)<input class="inp" id="ad_h" inputmode="decimal" value="500"></label></div><div style="flex:1"><label>Biaya/HPP per buah (Rp)<input class="inp" id="ad_c" inputmode="decimal" value="0"></label></div></div>' +
    '<label>Stok awal (jumlah)<input class="inp" id="ad_s" inputmode="decimal" value="100"></label><button class="btn pri" data-act="addonsave">Simpan</button><button class="btn sec" data-act="close">Batal</button>');
}
function vSettings() {
  const s = S.data.settings, g = (k, d) => (s[k] == null || s[k] === '' ? d : s[k]), card = (t, h) => '<section class="set-card"><h3>' + t + '</h3>' + h + '</section>';
  const sw = (k, l, sub, def) => '<label class="sw"><input type="checkbox" data-f="' + k + '"' + (T(s[k] == null || s[k] === '' ? def : s[k]) ? ' checked' : '') + '><span class="sw-t" aria-hidden="true"></span><span class="sw-l"><b>' + l + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</span></label>';
  const m = $('#main'); m.className = 'col';
  m.innerHTML = '<button class="chip" data-act="tab" data-t="menu" style="align-self:flex-start">← Menu</button><div id="sf" style="margin-top:8px">' +
    card('Usaha & Struk', field(['nama_usaha', 'Nama usaha'], s.nama_usaha) + '<p class="muted" style="margin:-4px 0 8px">Dicetak sebagai judul struk hanya bila logo tidak dipakai.</p>' + selF('lebar_struk', 'Lebar kertas struk', [['32', '58 mm (area cetak 48 mm)'], ['48', '80 mm (area cetak 72 mm)']], g('lebar_struk', '32'))) +
    card('Logo struk', logoCard() + sw('logo_aktif', 'Cetak logo di struk', 'Untuk printer thermal. Nama usaha tidak dicetak lagi bila logo aktif. Struk WhatsApp tetap berupa teks.') +
      (logoGet() ? '<button class="btn sec sm" data-act="logotest">Uji cetak logo</button>' : '') + '<p class="muted">Ukuran kertas diganti (58 atau 80 mm)? Pilih ulang logo agar ukurannya pas.</p>') +
    card('Header & footer struk', sw('header_aktif', 'Header: catatan di bawah logo', 'Mis. slogan, alamat, nomor telepon, Instagram. Matikan bila tidak perlu.', true) +
      '<div id="hdr-x">' + field(['header_struk', 'Isi header', 'area:300'], s.header_struk) + '</div>' +
      sw('footer_aktif', 'Footer: catatan di bawah struk', 'Mis. ucapan terima kasih. Matikan bila tidak perlu.', true) +
      '<div id="ftr-x">' + field(['footer_struk', 'Isi footer', 'area:300'], s.footer_struk) + '</div>' +
      '<p class="muted">Satu baris di sini = satu baris di struk (teks panjang turun baris otomatis). Bungkus baris dengan *bintang* agar tercetak tebal, mis. *TERIMA KASIH*.</p>' +
      field(['qr_struk', 'Isi QR di bawah struk (opsional)', 'text'], s.qr_struk) + '<p class="muted">Mis. tautan Instagram atau WhatsApp toko. Kosongkan bila tanpa QR. Maks. 120 karakter. QR dicetak sebagai gambar, sama seperti logo.</p>' +
      '<button class="btn sec sm" data-act="rcpreview">Pratinjau &amp; uji cetak struk</button><p class="muted">Pratinjau memakai pengaturan yang sudah disimpan.</p>') +
    card('Pajak (PPN)', sw('ppn_aktif', 'Aktifkan PPN', 'Hitung PPN pada setiap transaksi') + '<div id="ppn-x">' + field(['ppn_persen', 'Tarif PPN (%)', 'number'], s.ppn_persen) + sw('ppn_inklusif', 'Harga jual sudah termasuk PPN') + '</div>') +
    card('Stok', sw('blokir_stok_minus', 'Blokir penjualan jika stok kurang', 'Kasir tidak bisa menjual produk yang stoknya habis') + field(['stok_menipis', 'Batas "Menipis" produk jadi (jumlah)', 'number'], g('stok_menipis', '5'))) +
    card('Kantong & Tambahan', '<p class="muted">Produk berkategori "Tambahan" (mis. kantong kresek) muncul di menu pembayaran kasir sebagai pilihan tambahan, bukan di daftar produk.</p>' +
      (S.data.variants.filter(isAddon).map(v => '<div class="kv"><span>' + esc(vName(v)) + '</span><span>' + rp(priceOf(v.id, S.ch) || 0) + ' · stok ' + num(v.stok) + '</span></div>').join('') || '<p class="muted">Belum ada produk tambahan.</p>') +
      '<button class="btn sec sm" data-act="addonnew">+ Buat produk tambahan (kresek)</button>') +
    card('Kontrol kasir', field(['diskon_maks_persen', 'Batas diskon kasir (% dari subtotal)', 'number'], g('diskon_maks_persen', '10')) + '<p class="muted">Di atas batas ini, kasir butuh PIN Owner. Owner tidak dibatasi.</p>' + sw('bayar_tunai', 'Metode: Tunai') + sw('bayar_transfer', 'Metode: Transfer') + sw('bayar_qris', 'Metode: QRIS') + sw('tolak_selisih_total', 'Tolak transaksi bila total struk berbeda dari server', 'Disarankan aktif. Owner dapat menyetujui kasus tertentu dengan PIN.')) +
    card('Kontrol data', field(['opname_ambang_nilai', 'Ambang nilai opname untuk peran Stok (Rp; kosongkan = tanpa batas)', 'number'], s.opname_ambang_nilai == null ? '500000' : s.opname_ambang_nilai) + '<p class="muted">Penyesuaian stok di atas nilai ini perlu supervisor/owner. Mengubah HPP yang sudah ada selalu perlu supervisor/owner.</p>' +
      field(['transfer_ambang_nilai', 'Transfer di atas nilai ini tidak boleh disetujui pemohonnya sendiri (Rp; kosong = nonaktif)', 'number'], s.transfer_ambang_nilai) +
      field(['bayar_referensi_min', 'Nomor referensi wajib untuk Transfer/QRIS mulai Rp (kosong = opsional)', 'number'], s.bayar_referensi_min) + '<p class="muted">Referensi dipakai mencocokkan penjualan dengan mutasi QRIS/bank (Laporan → Pembayaran per metode).</p>') +
    (can('takeover') ? card('Kunci periode (Owner)', '<p class="muted">Tanggal sampai ' + esc(s.kunci_periode_sampai || '(belum dikunci)') + '. Biaya dan impor bertanggal pada/sebelum tanggal kunci ditolak; transaksi kasir tertunda dicatat dengan waktu server.</p><label>Kunci sampai tanggal (kosong = buka semua)<input class="inp" type="date" id="pl_d" value="' + esc(s.kunci_periode_sampai || '') + '"></label><label>Alasan<input class="inp" id="pl_r" placeholder="Mis. tutup buku Oktober"></label><button class="btn sec sm" data-act="plock">Terapkan kunci</button>') : '') +
    card('Printer', sw('auto_cetak', 'Langsung cetak setelah bayar', 'RawBT (Android) atau printer Bluetooth BLE') + '<button class="btn sec sm" data-act="go_diag">Atur dan uji printer</button>') +
    card('HPP & Overhead', selF('metode_overhead', 'Cara menghitung overhead', [['per_unit', 'Per bungkus'], ['per_batch', 'Per sekali produksi']], g('metode_overhead', 'per_unit')) + '<p class="muted" id="oh-hint"></p><div id="oh-unit">' + field(['overhead_per_unit', 'Overhead per bungkus (Rp)', 'number'], s.overhead_per_unit) + '</div><div id="oh-batch">' + field(['overhead_per_batch', 'Overhead per sekali produksi (Rp)', 'number'], s.overhead_per_batch) + '</div>' + field(['target_margin', 'Target margin minimum (%)', 'number'], g('target_margin', 30)) + field(['kelipatan_harga', 'Pembulatan harga rekomendasi ke atas (Rp)', 'number'], g('kelipatan_harga', '500')) + field(['kategori_masuk_hpp', 'Kategori biaya yang SUDAH masuk HPP (pisahkan koma, mis. Listrik, Gas)'], s.kategori_masuk_hpp) + '<p class="muted">Biaya pada kategori ini tidak dipotong lagi dari laba bersih, supaya tidak terhitung dua kali.</p><button class="btn sec sm" data-act="ohsaran">Hitung saran overhead dari biaya bulan lalu</button><p class="muted" id="oh-saran"></p>') +
    '</div><div class="savebar"><button class="btn pri big" id="ssavebtn" data-act="ssave" disabled>Simpan pengaturan</button></div>';
  S.sSnap = setSnap(); S.dirty = false; sDepUpd();
}
async function sSave() {
  return busy('Menyimpan pengaturan…', async () => {
  const v = {}; document.querySelectorAll('#sf [data-f]').forEach(e => v[e.dataset.f] = e.type === 'checkbox' ? e.checked : e.value);
  ['opname_ambang_nilai', 'transfer_ambang_nilai', 'bayar_referensi_min'].forEach(k => { if (k in v) v[k] = String(v[k]).replace(/\D/g, ''); });   // angka bulat atau kosong (kosong = nonaktif)
  ['ppn_persen', 'overhead_per_unit', 'overhead_per_batch', 'target_margin', 'stok_menipis', 'diskon_maks_persen', 'kelipatan_harga'].forEach(k => { if (k in v) { const n = dnum(v[k]); v[k] = isNaN(n) ? 0 : n; } });
  try { await api('setting.setMany', {values: v}); S.dirty = false; await loadData(); render(); toast('Pengaturan tersimpan'); } catch (e) { toast(e.message); }
  });
}

/* ---------- Tutup kasir ---------- */
const KAS_CATS = ['Transport', 'Gas', 'Listrik', 'Air', 'Pemasaran', 'Lain-lain']; // kategori kas keluar laci (P0 F-05); server hanya mewajibkan terisi
async function vTutup() {
  const back = '<button class="chip" data-act="tab" data-t="menu">← Menu</button>';
  $('#main').innerHTML = back + '<div class="li" style="display:block;margin-top:8px"><b>Tutup kasir</b><p class="muted">Hitung uang tunai di laci lebih dulu, isi jumlahnya, lalu tutup. Rekap penjualan baru tampil setelah penutupan (hitung buta) agar selisihnya jujur.</p></div><div id="tbody">' + skel(3) + '</div>';
  const unsent = mineAll().length;
  if (unsent) { flush(); $('#tbody').innerHTML = '<div class="notice"><span>Masih ada ' + unsent + ' transaksi yang belum terkirim ke server. Kirim dulu agar rekap lengkap.</span><button class="chip" data-act="tab" data-t="tutup">Periksa lagi</button></div><button class="btn pri" data-act="qnow">Kirim sekarang</button>'; return; }
  await vload('shift.summary', {}, r => {
    if (S.tab !== 'tutup' || !$('#tbody')) return; const typed = ($('#tf') && $('#tf').value) || ($('#tn') && $('#tn').value) || ($('#tm') && $('#tm').value) || ($('#mn') && $('#mn').value); S.shift = r; if (typed) return; /* jangan menimpa isian yang sedang diketik */ const kv = (a, b) => '<div class="kv"><span>' + a + '</span><span>' + b + '</span></div>';
    S.shiftOpen = !!r.sesi; S.wajibBuka = r.wajib_buka !== false;
    if (!r.sesi) { // F4: modal awal ditetapkan saat BUKA kasir (sebelum ada penjualan), bukan diketik saat tutup
      $('#tbody').innerHTML = '<div class="li" style="display:block"><b>Kasir belum dibuka</b><p class="muted">Hitung uang modal di laci, isi jumlahnya, lalu buka kasir. Angka ini terkunci dan dipakai menghitung selisih saat tutup.</p></div>' +
        '<label>Modal awal laci (Rp)<input class="inp" id="tm" inputmode="numeric" placeholder="0"></label><button class="btn pri big" data-act="kopen">Buka kasir</button><div id="tlist"></div>'; tutupList(); return;
    }
    const mv = (r.gerakan || []).map(g => '<div class="kv"><span>' + (g.jenis === 'in' ? 'Kas masuk' : 'Kas keluar') + ' · ' + esc(g.alasan) + '</span><span>' + rp(g.nominal) + '</span></div>').join('');
    $('#tbody').innerHTML = '<div class="li" style="display:block">' + kv('Sejak', esc(String(r.dari).slice(0, 16))) + kv('Jumlah transaksi', num(r.jumlah_trx)) + kv('Modal awal', rp(r.modal_awal)) + mv + '</div>' +
      '<div class="li" style="display:block"><b>Kas masuk/keluar</b><p class="muted">Mis. beli es batu memakai uang laci. Catat SAAT terjadi, dengan alasan. Kas keluar otomatis tercatat sebagai biaya sesuai kategorinya.</p><div class="row2"><select class="inp" id="mj"><option value="out">Keluar</option><option value="in">Masuk</option></select><input class="inp" id="mn" inputmode="numeric" placeholder="Nominal"></div><select class="inp" id="mk"><option value="">Kategori biaya (wajib untuk kas keluar)</option>' + KAS_CATS.map(c => '<option>' + esc(c) + '</option>').join('') + '</select><input class="inp" id="ma" placeholder="Alasan (min. 3 huruf)"><button class="btn sec" data-act="kmove">Catat</button></div>' +
      '<label>Uang tunai di laci sekarang (Rp)<input class="inp" id="tf" inputmode="numeric" placeholder="Hitung dulu, lalu isi"></label><label>Catatan (opsional)<input class="inp" id="tn"></label><button class="btn pri big" data-act="tclose">Tutup kasir</button><div id="tlist"></div>';
    tutupList();
  }, {fail: e => { if ($('#tbody')) $('#tbody').innerHTML = '<p class="err">' + esc(e.message) + '</p>'; }});
}
async function tutupList() { await vload('shift.list', {}, L => { let el = $('#tlist'); if (!el && $('#tbody')) { el = document.createElement('div'); el.id = 'tlist'; $('#tbody').appendChild(el); } if (!el) return; const h = '<h3 style="margin:14px 0 6px">Penutupan terakhir</h3>' + (L.length ? L.slice(0, 10).map(x => '<div class="li" style="display:block"><div class="kv"><b>' + esc(x.kasir) + '</b><span>' + esc(String(x.sampai).slice(0, 16)) + '</span></div><div class="muted">' + num(x.jumlah_trx) + ' trx · total ' + rp(x.total_semua) + ' · tunai laci ' + rp(x.uang_fisik) + (own() ? ' · modal ' + rp(x.modal_awal) + (x.fisik_sebelumnya != null && Math.abs(Number(x.modal_awal) - x.fisik_sebelumnya) > 0.5 ? ' (sisa laci sebelumnya ' + rp(x.fisik_sebelumnya) + ')' : '') + (Number(x.kas_keluar) > 0 ? ' · kas keluar ' + rp(x.kas_keluar) : '') : '') + ' · selisih <b style="color:' + (Number(x.selisih_tunai) === 0 ? 'var(--ok)' : 'var(--err)') + '">' + rp(x.selisih_tunai) + '</b>' +
    (x.disetujui ? '<div><span class="tag">Ditinjau</span> ' + esc(x.disetujui_oleh || '') + (x.catatan_tinjau ? ' · ' + esc(x.catatan_tinjau) : '') + '</div>' : (Number(x.selisih_tunai) !== 0 && can('approve') && x.kasir_id !== S.data.user.uid ? '<button class="chip" data-act="shapp" data-id="' + esc(x.id) + '" data-d="' + esc(x.selisih_tunai) + '">Tandai ditinjau</button>' : '')) + '</div></div>').join('') : '<p class="muted">Belum ada.</p>'); el.innerHTML = h; }); }
async function tutupSimpan() {
  const v = dnum(($('#tf') || {}).value);
  if (isNaN(v) || v < 0 || ($('#tf') || {}).value === '') return toast('Isi jumlah uang tunai di laci');
  if (mineAll().length) return toast('Masih ada transaksi belum terkirim');
  return busy('Menutup kasir…', async () => { try { S.shiftOpen = false; const r = await api('shift.close', {uang_fisik: v, catatan: ($('#tn') || {}).value || ''}); const d = r.selisih_tunai, kv = (a, b) => '<div class="kv"><span>' + a + '</span><span>' + b + '</span></div>';
    $('#tbody').innerHTML = '<div class="okmark">' + svg('check', 30) + '</div><h2 class="c">Kasir ditutup</h2><div class="li" style="display:block">' + kv('Jumlah transaksi', num(r.jumlah_trx)) + kv('Tunai (setelah retur)', rp(r.tunai)) + kv('Transfer', rp(r.transfer)) + kv('QRIS', rp(r.qris)) + (r.lain ? kv('Lainnya', rp(r.lain)) : '') + (r.retur ? kv('Retur di shift ini', rp(r.retur)) : '') + kv('<b>Total</b>', '<b>' + rp(r.total) + '</b>') + '</div>' +
      '<div class="li" style="display:block">' + kv('Modal awal', rp(r.modal_awal)) + kv('Kas keluar', rp(r.kas_keluar)) + kv('Tunai seharusnya di laci', rp(r.tunai_diharapkan)) + kv('Uang di laci', rp(r.uang_fisik)) + '</div>' +
      '<div class="rc-sum"><div><small>Selisih tunai</small><b style="color:' + (d === 0 ? 'var(--ok)' : 'var(--err)') + '">' + (d > 0 ? '+' : '') + rp(d) + '</b></div></div><p class="muted c">' + (d === 0 ? 'Uang laci sesuai.' : d > 0 ? 'Uang laci lebih dari catatan.' : 'Uang laci kurang dari catatan.') + '</p><div id="tlist"></div>'; tutupList(); } catch (e) { toast(e.message); } });
}


async function kasOpen() {
  const m = dnum(($('#tm') || {}).value || '0'); if (isNaN(m) || m < 0) return toast('Modal awal harus berupa angka 0 atau lebih');
  return busy('Membuka kasir…', async () => { try { await api('shift.open', {modal_awal: m}); S.shiftOpen = true; toast('Kasir dibuka'); vTutup(); } catch (e) { toast(e.message); } });
}
async function kasMove() {
  const n = dnum(($('#mn') || {}).value), a = (($('#ma') || {}).value || '').trim(); if (!(n > 0)) return toast('Isi nominal lebih dari 0'); if (a.length < 3) return toast('Alasan wajib diisi');
  const j = ($('#mj') || {}).value, k = ($('#mk') || {}).value || ''; if (j === 'out' && !k) return toast('Pilih kategori biaya untuk kas keluar');
  S.kmRid = S.kmRid || ((window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2)); // kirim ulang setelah timeout memakai id yang sama (tidak menggandakan)
  return busy('Mencatat…', async () => { try { await api('cash.move', {jenis: j, nominal: n, alasan: a, kategori: j === 'out' ? k : undefined, request_id: S.kmRid}); S.kmRid = null; toast('Tercatat'); vTutup(); } catch (e) { if (e.server && !e.retry) S.kmRid = null; toast(e.message); } });
}
async function shiftCheck() { if (!S.token || !can('sell')) return; try { const r = await api('shift.summary', {}, {silent: true}); S.shiftOpen = !!r.sesi; S.wajibBuka = r.wajib_buka !== false; } catch (e) { /* abaikan: hanya untuk spanduk */ } }
const shiftNeeded = () => can('sell') && S.wajibBuka && S.shiftOpen === false;

/* F-17: supervisor/owner menandai selisih kas sudah ditinjau (catatan wajib bila ada selisih). */
async function shiftApprove(id, diff) {
  let note = ''; if (Number(diff) !== 0) { note = prompt('Catatan hasil tinjauan selisih Rp' + num(diff) + ' (min. 3 huruf):'); if (note === null) return; if (note.trim().length < 3) return toast('Catatan wajib diisi'); }
  return busy('Menyimpan…', async () => { try { await api('shift.approve', {id: id, catatan: note.trim()}); toast('Ditandai ditinjau'); tutupList(); } catch (e) { toast(e.message); } });
}
/* ---------- Retur (transaksi selesai tidak diubah; retur dicatat sebagai transaksi negatif) ---------- */
S.retRid = {};
async function returOpen(id) {
  if (!navigator.onLine) return toast('Retur butuh koneksi internet');
  let d; try { d = await api('sale.detail', {id: id}); } catch (e) { return toast(e.server ? e.message : 'Tidak bisa memuat transaksi (periksa koneksi)'); }
  const L = d.items.filter(x => x.sisa > 0); if (!L.length) return toast('Semua item transaksi ini sudah diretur');
  S.ret = {id: id, nomor: d.sale.nomor, lines: L};
  /* P0 (F-02): tiap item WAJIB memilih nasib barangnya. Tidak ada pilihan bawaan, supaya barang rusak tidak diam-diam menjadi stok jual. */
  sheet('<div class="grab"></div><h2>Retur ' + esc(d.sale.nomor) + '</h2><p class="muted">Isi jumlah yang dikembalikan pelanggan dan pilih kondisi barangnya. Barang yang kembali ke stok menambah stok jual; barang rusak/dibuang tidak menambah stok dan nilainya dicatat sebagai kerugian persediaan. Transaksi asal tidak diubah; retur tercatat sebagai transaksi baru bernilai minus.' + (can('approve') ? '' : ' Retur oleh kasir perlu PIN Owner/Supervisor.') + '</p>' +
    L.map(l => { const v = vById(l.variant_id); return '<label>' + esc(v ? (vName(v) + ' ' + vSub(v)).trim() : 'Produk dihapus') + ' <small class="muted">(bisa diretur ' + qf(l.sisa) + ')</small><input class="inp" type="number" min="0" max="' + l.sisa + '" step="any" inputmode="decimal" data-rv="' + esc(l.variant_id) + '" value="0"></label>' +
      '<label>Kondisi barang<select class="inp" data-rs="' + esc(l.variant_id) + '"><option value="">Pilih kondisi…</option><option value="ya">Baik, kembali ke stok</option><option value="tidak">Rusak / dibuang (tidak masuk stok)</option></select></label>'; }).join('') +
    '<button class="btn sec sm" data-act="retur_all">Retur semua sisa</button><label>Alasan retur (wajib)<input class="inp" id="ral" placeholder="mis. salah input, produk rusak, pelanggan batal"></label><div class="err" id="rerr"></div><button class="btn pri" data-act="retur_ok">Proses retur</button><button class="btn sec" data-act="close">Batal</button>');
}
async function returGo() {
  const R = S.ret; if (!R) return; const items = [], err = m => { const e = $('#rerr'); if (e) e.textContent = m; };
  let missing = false;
  document.querySelectorAll('#sheet [data-rv]').forEach(e => { const q = Number(/** @type {any} */ (e).value) || 0, l = R.lines.find(x => x.variant_id === dsOf(e).rv); if (q > 0 && l) { const sel = /** @type {any} */ (document.querySelector('#sheet [data-rs="' + dsOf(e).rv + '"]')), rs = sel ? sel.value : ''; if (rs !== 'ya' && rs !== 'tidak') missing = true; items.push({variant_id: l.variant_id, qty: q, max: l.sisa, harga: Number(l.harga) || 0, restock: rs === 'ya'}); } });
  if (!items.length) return err('Isi jumlah retur minimal satu item.'); if (items.some(x => x.qty > x.max + 1e-9)) return err('Jumlah melebihi sisa yang bisa diretur.');
  if (missing) return err('Pilih kondisi barang (kembali ke stok atau rusak/dibuang) untuk setiap item yang diretur.');
  const alasan = (($('#ral') || {}).value || '').trim(); if (alasan.length < 3) return err('Alasan retur wajib diisi.');
  const key = R.id + '|' + JSON.stringify(items.map(x => [x.variant_id, x.qty, x.restock])) + '|' + alasan; // permintaan yang sama memakai request_id yang sama, jadi kirim ulang tidak menggandakan retur
  const rid = S.retRid[key] || (S.retRid[key] = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
  /* P0 (F-03): kasir memakai TOKEN SENDIRI + id persetujuan sekali pakai (terikat transaksi asal dan nilai maksimum), jadi retur tercatat di laci kasir ini. */
  let tok = null; if (!can('approve')) { const nilai = Math.ceil(items.reduce((a, x) => a + x.harga * x.qty, 0)); tok = await askOwner('Retur ' + R.nomor + ': ' + alasan + '. Owner/Supervisor dapat menyetujui dengan PIN.', 'retur', rid, nilai, R.id); if (!tok) return; }
  try {
    const res = await api('sale.return', {request_id: rid, id: R.id, items: items.map(x => ({variant_id: x.variant_id, qty: x.qty, restock: x.restock})), alasan: alasan, override_token: tok});
    delete S.retRid[key]; closeSheet();
    Object.keys(res.stok || {}).forEach(id => { const v = vById(id); if (v) v.stok = r6(res.stok[id] - pendingQty(id)); }); LS.set('data', S.data);
    toast(res.duplicate || res.cached ? 'Retur ini sudah tercatat sebelumnya' : 'Retur tercatat. Kembalikan ' + rp(res.refund) + ' ke pelanggan (' + (res.metode || '') + ')' + (res.buang ? '. ' + res.buang + ' item rusak/dibuang, tidak masuk stok' : '')); if (S.tab === 'riwayat') vRiwayat();
  } catch (e) { if (e.auth) softLogout(); else toast(e.server ? e.message : 'Koneksi bermasalah. Ulangi retur yang sama; aman, tidak akan tercatat dua kali.'); }
}
/* ---------- Aksi (event delegation) ---------- */
function askReason(title, msg, okLabel) { // v1.9.9: pengganti prompt() bawaan browser; resolve(teks alasan) atau null bila dibatalkan
  return new Promise(res => {
    S.opin = {res: res, kind: 'alasan'}; S.qopen = false; // qopen=false: badge() tidak menimpa sheet ini dengan daftar antrean
    sheet('<div class="grab"></div><h2>' + esc(title) + '</h2><p class="muted">' + esc(msg) + '</p><label>Alasan<textarea class="inp ta" id="rsn" rows="3" maxlength="300"></textarea></label><div class="err" id="rerr" role="alert"></div><button class="btn dan" data-act="reason_ok">' + esc(okLabel || 'Lanjutkan') + '</button><button class="btn sec" data-act="close">Batal</button>');
    setTimeout(() => { const t = $('#rsn'); if (t) t.focus(); }, 60);
  });
}
const ACT = {
  login: doLogin, logout: confirmLogout, close: closeSheet, cart: cartSheet, pay: pay,
  hideout: el => { S.hideOut = !!el.checked; LS.set('hideOut', S.hideOut); grid(); }, showout: () => { S.hideOut = false; LS.set('hideOut', false); vKasir(); },
  rday: el => { const p = el.dataset.p; if (p === 'today') { S.day = today(); S.rcustom = false; } else if (p === 'yday') { S.day = addDays(today(), -1); S.rcustom = false; } else S.rcustom = true; vRiwayat(); },
  scat: el => { S.scat = el.dataset.c; vStok(); },
  install: async () => { const ev = S.installEv; if (!ev) return; try { ev.prompt(); await ev.userChoice; } catch (e) {} S.installEv = null; if (S.tab === 'menu') vMenu(); },
  tab: el => { S.tab = el.dataset.t; render(); },
  chan: el => { S.ch = el.dataset.c; LS.set('ch', S.ch); vKasir(); cartbar(); },
  cat: el => { S.cat = el.dataset.c; vKasir(); },
  add: el => { if (el.classList.contains('off')) { return toast(priceOf(el.dataset.v, S.ch) == null ? 'Harga belum diatur untuk channel ini' : 'Stok habis'); } addToCart(el.dataset.v); },
  inc1: el => addToCart(el.dataset.v), dec1: el => dropFromCart(el.dataset.v),
  inc: el => { const l = S.cart[el.dataset.i]; if (!l) return; const st = Number(vById(l.v).stok) || 0; if (T(cfg('blokir_stok_minus')) && l.qty + 1 > st) return toast('Stok tidak cukup'); l.qty++; saveCart(); cartLines(); addonsRender(); cashBox(); upd(); updCard(l.v); buzz(); },
  dec: el => { const l = S.cart[el.dataset.i]; if (!l) return; const id = l.v; l.qty--; if (l.qty <= 0) S.cart.splice(el.dataset.i, 1); saveCart(); if (!S.cart.length && !isWide()) closeSheet(); cartLines(); addonsRender(); cashBox(); upd(); updCard(id); },
  metode: el => { S.metode = el.dataset.m; LS.set('metode', S.metode); const c = $('#mchips'); if (c) c.innerHTML = methodChips(); cashBox(); upd(); },
  qk: el => { S.terima = el.dataset.n; cashBox(); upd(); },
  wa: () => waSend(S.rc, ($('#wa') || {}).value), rawbt: () => printBT(S.rc), print: () => printBrowser(), share: () => shareRc(S.rc), copyrc: () => copyText(receiptText(S.rc)),
  addonnew: () => { if (S.dirty) return toast('Simpan perubahan pengaturan dulu.'); addonSheet(); },
  addonsave: () => { const n = $('#ad_n').value.trim(), h = dnum($('#ad_h').value), c = dnum($('#ad_c').value), st = dnum($('#ad_s').value); if (!n) return toast('Isi nama produk tambahan'); if (!(h >= 0)) return toast('Harga jual tidak valid');
    return busy('Membuat produk tambahan…', async () => { try { await api('addon.create', {nama: n, harga: h, hpp: isNaN(c) ? 0 : c, stok: isNaN(st) ? 0 : st}); await loadData(); closeSheet(); render(); toast('Produk tambahan dibuat'); } catch (e) { toast(e.message); } }); },
  fotopick: () => { const f = $('#foto_file'); if (f) f.click(); }, fotodel: fotoDel, logopick: () => { if (S.dirty) return toast('Simpan perubahan pengaturan dulu.'); const f = $('#logo_file'); if (f) f.click(); }, logosave: logoSave, logodel: logoDel,
  rcpreview: () => { if (S.dirty) return toast('Simpan pengaturan dulu agar pratinjau sesuai.'); S.rc = testRc(); sheet('<div class="grab"></div><h2>Pratinjau struk</h2><p class="muted">Contoh transaksi uji, kertas ' + (rcWidth() === 48 ? '80' : '58') + ' mm.</p><pre class="rc" id="rtxt"></pre><div class="row2"><button class="btn dark" data-act="rawbt">Cetak Bluetooth</button><button class="btn sec" data-act="print">Cetak</button></div><button class="btn pri" data-act="close">Tutup</button>'); refreshRc(); },
  logotest: () => { if (!logoOn()) return toast('Aktifkan "Cetak logo di struk" dan simpan pengaturan dulu'); printBT(testRc()); },
  go_diag: () => { S.tab = 'diag'; render(); },
  opin_ok: opinOk,
  reason_ok: () => { const o = S.opin, v = (($('#rsn') || {}).value || '').trim(); if (!o || o.kind !== 'alasan') return; if (v.length < 3) { $('#rerr').textContent = 'Alasan wajib diisi (minimal 3 huruf).'; return; } S.opin = null; closeSheet(); o.res(v); },
  qauth: async el => { const q = S.queue[el.dataset.i]; if (!q) return; if (!/^Diskon/.test(q.error || '')) return toast('Hanya diskon yang bisa disetujui Owner. Perbarui data lalu Coba lagi, atau Hapus dengan alasan.'); const kind = 'diskon';   // F3: jalur 'selisih' dibuang (tidak berefek di server)
    const tok = await askOwner(q.error + ' Owner dapat menyetujui dengan PIN.', kind, q.rid, q.payload.diskon);
    if (!tok) return queueSheet(); q.payload.override = Object.assign({}, q.payload.override, {[kind]: tok}); q.status = 'pending'; q.state = 'waiting'; q.error = ''; q.alerted = false; LS.set('queue', S.queue); flush(); queueSheet(); },
  go_tutup: () => { S.tab = 'tutup'; render(); }, tclose: () => tutupSimpan(),
  queue: queueSheet, qnow: () => { flush(); setTimeout(() => { if (S.qopen) queueSheet(); }, 700); },
  btdirect: el => { LS.set('btdirect', !!el.checked); toast(el.checked ? 'Cetak langsung via BLE aktif' : 'Cetak lewat RawBT (Android)'); },
  btpick: async () => { try { await btConnect(true); toast('Printer dipilih: ' + (BT.dev.name || 'tanpa nama')); vDiag(); } catch (e) { toast(e && e.name === 'NotFoundError' ? 'Pemilihan printer dibatalkan' : 'Gagal: ' + (e.message || e)); } },
  skugen: el => { const f = {}; document.querySelectorAll('#sheet [data-f]').forEach(e => f[e.dataset.f] = e.value); if (!f.product_id) return toast('Pilih produk dulu'); const i = document.querySelector('#sheet [data-f=sku]'); if (i) i.value = genSkuLocal(f, el.dataset.id || ''); },
  dtwa: () => waSend(testRc(), ''), dtbt: () => printBT(testRc()), dtshare: () => shareRc(testRc()),
  dping: async () => { const el = $('#dres'); el.textContent = 'Menguji…'; const t0 = performance.now(); try { S.srvMs = undefined; await api('ping', {}, {silent: true}); const a = Math.round(performance.now() - t0), ms1 = S.srvMs; // lalu muat data penuh: ukuran dan waktu server untuk bootstrap (hasil dibuang)
      el.textContent = 'Ping: ' + a + ' ms' + (ms1 !== undefined ? ' (server ' + ms1 + ' ms)' : '') + '. Mengukur muat data…'; const t1 = performance.now(); S.srvMs = undefined; const b = await api('bootstrap', {}, {silent: true}); const bt = Math.round(performance.now() - t1), kb = Math.round(JSON.stringify(b).length / 1024);
      el.textContent = 'Ping: ' + a + ' ms' + (ms1 !== undefined ? ' (server ' + ms1 + ' ms)' : '') + ' · Muat data: ' + bt + ' ms' + (S.srvMs !== undefined ? ' (server ' + S.srvMs + ' ms)' : '') + ', ' + kb + ' KB. Bandingkan dengan sebelum/sesudah deploy.'; } catch (e) { el.textContent = 'Gagal: ' + e.message; logErr(e, 'ping'); } },
  dcopy: () => copyText(JSON.stringify({v: C.VERSION, ua: navigator.userAgent, online: navigator.onLine, queue: S.queue.length, penyimpanan: Store.mode(), err: LS.get('errlog', [])}, null, 1), 'Log disalin. Tempel untuk dikirim.'),
  dclear: () => { LS.set('errlog', []); vDiag(); toast('Catatan kesalahan dihapus'); },
  copyurl: () => copyText(location.href.split('#')[0], 'Alamat aplikasi disalin.'),
  qretry: el => { const q = S.queue[el.dataset.i]; if (q) { q.status = 'pending'; q.state = 'waiting'; q.error = ''; q.alerted = false; } LS.set('queue', S.queue); qrefresh(); flush(); },
  qaccept: el => { const q = S.queue[el.dataset.i]; if (!q) return; q.payload.terima_selisih = true; q.status = 'pending'; q.state = 'waiting'; q.error = ''; q.alerted = false; LS.set('queue', S.queue); qrefresh(); flush(); toast('Dikirim ulang dengan harga server; ditandai untuk ditinjau Owner'); },
  sreview: async el => { const note = await askReason('Tandai sudah ditinjau?', 'Tulis hasil peninjauan (mis. selisih harga dijelaskan, stok sudah di-opname). Angka transaksi tidak diubah.', 'Tandai ditinjau'); if (note === null) return;
    try { await api('sale.review', {id: el.dataset.id, catatan: note}); S.rhist = null; VC = {}; toast('Ditandai sudah ditinjau'); if (S.tab === 'riwayat') vRiwayat(); else if (S.tab === 'dash') render(); } catch (e) { toast(e.auth ? 'Sesi berakhir, masuk lagi' : e.message); } },
  qretryall: () => { S.queue.forEach(q => { if (q.status === 'review' && (q.uid === S.data.user.uid || q.by === S.data.user.uid) && !qinfo(q).auth) { q.status = 'pending'; q.state = 'waiting'; q.error = ''; q.alerted = false; } }); LS.set('queue', S.queue); qrefresh(); flush(); },
  more: el => { const k = el.dataset.k; if (!PGN[k]) return; LIM[k] = lim(k) + PGN[k]; // satu halaman lagi
    if (k === 'grid') grid(); else if (k === 'cart') cartLines(); else if (k === 'hist') { if (S.rcur && S.rcur.srv) { if (S.rmore) S.rmore(); } else if (S.rlist && S.rcur) S.rlist(S.rcur); }
    else if (k === 'q') { const sc = document.querySelector('#sheet .sheet'), top = sc ? sc.scrollTop : 0; queueSheet(); const n2 = document.querySelector('#sheet .sheet'); if (n2) n2.scrollTop = top; } }, // sheet digambar ulang: pertahankan posisi gulir
  qdel: async el => {
    const q = S.queue[el.dataset.i]; if (!q) return;
    if (!navigator.onLine) return toast('Hubungkan internet dulu: penghapusan dicatat ke server agar ada jejaknya');
    const fromQ = S.qopen, back = () => { if (fromQ) queueSheet(); }, alasan = await askReason('Hapus transaksi ' + rp(q.total) + '?', 'Alasan wajib dan dicatat di server. Tulis juga bila uang pelanggan sudah diterima.' + (can('approve') ? '' : ' Kasir memerlukan persetujuan PIN Owner/Supervisor.'), 'Hapus transaksi'); if (alasan === null) return back();
    let tok = null; if (!can('approve')) { tok = await askOwner('Hapus transaksi ' + rp(q.total) + ' dari antrean: ' + alasan.trim(), 'hapus', q.rid, q.total); if (!tok) return back(); }   // P0 (F-04): kasir tidak boleh membuang penjualan sendirian
    try { await api('sale.reject_log', {override_token: tok, aksi: 'hapus', nomor: q.nomor || '', galat: q.error || '', request_id: q.rid, total: q.total, metode: q.payload.metode_bayar, channel: q.ch, waktu: fmtDT(q.ts), error: q.error || '', alasan: alasan.trim(), items: q.payload.items.map(it => { const v = vById(it.variant_id); return {sku: v ? v.sku : it.variant_id, qty: it.qty}; })}); }
    catch (e) { back(); return toast(e.auth ? 'Sesi berakhir, masuk lagi' : e.server ? e.message : 'Tidak ada koneksi; coba lagi'); }
    const k = S.queue.indexOf(q); if (k < 0) return back(); S.queue.splice(k, 1); q.payload.items.forEach(it => { const v = vById(it.variant_id); if (v) v.stok = r6((Number(v.stok) || 0) + it.qty); }); LS.set('queue', S.queue); LS.set('data', S.data); badge(); if (fromQ) queueSheet(); else qrefresh(); toast('Dihapus dan dicatat di server');
  },
  retur: el => returOpen(el.dataset.id), retur_ok: () => returGo(),
  retur_all: () => { document.querySelectorAll('#sheet [data-rv]').forEach(e => { e.value = e.max; }); },
  ohsaran: async () => { const el = $('#oh-saran'); try { const r = await api('overhead.saran', {}); if (r.saran_per_unit == null) { if (el) el.textContent = r.pesan || 'Belum bisa dihitung.'; return; } if (el) el.textContent = 'Bulan ' + r.bulan + ': biaya ' + rp(r.biaya) + ' dibagi ' + num(r.unit) + ' unit = ' + rp(r.saran_per_unit) + ' per bungkus. Diisikan ke kolom di atas; tekan Simpan pengaturan.'; const f = document.querySelector('#sf [data-f="overhead_per_unit"]'), m = document.querySelector('#sf [data-f="metode_overhead"]'); if (m && m.value !== 'per_unit') { m.value = 'per_unit'; m.dispatchEvent(new Event('change', {bubbles: true})); } if (f) { f.value = r.saran_per_unit; f.dispatchEvent(new Event('input', {bubbles: true})); } } catch (e) { toast(e.message); } },
  stab: el => { S.stab = el.dataset.s; S.scat = 'Semua'; S.sq = ''; vStok(); },
  adj: el => adjSheet(el.dataset.t, el.dataset.id), adjsave: el => adjSave(el.dataset.t, el.dataset.id),
  pbopen: pbSheet, pbdel: el => { S.pb.items.splice(el.dataset.i, 1); pbSheet(); }, pbsave: pbSave,
  pbadd: () => { const q = dnum($('#pb_q').value), h = dnum($('#pb_h').value), id = $('#pb_m').value; if (!id || !(q > 0) || !(h >= 0) || $('#pb_h').value === '') return toast('Isi jumlah dan harga'); S.pb.items.push({id: id, qty: q, harga: h}); pbSheet(); },
  go_master: () => { S.tab = 'master'; render(); }, go_riwayat: () => { S.tab = 'riwayat'; render(); }, go_laporan: () => { S.tab = 'laporan'; render(); }, go_shopee: () => { S.tab = 'shopee'; render(); }, go_resep: () => { S.tab = 'resep'; render(); }, go_cek: () => { S.tab = 'cek'; render(); }, go_users: () => { S.tab = 'users'; render(); }, go_settings: () => { S.tab = 'settings'; render(); },
  expvoid: el => { const why = vOf('xv_r').trim(); if (why.length < 3) return toast('Alasan pembatalan wajib diisi');
    return busy('Membatalkan…', async () => { try { await api('expense.void', {id: dsOf(el).id, alasan: why}); S.expLoaded = false; closeSheet(); loadExp(); toast('Biaya dibatalkan'); } catch (e) { toast(e.message); } }); },
  pbhist: () => pbHist(), pbcancel: el => pbCancel(dsOf(el).id), shapp: el => shiftApprove(dsOf(el).id, dsOf(el).d),
  plock: () => { const d = vOf('pl_d'), r = vOf('pl_r').trim(); if (r.length < 3) return toast('Alasan wajib diisi');
    if (!confirm(d ? 'Kunci semua periode sampai ' + d + '? Biaya/impor pada tanggal itu dan sebelumnya akan ditolak.' : 'Buka semua kunci periode?')) return;
    return busy('Menyimpan…', async () => { try { await api('period.lock', {sampai: d, alasan: r}); await loadData(); render(); toast('Kunci periode disimpan'); } catch (e) { toast(e.message); } }); },
  mt: el => { S.mt = el.dataset.k; vMaster(); }, medit: el => meditSheet(el.dataset.id), msave: el => mSave(el.dataset.id), mdel: el => mDel(el.dataset.id),
  uunlock: async el => { try { await api('user.unlock', {id: el.dataset.id}); closeSheet(); vUsers(); toast('Kunci akun dibuka'); } catch (e) { toast(e.message); } }, uedit: el => ueditSheet(el.dataset.id), usave: el => uSave(el.dataset.id), ssave: sSave,
  sync: () => busy('Memperbarui data…', async () => { try {
    if (own()) { await api('sistem.refresh', {}); await loadData(); lastChk = Date.now(); render(); await flush(); toast('Data diperbarui'); } // Owner: muat ulang penuh dan bersihkan cache server (setelah mengedit spreadsheet langsung)
    else { const r = await verSync(0); if (r === null) throw new Error('Tidak ada koneksi ke server'); if (r) redrawFor(r); await flush(); toast(r ? 'Data diperbarui' : 'Sudah yang terbaru'); } // Kasir: hanya memuat bila ada data baru
  } catch (e) { if (e.auth) softLogout(); else toast('Gagal memperbarui: ' + e.message); } })
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'), a = el && el.dataset.act; if (!el || !ACT[a]) return;
  if (S.dirty && S.tab === 'settings' && (a === 'tab' || a === 'logout' || a === 'sync' || /^go_/.test(a))) { if (!confirm('Perubahan pengaturan belum disimpan. Keluar tanpa menyimpan?')) return; S.dirty = false; }
  ACT[a](el);
});
document.addEventListener('input', e => { if (S.tab === 'settings' && e.target.closest && e.target.closest('#sf')) sDirty(); });
document.addEventListener('change', e => { const t0 = /** @type {HTMLSelectElement} */ (e.target); if (t0 && t0.dataset && t0.dataset.f === 'role' && t0.closest && t0.closest('#sheet')) { const ri = $('#role-info'); if (ri) ri.textContent = ROLE_INFO[t0.value] || 'Pilih peran untuk melihat hak aksesnya.'; const pl = $('#pin-lbl'); if (pl && pl.firstChild) pl.firstChild.textContent = credLabel(t0.value, (($('[data-act="usave"]') || {dataset: {}}).dataset || {}).id); return; } if (e.target.id === 'foto_file') { const f = e.target.files && e.target.files[0]; e.target.value = ''; fotoLoad(f); return; } if (e.target.id === 'logo_file') { const f = e.target.files && e.target.files[0]; e.target.value = ''; logoLoad(f); return; } if (S.tab === 'settings' && e.target.closest && e.target.closest('#sf')) sDirty(); });
document.addEventListener('input', e => { if (e.target.dataset && e.target.dataset.lg) logoEdit(e.target); });
window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installEv = e; if (S.tab === 'menu' && S.data) vMenu(); });
window.addEventListener('appinstalled', () => { S.installEv = null; if (S.tab === 'menu' && S.data) vMenu(); });
{ let rzT = 0; window.addEventListener('resize', () => { cancelAnimationFrame(rzT); rzT = requestAnimationFrame(initFades); }); }
document.addEventListener('input', e => {
  const k = e.target.dataset && e.target.dataset.in; if (!k) return; let v = e.target.value;
  if (k === 'q') { S.q = v; clearTimeout(S.qT); S.qT = setTimeout(() => { if ($('#grid')) grid(); }, 90); return; } // v1.9.9: gabungkan ketikan beruntun menjadi satu penggambaran
  if (k === 'sq') { S.sq = v; return stokList(); }
  if (k === 'pbsup') { S.pb.sup = v; return; }
  if (k === 'pbongkir') { S.pb.ongkir = v.replace(/\D/g, ''); return; }
  if (k === 'catatan') { S.catatan = v; return; }
  if (k === 'ref') { S.ref = v; return; }
  if (k === 'diskon' || k === 'terima') { v = v.replace(/\D/g, ''); S[k] = v; return upd(); }
});
document.addEventListener('change', e => { if (e.target.dataset && e.target.dataset.chg === 'day') { S.day = e.target.value; vRiwayat(); } });
document.addEventListener('keydown', e => { const t = /** @type {HTMLElement} */ (e.target); if ((e.key === 'Enter' || e.key === ' ') && t && t.matches && t.matches('[role="button"][data-act]:not(button)')) { e.preventDefault(); t.click(); return; } /* kartu produk berperan tombol: sebelumnya hanya bisa diketuk/diklik, tidak bisa lewat keyboard */ if (e.key === 'Tab') trapTab(e); if (e.key === 'Escape' && $('#sheet') && !$('#sheet').hidden && (!S.opin || S.opin.kind === 'alasan') && !S.busyOn) { closeSheet(); return; } if (e.key === 'Enter' && $('#lp') && document.activeElement === $('#lp')) doLogin(); });

/* ---------- Multi-outlet (v2.1.0): pilih outlet aktif dan administrasi outlet. Aktif hanya pada backend Supabase (S.data.outlets ada). ---------- */
const multiOutlet = () => !!(S.data && S.data.outlets);
const outletName = () => S.data && S.data.outlet ? S.data.outlet.code + ' · ' + S.data.outlet.name : '';
const pickable = () => (S.data.outlets || []).filter(o => o.status === 'active');
function outletLabel() {
  if (!multiOutlet() || !S.data.outlet) return '<small>Jajanan Cemilan Pedas</small>';
  const many = pickable().length > 1;
  return '<small>' + esc(outletName()) + '</small>' + (many ? '<button class="linkbtn" data-act="outlet" aria-label="Ganti outlet aktif">Ganti outlet</button>' : '');
}
function outletSheet() {
  sheet('<h2>Pilih outlet</h2><p class="muted">Data stok, penjualan, dan kas mengikuti outlet yang dipilih.</p>' + pickable().map(o => '<button class="li" style="width:100%;border:0;font:inherit;text-align:left;margin-top:8px" data-act="outpick" data-id="' + esc(o.id) + '"><span><b>' + esc(o.code) + '</b> ' + esc(o.name) + ' <span class="muted">' + (o.kind === 'kitchen' ? 'Dapur' : 'Toko') + '</span></span>' + (S.data.outlet && o.id === S.data.outlet.id ? '<span class="badge ok">Aktif</span>' : '<span class="muted">Pilih</span>') + '</button>').join('') + '<button class="btn sec" data-act="close">Tutup</button>');
}
async function outletPick(id) {
  if (S.data.outlet && id === S.data.outlet.id) return closeSheet();
  if (S.cart.length && !confirm('Keranjang berisi ' + S.cart.length + ' item dan akan dikosongkan karena pindah outlet. Lanjutkan?')) return;
  await busy('Memuat outlet…', async () => {
    try {
      await api('outlet.use', {id: id}); S.cart = []; LS.set('cart', []); S.rhist = null; VC = {}; S.users = null; S.expLoaded = false;
      await loadData(); closeSheet(); S.tab = homeTab(); render(); toast('Outlet aktif: ' + outletName());
    } catch (e) { toast(e.message); }
  });
}
function vOutlets() {
  const rows = S.data.outlets || [], st = {active: 'Aktif', inactive: 'Nonaktif', closed: 'Ditutup'};
  $('#main').innerHTML = '<button class="chip" data-act="tab" data-t="menu">← Menu</button><p class="muted">' + rows.filter(o => o.status === 'active').length + ' outlet aktif</p><button class="btn pri" data-act="oedit" data-id="">+ Tambah outlet</button>' +
    rows.map(o => '<button class="li" style="width:100%;border:0;font:inherit;text-align:left;margin-top:8px" data-act="oedit" data-id="' + esc(o.id) + '"><span><b>' + esc(o.code) + '</b> ' + esc(o.name) + '<br><span class="muted">' + (o.kind === 'kitchen' ? 'Dapur/gudang produksi' : 'Toko') + (o.address ? ' · ' + esc(o.address) : '') + '</span></span><span class="badge ' + (o.status === 'active' ? 'ok' : 'off') + '">' + st[o.status] + '</span></button>').join('');
}
async function oeditSheet(id) {
  const o = id ? S.data.outlets.find(x => x.id === id) : {kind: 'store', status: 'active'};
  sheet('<h2>' + (id ? 'Ubah' : 'Tambah') + ' outlet</h2>' + (id ? '<p class="muted">Kode ' + esc(o.code) + ' tidak dapat diubah.</p>' : field(['code', 'Kode outlet (contoh OUT-002)'], '') + selF('kind', 'Jenis', [['store', 'Toko (menjual)'], ['kitchen', 'Dapur/gudang produksi']], o.kind)) +
    field(['name', 'Nama outlet'], o.name) + field(['address', 'Alamat'], o.address) + selF('status', 'Status', [['active', 'Aktif'], ['inactive', 'Nonaktif'], ['closed', 'Ditutup']], o.status) +
    (id ? '<div id="omem"><p class="muted">Memuat pengguna…</p></div>' : '<p class="muted">Setelah dibuat: tetapkan pengguna dan isi stok awal lewat Stok → Penyesuaian (saldo pembukaan).</p>') +
    '<button class="btn pri" data-act="osave" data-id="' + esc(id) + '">Simpan</button>');
  if (id) try {
    const m = await api('member.list', {outlet_id: id}, {silent: true}); const el = $('#omem'); if (!el) return;
    el.innerHTML = '<h3>Pengguna di outlet ini</h3>' + (m.length ? m.map(x => '<div class="li"><span>' + esc(x.nama) + ' <span class="muted">@' + esc(x.username) + ' · ' + esc(x.role) + (x.status !== 'active' ? ' · nonaktif' : '') + '</span></span></div>').join('') : '<p class="muted">Belum ada.</p>') +
      '<p class="muted">Tambah/ubah akses pengguna di Menu → Pengguna (role kasir mengikuti outlet aktif).</p>';
  } catch (e) { const el = $('#omem'); if (el) el.innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; }
}
async function oSave(id) {
  return busy('Menyimpan outlet…', async () => {
    const d = readForm(); if (id) d.id = id;
    try { await api(id ? 'outlet.update' : 'outlet.create', d); await loadData(); closeSheet(); render(); toast(id ? 'Outlet diperbarui' : 'Outlet dibuat'); } catch (e) { toast(e.message); }
  });
}
MENU_TABS.push('outlets'); APP.views.outlets = vOutlets;
Object.assign(ACT, {outlet: outletSheet, outpick: el => outletPick(el.dataset.id), go_outlets: () => { S.tab = 'outlets'; render(); }, oedit: el => oeditSheet(el.dataset.id), osave: el => oSave(el.dataset.id)});
/* ---------- Transfer stok antar outlet (F2). Alur server: draft -> submitted -> approved -> sent -> received (atau rejected/cancelled). ---------- */
const TR_ST = {draft: 'Draft', submitted: 'Diajukan', approved: 'Disetujui', sent: 'Dalam perjalanan', received: 'Diterima', rejected: 'Ditolak', cancelled: 'Dibatalkan'};
const TR_TAG = {received: 'grn', rejected: 'red', cancelled: 'red'};
const trOutletName = id => { const o = (S.data.outlets || []).find(x => x.id === id); return o ? o.code + ' · ' + o.name : '(outlet)'; };
const trItemName = it => {
  if (it.tipe === 'variant') { const v = vById(it.item_id); return v ? vName(v) + ' ' + vSub(v) : '(produk)'; }
  const m = (S.data.materials || []).find(x => x.id === it.item_id); return m ? m.nama : '(bahan)';
};
const trUnit = it => it.tipe === 'variant' ? 'pcs' : ((S.data.materials || []).find(x => x.id === it.item_id) || {}).satuan || '';
async function vTransfer() {
  $('#main').innerHTML = '<button class="chip" data-act="tab" data-t="menu">← Menu</button><button class="btn pri" data-act="trnew">+ Transfer baru</button><div id="trl">' + skel(3) + '</div>';
  await vload('transfer.list', undefined, L => { S.trs = L; trDraw(); }, {fail: e => { if ($('#trl')) $('#trl').innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; }});
}
function trDraw() {
  const el = $('#trl'); if (!el) return; const me = S.data.outlet && S.data.outlet.id;
  el.innerHTML = (S.trs || []).map(t => '<button class="li" style="width:100%;border:0;font:inherit;text-align:left;margin-top:8px" data-act="trdetail" data-id="' + esc(t.id) + '"><span><b>' + esc(t.nomor) + '</b><div class="muted">' + (t.dari_id === me ? 'Ke ' + esc(trOutletName(t.ke_id)) : 'Dari ' + esc(trOutletName(t.dari_id))) + ' · ' + t.items.length + ' item</div></span><span class="tag ' + (TR_TAG[t.status] || '') + '">' + esc(TR_ST[t.status] || t.status) + '</span></button>').join('') ||
    emptyState('stok', 'Belum ada transfer', 'Kirim stok produk jadi atau bahan ke outlet lain. Stok asal berkurang saat dikirim, stok tujuan bertambah saat diterima.', '');
}
function trNewSheet() {
  const others = pickable().filter(o => o.id !== S.data.outlet.id);
  if (!others.length) return toast('Belum ada outlet aktif lain sebagai tujuan');
  S.trf = {to: others[0].id, kind: 'variant', item: '', qty: '', items: [], catatan: ''};
  trNewDraw();
}
function trNewDraw() {
  const f = S.trf, others = pickable().filter(o => o.id !== S.data.outlet.id), pool = f.kind === 'variant' ? S.data.variants.map(v => [v.id, vName(v) + ' ' + vSub(v) + ' (stok ' + qf(v.stok) + ')']) : (S.data.materials || []).map(m => [m.id, m.nama + ' (stok ' + qf(m.stok) + ' ' + m.satuan + ')']);
  if (!pool.some(x => x[0] === f.item)) f.item = pool[0] ? pool[0][0] : '';
  sheet('<h2>Transfer baru</h2><p class="muted">Dari ' + esc(outletName()) + '</p><label>Tujuan<select class="inp" data-tf="to">' + others.map(o => '<option value="' + esc(o.id) + '"' + (o.id === f.to ? ' selected' : '') + '>' + esc(o.code + ' · ' + o.name) + '</option>').join('') + '</select></label>' +
    '<div class="chips"><button class="chip ' + (f.kind === 'variant' ? 'on' : '') + '" data-act="trkind" data-k="variant">Produk jadi</button>' + (S.data.materials ? '<button class="chip ' + (f.kind === 'material' ? 'on' : '') + '" data-act="trkind" data-k="material">Bahan</button>' : '') + '</div>' +
    '<label>Item<select class="inp" data-tf="item">' + pool.map(x => '<option value="' + esc(x[0]) + '"' + (x[0] === f.item ? ' selected' : '') + '>' + esc(x[1]) + '</option>').join('') + '</select></label><div class="row2"><input class="inp" data-tf="qty" inputmode="decimal" placeholder="Jumlah" value="' + esc(f.qty) + '"><button class="btn sec" data-act="tradd">Tambah</button></div>' +
    f.items.map((x, i) => '<div class="kv"><span>' + esc(trItemName({tipe: x.item_type, item_id: x.item_id})) + '</span><span>' + qf(x.qty) + ' <button class="chip" data-act="trdel" data-i="' + i + '">Hapus</button></span></div>').join('') +
    '<label>Catatan<input class="inp" data-tf="catatan" value="' + esc(f.catatan) + '"></label><button class="btn pri" data-act="trsave" data-aj="1">Buat dan ajukan</button><button class="btn sec" data-act="trsave" data-aj="0">Simpan sebagai draft</button>');
}
function trDetail(id) {
  const t = (S.trs || []).find(x => x.id === id); if (!t) return; const me = S.data.outlet.id, mine = t.dari_id === me, dest = t.ke_id === me, st = t.status;
  const btn = (a, l, cl) => '<button class="btn ' + (cl || 'pri') + '" data-act="tract" data-id="' + esc(id) + '" data-a="' + a + '">' + l + '</button>';
  let acts = '';
  if (mine && st === 'draft' && can('transfer')) acts += btn('submit', 'Ajukan');
  if (mine && st === 'submitted' && can('approve')) acts += btn('approve', 'Setujui') + btn('reject', 'Tolak', 'dan');
  if (mine && (st === 'approved' || st === 'submitted') && can('transfer')) acts += btn('send', 'Kirim sekarang');
  if (dest && st === 'sent' && can('transfer')) acts += btn('receive', 'Terima barang');
  if ((mine || (dest && st === 'sent')) && ['draft', 'submitted', 'approved', 'sent'].indexOf(st) >= 0 && can('transfer') && (st !== 'sent' || can('approve'))) acts += btn('cancel', st === 'sent' ? 'Batalkan dan kembalikan ke asal' : 'Batalkan', 'dan');
  const recv = dest && st === 'sent';
  sheet('<h2>' + esc(t.nomor) + '</h2><p class="muted">' + esc(trOutletName(t.dari_id)) + ' → ' + esc(trOutletName(t.ke_id)) + ' · ' + esc(TR_ST[st] || st) + (t.catatan ? ' · ' + esc(t.catatan) : '') + '</p>' +
    '<div class="li" style="display:block">' + t.items.map((it, i) => '<div class="kv"><span>' + esc(trItemName(it)) + '</span><span>' + (recv ? '<input class="inp" style="width:90px" data-rc="' + i + '" inputmode="decimal" value="' + esc(it.dikirim) + '"> ' : (it.diterima != null ? qf(it.diterima) + ' / ' : '') + qf(it.dikirim != null ? it.dikirim : it.diminta) + ' ') + esc(trUnit(it)) + (it.selisih ? ' <span class="tag red">selisih ' + qf(it.selisih) + '</span>' : '') + '</span></div>').join('') + '</div>' +
    (recv ? '<p class="muted">Isi jumlah yang benar-benar diterima. Selisih dicatat di audit.</p>' : '') + acts + '<button class="btn sec" data-act="close">Tutup</button>');
}
async function trAct(id, a) {
  const t = (S.trs || []).find(x => x.id === id); if (!t) return; const p = {id: id, action: a};
  if (a === 'receive') { p.items = t.items.map((it, i) => { const el = document.querySelector('[data-rc="' + i + '"]'); return {item_type: it.tipe, item_id: it.item_id, qty_received: dnum(el ? el.value : it.dikirim)}; }); if (p.items.some(x => isNaN(x.qty_received))) return toast('Jumlah diterima tidak valid'); }
  if (['reject', 'cancel'].indexOf(a) >= 0 && !confirm(a === 'reject' ? 'Tolak transfer ini?' : 'Batalkan transfer ini?')) return;
  return busy('Memproses…', async () => { try { await api('transfer.action', p); await loadData(); closeSheet(); vTransfer(); toast('Transfer diperbarui'); } catch (e) { toast(e.message); } });
}
async function trSave(aj) {
  const f = S.trf; if (!f.items.length) return toast('Tambahkan minimal satu item');
  return busy('Menyimpan transfer…', async () => { try { await api('transfer.create', {from_outlet_id: S.data.outlet.id, to_outlet_id: f.to, items: f.items, catatan: f.catatan, ajukan: aj}); closeSheet(); vTransfer(); toast(aj ? 'Transfer diajukan' : 'Draft tersimpan'); } catch (e) { toast(e.message); } });
}
document.addEventListener('input', e => { const k = e.target && e.target.dataset && e.target.dataset.tf; if (k && S.trf) S.trf[k] = e.target.value; });
document.addEventListener('change', e => { const k = e.target && e.target.dataset && e.target.dataset.tf; if (k && S.trf) { S.trf[k] = e.target.value; } });
APP.views.transfer = vTransfer;
Object.assign(ACT, {
  go_transfer: () => { S.tab = 'transfer'; render(); }, trnew: trNewSheet, trdetail: el => trDetail(el.dataset.id), tract: el => trAct(el.dataset.id, el.dataset.a),
  trkind: el => { S.trf.kind = el.dataset.k; S.trf.item = ''; trNewDraw(); },
  tradd: () => { const f = S.trf, q = dnum(f.qty); if (!f.item || !(q > 0)) return toast('Pilih item dan isi jumlah > 0'); const ex = f.items.find(x => x.item_id === f.item && x.item_type === f.kind); if (ex) ex.qty = r6(ex.qty + q); else f.items.push({item_type: f.kind, item_id: f.item, qty: q}); f.qty = ''; trNewDraw(); },
  trdel: el => { S.trf.items.splice(Number(el.dataset.i), 1); trNewDraw(); }, trsave: el => trSave(el.dataset.aj === '1'),
  kopen: kasOpen, kmove: kasMove,
});
/* ---------- Mulai ---------- */
let swReg = null;
function updBanner() { const b = $('#upd'); b.hidden = false; b.innerHTML = 'Versi baru tersedia <button data-act="reload">Muat ulang</button>'; }
if ('serviceWorker' in navigator) {
  const had = !!navigator.serviceWorker.controller; let rl = false;
  navigator.serviceWorker.register('sw.js', {updateViaCache: 'none'}).then(reg => {
    swReg = reg; if (reg.waiting && had) updBanner();
    reg.addEventListener('updatefound', () => { const nw = reg.installing; if (nw) nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) updBanner(); }); });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had && !rl) { rl = true; reloadWhenIdle(); } });
}
/* v1.9.8: pembaruan tidak boleh memutus sesi kasir. Pemuatan ulang (mis. akibat tab lain menekan "Muat ulang") menunggu sampai tidak ada layar terbuka, permintaan berjalan,
   atau pengiriman antrean; keranjang dan antrean sudah tersimpan di perangkat sehingga tetap utuh setelah dimuat ulang. */
const idleNow = () => $('#sheet').hidden && !S.busyOn && !flushing && !S.dirty && pending === 0;
let rlT = null;
function reloadWhenIdle() {
  clearTimeout(rlT);
  if (!(S.token && S.data) || idleNow()) { Promise.resolve(Store.flush()).catch(() => {}).then(() => location.reload()); return; }
  const b = $('#upd'); b.hidden = false; b.textContent = 'Versi baru siap. Aplikasi dimuat ulang otomatis setelah layar yang sedang terbuka selesai.';
  rlT = setTimeout(reloadWhenIdle, 1500);
}
ACT.reload = () => { if (S.token && S.data && !idleNow()) return toast('Selesaikan dulu layar yang sedang terbuka, lalu tekan Muat ulang lagi'); if (swReg && swReg.waiting) swReg.waiting.postMessage({type: 'SKIP_WAITING'}); else location.reload(); };
window.addEventListener('online', () => { badge(); flush(); checkUpdates(true); });
window.addEventListener('offline', badge);
document.addEventListener('visibilitychange', () => { if (document.hidden) Store.flush(); if (!document.hidden) { checkUpdates(); flush(); if (swReg) swReg.update().catch(() => {}); } });
async function start() {
  await Store.init();
  S.token = LS.get('token', null); S.data = LS.get('data', null); S.queue = LS.get('queue', []); S.queue.forEach(q => { const o = q.payload && q.payload.override; if (o && typeof o.diskon === 'string' && o.diskon.indexOf('sbov:') === 0) delete q.payload.override; }); /* P1-4/P1-5: token approver (JWT) dari versi lama tidak boleh tetap tersimpan */ S.ch = LS.get('ch', null); S.cart = LS.get('cart', []); S.metode = LS.get('metode', 'tunai'); S.lastSync = LS.get('lastsync', 0) || null; S.hideOut = !!LS.get('hideOut', false);
  if (S.token && S.data) { S.tab = homeTab(); render(); shiftCheck().then(() => { if (S.tab === 'kasir') render(); }); checkUpdates(true); flush(); setTimeout(notifyConflicts, 1200); } else renderLogin(); // transaksi "perlu ditinjau" dari sesi sebelumnya langsung diingatkan
}
window.addEventListener('pagehide', () => Store.flush());
if (window.MutationObserver) new MutationObserver(ms => { if (ms.every(m => { const t = /** @type {any} */ (m.target); return t.closest && t.closest('#grid,#cl,#cartbar,#tot,#addons'); })) return; /* v1.9.9: tap produk tidak lagi memaksa pengukuran tata letak */ cancelAnimationFrame(S.fr); S.fr = requestAnimationFrame(initFades); }).observe(document.getElementById('app'), {childList: true, subtree: true});
if (window.matchMedia) { const mq = matchMedia('(min-width: 768px)'); (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(() => { if (S.token && S.data && $('#sheet').hidden && !S.dirty) render(); }); }
Object.assign(APP.views, {tutup: vTutup, kasir: vKasir, riwayat: vRiwayat, stok: vStok, menu: vMenu, master: vMaster, users: vUsers, settings: vSettings, diag: vDiag});
Object.assign(APP, {can: can, own: own, S: S, api: api, $: $, rp: rp, num: num, esc: esc, LS: LS, T: T, sheet: sheet, closeSheet: closeSheet, toast: toast, busy: busy, busyLabel: busyLabel, skel: skel, ACT: ACT,
  render: render, loadData: loadData, patchRecipe: patchRecipe, patchMaster: patchMaster, checkUpdates: checkUpdates, verSync: verSync, dverKey: dverKey, vload: vload, dnum: dnum, qf: qf, r6: r6, flush: flush, Store: Store, isWide: isWide, skuLevel: skuLevel, wrapChips: wrapChips, isAddon: isAddon, emptyState: emptyState, idDate: idDate, idRange: idRange, addDays: addDays, lvText: lvText, vById: vById, pById: pById, vName: vName, vSub: vSub, chName: chName, fmtDT: fmtDT, today: today, start: start});
})();
