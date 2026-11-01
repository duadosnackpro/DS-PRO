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
    set: (k, v, now) => { mem[k] = v; if (idb) { if (CRIT.indexOf(k) >= 0) journal(k, {v: v}); dirty[k] = 1; if (now) flushNow(); else { clearTimeout(timer); timer = setTimeout(flushNow, 400); } } else { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { fail('Penyimpanan perangkat penuh'); } } },
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
const TAB_CAP = {reset: 'takeover', dash: 'dash', kasir: 'sell', tutup: 'sell', riwayat: 'history', produksi: 'produce', laporan: 'report', transfer: 'transfer'};
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
/* P1 (UX-01, UX-19): galat tidak boleh hilang sendiri. toast() hanya untuk kabar baik dan info singkat. Pesan bahwa sebuah aksi GAGAL atau DITOLAK memakai fail():
   - tanpa `field`: kotak role="alert" dengan tombol Tutup, bertahan sampai ditutup. Di dalam sheet bila sheet terbuka (terjangkau keyboard, tidak melanggar jebakan fokus), selain itu di spanduk #errbar.
   - dengan `field` (selector kolom): pesan di bawah kolom, kolom diberi aria-invalid + aria-describedby lalu difokuskan; hilang saat kolom diubah. Satu galat tampil pada satu waktu. */
let failSeq = 0;
function failClear() {
  S.err = null;
  document.querySelectorAll('.errbox,.ferr').forEach(x => x.remove());
  document.querySelectorAll('[aria-invalid="true"]').forEach(x => { x.removeAttribute('aria-invalid'); if (/^fe\d+$/.test(x.getAttribute('aria-describedby') || '')) x.removeAttribute('aria-describedby'); });
}
function failBox() { // (re)pasang kotak galat dari S.err: di sheet yang terbuka, atau di #errbar
  if (!S.err) return;
  const sh = $('#sheet'), d = sh && !sh.hidden ? sh.querySelector('.sheet') : null, bar = $('#errbar');
  document.querySelectorAll('.errbox').forEach(x => x.remove());
  const box = document.createElement('div'); box.className = 'errbox'; box.setAttribute('role', 'alert');
  box.innerHTML = '<span class="et">' + esc(S.err) + '</span><button type="button" class="chip" data-act="errx">Tutup</button>';
  if (d) { const h = d.querySelector('h2'); d.insertBefore(box, h ? h.nextSibling : d.firstChild); } else if (bar) bar.appendChild(box);
}
function fail(m, field) {
  clearTimeout(/** @type {any} */ (toast).t); const t = $('#toast'); if (t) t.className = ''; // galat menggantikan toast info yang sedang tampil
  m = String(m == null ? '' : m).trim() || 'Terjadi kesalahan. Coba lagi.'; // pesan kosong tidak boleh menjadi kotak kosong
  const el = field ? /** @type {HTMLElement|null} */ (document.querySelector(field)) : null;
  failClear();
  if (!el || !el.isConnected) { S.err = m; failBox(); return; }
  const host = el.closest('label') || el, par = host.parentElement, at = par && par.classList.contains('row2') ? par : host; // pesan di luar <label> agar tidak ikut menjadi nama kolom
  const p = document.createElement('div'); p.className = 'ferr'; p.id = 'fe' + (++failSeq); p.setAttribute('role', 'alert'); p.textContent = m;
  at.insertAdjacentElement('afterend', p);
  el.setAttribute('aria-invalid', 'true'); el.setAttribute('aria-describedby', p.id);
  try { el.focus(); el.scrollIntoView({block: 'nearest'}); } catch (e) { /* kolom tak bisa difokuskan: pesan tetap tampil */ }
}
/* A: selama sheet terbuka, halaman di belakangnya tidak boleh terbaca pembaca layar maupun terjangkau Tab/ketuk (inert + aria-hidden). */
function bgInert(on) { ['app', 'upd'].forEach(id => { const e = document.getElementById(id); if (!e) return; if (on) { e.setAttribute('inert', ''); e.setAttribute('aria-hidden', 'true'); } else { e.removeAttribute('inert'); e.removeAttribute('aria-hidden'); } }); }
function sheet(html) {
  const b = $('#sheet'), opening = b.hidden; if (opening) { S.sheetFrom = document.activeElement; bgInert(true); }
  b.innerHTML = '<div class="sheet-bg" data-act="close"></div><div class="sheet" role="dialog" aria-modal="true" tabindex="-1">' + html + '</div>'; b.hidden = false;
  const d = /** @type {HTMLElement|null} */ (b.querySelector('.sheet')), h = d && d.querySelector('h2');
  if (!d) return;
  if (h) { h.id = 'sheet-h'; d.setAttribute('aria-labelledby', 'sheet-h'); } else d.setAttribute('aria-label', 'Dialog'); // nama dialog = judulnya, bukan kata generik
  if (opening) d.focus({preventScroll: true}); // fokus masuk ke dialog (wadah, bukan kolom isian: keyboard layar tidak muncul sendiri)
  if (S.err) failBox(); // galat yang masih berlaku ikut pindah ke sheet (sheet dirender ulang atau baru dibuka)
}
/* P2 (UX-06): pengganti confirm() bawaan browser. askConfirm(judul, pesan, labelOk, {danger, cancel}) -> Promise<boolean>.
   Bila sudah ada sheet terbuka (mis. form edit), isinya DITAHAN (bukan dihancurkan) selama konfirmasi tampil lalu dipasang lagi saat Batal, jadi isian yang sudah diketik tidak hilang.
   Esc, ketuk latar, dan tombol Kembali = Batal. Tombol utama di atas (tindakan yang disarankan), Batal di bawah; danger:true = merah (hapus/tolak/batalkan). */
function askConfirm(title, msg, okLabel, o) {
  o = o || {};
  return new Promise(res => {
    const b = $('#sheet'), prev = !b.hidden ? document.createDocumentFragment() : null, qo = S.qopen;
    if (prev) while (b.firstChild) prev.appendChild(b.firstChild);
    S.opin = {res: v => res(!!v), kind: 'konfirm', prev: prev, qopen: qo}; S.qopen = false; // qopen=false: badge() tidak menimpa sheet ini dengan daftar antrean
    sheet('<div class="grab"></div><h2>' + esc(title) + '</h2><p class="muted">' + esc(msg) + '</p><button class="btn ' + (o.danger ? 'dan' : 'pri') + '" data-act="cf_ok">' + esc(okLabel || 'Lanjutkan') + '</button><button class="btn sec" data-act="cf_no">' + esc(o.cancel || 'Batal') + '</button>');
    const bg = b.querySelector('.sheet-bg'); if (bg) bg.setAttribute('data-act', 'cf_no'); // ketuk latar = Batal (bukan menutup seluruh sheet di bawahnya)
    const d = /** @type {HTMLElement|null} */ (b.querySelector('.sheet')); if (d) d.focus({preventScroll: true});
  });
}
function cfDone(ok) {
  const o = S.opin; if (!o || o.kind !== 'konfirm') return;
  S.opin = null; const b = $('#sheet');
  if (o.prev) { failClear(); b.innerHTML = ''; b.appendChild(o.prev); S.qopen = o.qopen; const d = /** @type {HTMLElement|null} */ (b.querySelector('.sheet')); if (d) d.focus({preventScroll: true}); } // sheet semula kembali apa adanya
  else closeSheet();
  o.res(ok);
}
const dismissSheet = () => { if (S.opin && S.opin.kind === 'konfirm') cfDone(false); else closeSheet(); }; // Esc, Kembali: konfirmasi = Batal, selain itu tutup
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
function closeSheet() { if (S.opin) { const r = S.opin.res; S.opin = null; r(null); } const b = $('#sheet'); S.qopen = false; if (!b.hidden) failClear(); b.hidden = true; b.innerHTML = ''; bgInert(false); try { const f = S.sheetFrom; S.sheetFrom = null; if (f && f.isConnected && f.focus) f.focus({preventScroll: true}); } catch (e) {} if (S.deferRender) { S.deferRender = false; render(); } if (S.conflictPending) setTimeout(notifyConflicts, 250); }

