// Tes P1 UX (audit UI/UX v2.5.6): UX-01/UX-19 galat yang bertahan, UX-02 label form kas, UX-03 tombol Kembali.
// Memuat kode ASLI dari src/app (bukan salinan) ke konteks dengan DOM dan riwayat tiruan sekecil mungkin.
//   node tests/p1_ux.js
const fs = require('fs'), path = require('path'), assert = require('assert');
const rd = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let pass = 0, failN = 0; const ok = (c, m) => { if (c) pass++; else { failN++; console.log('GAGAL: ' + m); } };
const cut = (s, a, b) => { const i = s.indexOf(a); assert(i >= 0, 'penanda tidak ditemukan: ' + a); const j = s.indexOf(b, i); assert(j > i, 'penanda akhir tidak ditemukan: ' + b); return s.slice(i, j); };

/* ---------- DOM tiruan: cukup untuk fail()/failBox()/failClear() ---------- */
class El {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.kids = []; this.parentElement = null; this.cls = new Set(); this.hidden = false; this.focused = 0; this.removed = false; this.text = ''; this.html = ''; }
  get className() { return [...this.cls].join(' '); } set className(v) { this.cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() { const s = this.cls; return {contains: c => s.has(c), add: c => s.add(c)}; }
  get id() { return this.attrs.id || ''; } set id(v) { this.attrs.id = v; }
  get isConnected() { let e = this; while (e.parentElement) e = e.parentElement; return e === DOC.root; }
  set textContent(v) { this.text = String(v); } get textContent() { return this.text; }
  set innerHTML(v) { this.html = String(v); this.kids.forEach(k => k.parentElement = null); this.kids = []; } get innerHTML() { return this.html; }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } removeAttribute(k) { delete this.attrs[k]; }
  append(c) { c.parentElement = this; this.kids.push(c); return c; } appendChild(c) { return this.append(c); } get firstChild() { return this.kids[0] || null; }
  insertBefore(c, ref) { c.parentElement = this; const i = ref ? this.kids.indexOf(ref) : -1; if (i < 0) this.kids.push(c); else this.kids.splice(i, 0, c); return c; }
  get nextSibling() { const p = this.parentElement; return p ? p.kids[p.kids.indexOf(this) + 1] || null : null; }
  insertAdjacentElement(pos, c) { assert.strictEqual(pos, 'afterend'); const p = this.parentElement; c.parentElement = p; p.kids.splice(p.kids.indexOf(this) + 1, 0, c); return c; }
  remove() { const p = this.parentElement; if (p) p.kids.splice(p.kids.indexOf(this), 1); this.parentElement = null; this.removed = true; }
  closest(sel) { let e = this; while (e) { if (e.matches(sel)) return e; e = e.parentElement; } return null; }
  focus() { this.focused++; DOC.active = this; } scrollIntoView() {}
  matches(sel) { return sel.split(',').some(p => { p = p.trim(); let m;
    if ((m = p.match(/^#([\w-]+)$/))) return this.id === m[1];
    if ((m = p.match(/^\.([\w-]+)$/))) return this.cls.has(m[1]);
    if ((m = p.match(/^\[([\w-]+)="([^"]*)"\]$/))) return this.attrs[m[1]] === m[2];
    return p === this.tag; }); }
  all(sel, out) { out = out || []; this.kids.forEach(k => { if (k.matches(sel)) out.push(k); k.all(sel, out); }); return out; }
  querySelector(sel) { return this.all(sel)[0] || null; } querySelectorAll(sel) { return this.all(sel); }
}
const mkDoc = () => { const root = new El('body'); const D = {root, active: null, createElement: t => new El(t), querySelector: s => root.querySelector(s), querySelectorAll: s => root.querySelectorAll(s)}; return D; };
let DOC;
const mk = (id, cls, tag) => { const e = new El(tag || 'div'); if (id) e.id = id; if (cls) e.className = cls; return e; };

const inti = rd('src/app/01-inti.js'), code = cut(inti, 'let failSeq = 0;', '/* A: selama sheet terbuka');
let timers = 0;
const setup = () => {
  DOC = mkDoc(); const S = {}, toasts = [];
  const errbar = DOC.root.append(mk('errbar')), toastEl = DOC.root.append(mk('toast')), sheetEl = DOC.root.append(mk('sheet')); sheetEl.hidden = true;
  const toast = m => toasts.push(m); toast.t = 0;
  const f = new Function('S', '$', 'esc', 'toast', 'document', 'setTimeout', 'clearTimeout', code + '\nreturn {fail, failClear, failBox};');
  const api = f(S, s => DOC.querySelector(s), s => String(s).replace(/</g, '&lt;'), toast, DOC, () => { timers++; }, () => {});
  const openSheet = () => { sheetEl.hidden = false; const d = sheetEl.append(mk('', 'sheet')); d.append(mk('', '', 'h2')); return d; };
  return Object.assign(api, {S, toasts, errbar, toastEl, sheetEl, openSheet});
};

/* ---------- UX-01: galat tanpa kolom bertahan sampai ditutup ---------- */
{
  const t = setup(), t0 = timers;
  t.fail('Transaksi gagal disimpan: jaringan putus');
  const box = t.errbar.querySelector('.errbox');
  ok(box && box.getAttribute('role') === 'alert', 'UX-01: galat tampil di #errbar dengan role=alert');
  ok(box.html.indexOf('jaringan putus') >= 0, 'UX-01: teks galat ada di kotak');
  ok(/<button[^>]*data-act="errx"[^>]*>Tutup<\/button>/.test(box.html), 'UX-01: ada tombol Tutup (data-act=errx)');
  ok(timers === t0, 'UX-01: fail() tidak memasang timer penghilang (bertahan, tidak seperti toast 2,6 dtk)');
  ok(t.S.err === 'Transaksi gagal disimpan: jaringan putus', 'UX-01: S.err menyimpan pesan agar ikut pindah ke sheet');
  t.fail('Galat kedua');
  ok(DOC.querySelectorAll('.errbox').length === 1 && DOC.querySelector('.errbox').html.indexOf('kedua') >= 0, 'UX-01: satu galat pada satu waktu (yang baru menggantikan)');
  t.failClear(); ok(DOC.querySelectorAll('.errbox').length === 0 && t.S.err === null, 'UX-01: Tutup menghapus kotak dan S.err');
  t.fail('   '); ok(DOC.querySelector('.errbox').html.indexOf('Coba lagi') >= 0, 'pesan kosong diganti pesan bawaan, bukan kotak kosong');
  t.fail(new Error('dari Error')); ok(DOC.querySelector('.errbox').html.indexOf('dari Error') >= 0, 'argumen non-string tidak melempar');
}
/* ---------- UX-01: toast info yang tampil dibersihkan saat galat datang ---------- */
{ const t = setup(); t.toastEl.className = 'show'; t.fail('x'); ok(!t.toastEl.cls.has('show'), 'galat menyembunyikan toast sukses yang sedang tampil'); }
/* ---------- UX-01: di dalam sheet, dan ikut pindah saat sheet dirender ulang ---------- */
{
  const t = setup(); const d = t.openSheet();
  t.fail('Stok kurang');
  const inSheet = d.querySelector('.errbox');
  ok(inSheet && !t.errbar.querySelector('.errbox'), 'UX-01: sheet terbuka => kotak galat di dalam sheet (terjangkau keyboard), bukan di #errbar');
  ok(d.kids.indexOf(inSheet) === 1, 'UX-01: kotak galat tepat setelah judul sheet');
  t.sheetEl.kids = []; const d2 = t.sheetEl.append(mk('', 'sheet')); d2.append(mk('', '', 'h2')); t.failBox();
  ok(d2.querySelector('.errbox'), 'UX-01: sheet dirender ulang => galat yang masih berlaku dipasang lagi');
  // galat saat sheet tertutup, lalu sheet dibuka: pindah ke sheet
  const u = setup(); u.fail('Sedang offline'); ok(u.errbar.querySelector('.errbox'), 'tanpa sheet => #errbar');
  const d3 = u.openSheet(); u.failBox(); ok(d3.querySelector('.errbox') && !u.errbar.querySelector('.errbox'), 'sheet dibuka saat galat berlaku => galat pindah ke sheet (tombol Tutup terjangkau jebakan Tab)');
}
/* ---------- UX-19: galat pada kolom ---------- */
{
  const t = setup(), form = DOC.root.append(mk('', 'li'));
  const label = form.append(mk('', '', 'label')), inp = label.append(mk('mn', 'inp', 'input')), t0 = timers;
  const other = form.append(mk('', '', 'button'));
  t.fail('Isi nominal lebih dari 0', '#mn');
  const fe = form.querySelector('.ferr');
  ok(fe && fe.getAttribute('role') === 'alert' && fe.html === '' && fe.text === 'Isi nominal lebih dari 0', 'UX-19: pesan inline role=alert di bawah kolom');
  ok(form.kids.indexOf(fe) === form.kids.indexOf(label) + 1 && !label.kids.includes(fe), 'UX-19: pesan di LUAR <label> (tidak ikut menjadi nama kolom), tepat setelahnya');
  ok(inp.getAttribute('aria-invalid') === 'true' && inp.getAttribute('aria-describedby') === fe.id, 'UX-19: kolom aria-invalid + aria-describedby menunjuk pesan');
  ok(inp.focused === 1 && DOC.active === inp, 'UX-19: kolom difokuskan');
  ok(!DOC.querySelector('.errbox') && timers === t0, 'UX-19: galat kolom tidak menambah kotak/banner dan tidak memakai timer');
  t.failClear(); ok(!form.querySelector('.ferr') && inp.getAttribute('aria-invalid') === null && inp.getAttribute('aria-describedby') === null, 'UX-19: setelah kolom diperbaiki pesan dan atribut dibersihkan');
  other.setAttribute('aria-describedby', 'milik-lain'); other.setAttribute('aria-invalid', 'true'); t.failClear();
  ok(other.getAttribute('aria-describedby') === 'milik-lain', 'aria-describedby milik komponen lain tidak ikut terhapus');
}
{ // kolom di dalam .row2 (flex): pesan ditaruh setelah baris, bukan sebagai sel baru di dalamnya
  const t = setup(), row = DOC.root.append(mk('', 'row2')), l1 = row.append(mk('', '', 'label')), l2 = row.append(mk('', '', 'label')); l1.append(mk('mj', 'inp', 'select')); l2.append(mk('mn', 'inp', 'input'));
  t.fail('Isi nominal lebih dari 0', '#mn');
  ok(row.querySelector('.ferr') === null && DOC.root.kids.indexOf(DOC.root.querySelector('.ferr')) === DOC.root.kids.indexOf(row) + 1, 'UX-19: kolom dalam .row2 => pesan sesudah baris');
}
{ // selector tidak ketemu: jatuh ke kotak galat, tidak hilang diam-diam
  const t = setup(); t.fail('Pilih peran.', '[data-f="role"]'); ok(t.errbar.querySelector('.errbox'), 'UX-19: kolom tidak ditemukan => tetap tampil sebagai kotak galat');
}
{ // dua kolom berurutan: id pesan unik
  const t = setup(), a = DOC.root.append(mk('a', 'inp', 'input')); DOC.root.append(mk("b", "inp", "input")); t.fail('x', '#a'); const i1 = DOC.querySelector('.ferr').id; t.fail('y', '#b'); const i2 = DOC.querySelector('.ferr').id;
  ok(i1 !== i2 && DOC.querySelectorAll('.ferr').length === 1 && a.getAttribute('aria-invalid') === null, 'UX-19: galat baru menghapus yang lama, id pesan tidak bentrok');
}

/* ---------- Pemeriksaan statis atas sumber ---------- */
const files = fs.readdirSync(path.join(__dirname, '../src/app')).filter(f => /\.js$/.test(f)).map(f => ['src/app/' + f, rd('src/app/' + f)]).concat([['web/js/modules.js', rd('web/js/modules.js')]]);
const calls = s => { const out = []; const re = /(?<![\w.])toast\(/g; let m; while ((m = re.exec(s))) { if (s.slice(Math.max(0, m.index - 9), m.index) === 'function ') continue; let i = re.lastIndex, d = 1, j = i, q = null; while (j < s.length && d > 0) { const c = s[j]; if (q) { if (c === '\\') j++; else if (c === q) q = null; } else if ('\'"`'.includes(c)) q = c; else if (c === '(') d++; else if (c === ')') d--; j++; } out.push(s.slice(i, j - 1)); } return out; };
const bad = []; files.forEach(([f, s]) => calls(s).forEach(a => { if (/\b(e|er|e1|e2)\.message\b/.test(a)) bad.push(f + ': toast(' + a.slice(0, 50) + ')'); }));
ok(bad.length === 0, 'UX-01: tidak ada toast() yang membawa e.message (galat harus lewat fail()): ' + bad.join(' | '));
const valid = []; files.forEach(([f, s]) => calls(s).forEach(a => { if (/^'(Isi |Pilih (?!file)|Alasan |Catatan wajib)/.test(a.trim()) && !/Dipilih/.test(a)) valid.push(f + ': ' + a.slice(0, 40)); }));
ok(valid.length === 0, 'UX-19: pesan validasi ("Isi…", "Pilih…", "Alasan…") tidak lagi lewat toast(): ' + valid.join(' | '));
const modules = rd('web/js/modules.js'), apps = rd('src/app/14-mulai.js');
ok(/fail = A\.fail/.test(modules) && /fail: fail/.test(apps), 'modules.js menerima fail dari APP dan app.js mengekspornya');
ok(/<div id="errbar"><\/div>/.test(rd('web/index.html')), 'index.html punya #errbar');
const css = rd('web/css/app.css'); ok(/\.errbox\{/.test(css) && /\.ferr\{/.test(css) && /\.inp\[aria-invalid="true"\]/.test(css) && /#errbar\{[^}]*z-index:70/.test(css), 'CSS: .errbox, .ferr, kolom invalid, #errbar di atas toast/sheet/busy');
ok(/clearTimeout\(\/\*\* @type \{any\} \*\/ \(toast\)\.t\)/.test(inti) && /failClear\(\); \/\/ aksi baru/.test(rd('src/app/02-api-sinkron.js')), 'busy() membersihkan galat percobaan sebelumnya');
const act = rd('src/app/13-aksi.js'); ok(/errx: \(\) => \{ failClear\(\)/.test(act) && /\['input', 'change'\]\.forEach/.test(act), 'aksi errx dan pembersih saat kolom diubah terpasang');

/* ---------- UX-02: kontrol kas masuk/keluar berlabel ---------- */
{
  const tk = rd('src/app/11-tutup-kasir.js'), form = cut(tk, '<b>Kas masuk/keluar</b>', 'data-act="kmove"');
  [['mj', 'select'], ['mn', 'input'], ['mk', 'select'], ['ma', 'input']].forEach(([id, tag]) => {
    const m = form.match(new RegExp('<label>(?:<span id="' + id + '_l">)?([^<]+)(?:</span>)?<' + tag + ' class="inp" id="' + id + '"'));
    if (tag === 'select') ok(form.indexOf('id="' + id + '" aria-labelledby="' + id + '_l"') >= 0, 'UX-02: #' + id + ' (select) bernama dari teks label saja, bukan ikut teks opsi terpilih');
    ok(!!m && m[1].trim().length >= 3, 'UX-02: #' + id + ' dibungkus <label> dengan teks terlihat' + (m ? ' ("' + m[1] + '")' : ''));
  });
  ok(!/id="(mj|mn|mk|ma)"[^>]*placeholder="(Nominal|Alasan \(min)/.test(form), 'UX-02: placeholder bukan lagi satu-satunya nama kolom');
  ok(/#mn/.test(tk) && /#ma/.test(tk) && /#mk/.test(tk) && /#tf/.test(tk) && /#tm/.test(tk), 'UX-19: validasi tutup/buka/kas menunjuk kolomnya');
  ok(/data-act="kmove">Catat kas</.test(tk), 'tombol menyebut "Catat kas" (bukan "Catat" saja)');
}

/* ---------- UX-03: tombol Kembali ---------- */
const nav = rd('src/app/139-navigasi.js');
const mkNav = (init) => {
  const entries = [{init: true}], st = {i: 0}, listeners = {}, pending = [];
  let now = 1000;
  const history = {
    get state() { return entries[st.i]; }, get length() { return entries.length; },
    pushState(s) { entries.length = st.i + 1; entries.push(s); st.i++; }, replaceState(s) { entries[st.i] = s; },
    back() { if (st.i > 0) { st.i--; (listeners.popstate || []).forEach(h => h({state: entries[st.i]})); } },
  };
  const windowStub = {addEventListener: (ev, h) => { (listeners[ev] = listeners[ev] || []).push(h); }};
  const S = Object.assign({token: 't', data: {}, tab: 'kasir', busyOn: false, dirty: false, cart: [], opin: null}, init || {});
  const log = {closed: 0, rendered: 0, toasts: [], cleared: 0}; let sheetHidden = true;
  const env = {S, $: sel => sel === '#sheet' ? {get hidden() { return sheetHidden; }} : null, own: () => !!S.owner, tabAllowed: () => true, homeTab: () => 'kasir',
    closeSheet: () => { log.closed++; sheetHidden = true; }, dismissSheet: () => { log.closed++; sheetHidden = true; }, render: () => { log.rendered++; navApi.navNote(); }, toast: m => log.toasts.push(m), failClear: () => { log.cleared++; },
    history, window: windowStub, Date: {now: () => now}, setTimeout: (fn, ms) => { const t = {fn, at: now + ms}; pending.push(t); return pending.length; }, clearTimeout: id => { if (id && pending[id - 1]) pending[id - 1].fn = null; }};
  const names = Object.keys(env);
  const f = new Function(...names, nav + '\nreturn {NAV, navDecide, navArm, navBack, navNote, navIsRoot, sheetClosable};');
  const navApi = f(...names.map(n => env[n]));
  return {S, log, history, entries, st, nav: navApi, fire: ev => (listeners[ev] || []).forEach(h => h({})), openSheet: () => { sheetHidden = false; }, setNow: n => { now = n; pending.filter(t => t.fn && t.at <= now).forEach(t => { const fn = t.fn; t.fn = null; fn(); }); }, goto: tab => { S.tab = tab; navApi.navNote(); }};
};
const arming = x => x.history.state && x.history.state.duado === 1;
{ // keputusan murni
  const d = c => mkNav().nav.navDecide(Object.assign({auth: true, busy: false, sheet: false, closable: true, root: true, dirty: false, armed: false}, c));
  ok(d({auth: false}) === 'leave', 'navDecide: belum masuk => biarkan');
  ok(d({busy: true, sheet: true}) === 'stay', 'navDecide: permintaan berjalan => abaikan Kembali');
  ok(d({sheet: true}) === 'sheet' && d({sheet: true, closable: false}) === 'stay', 'navDecide: sheet => tutup bila boleh, selain itu tahan');
  ok(d({sheet: true, root: false}) === 'sheet', 'navDecide: sheet di atas sub-layar ditutup dulu, bukan layarnya');
  ok(d({root: false}) === 'screen' && d({root: false, dirty: true}) === 'warn-dirty' && d({root: false, dirty: true, armed: true}) === 'screen', 'navDecide: sub-layar kembali; pengaturan belum disimpan minta dua kali');
  ok(d({root: true}) === 'warn-exit', 'navDecide: layar utama => peringatan keluar');
}
{ // perangkap dipasang saat sentuhan pertama setelah masuk, bukan sebelum masuk
  const x = mkNav({token: null, data: null}); x.fire('pointerdown'); ok(x.history.length === 1, 'UX-03: belum masuk => riwayat tidak diubah');
  x.S.token = 't'; x.S.data = {}; x.fire('pointerdown'); ok(x.history.length === 2 && arming(x) && x.entries[0].duado === 0, 'UX-03: setelah masuk, sentuhan pertama memasang perangkap di atas entri dasar');
  x.fire('pointerdown'); x.fire('keydown'); ok(x.history.length === 2, 'UX-03: sentuhan berikutnya tidak menumpuk entri');
  const y = mkNav(); y.history.replaceState({duado: 1}); const n0 = y.history.length; y.nav.navArm(); ok(y.history.length === n0, 'UX-03: setelah muat ulang (state sudah perangkap) tidak dobel');
  const z = mkNav(); z.history.replaceState({duado: 0}); z.nav.navArm(); ok(z.history.length === 2 && arming(z), 'UX-03: berdiri di entri dasar => cukup dorong perangkap');
}
{ // Back menutup sheet, keranjang tidak disentuh
  const x = mkNav({cart: [{v: 1, qty: 2}]}); x.fire('pointerdown'); x.openSheet(); x.history.back();
  ok(x.log.closed === 1 && x.S.cart.length === 1, 'UX-03: Kembali menutup sheet terbuka dan keranjang tetap utuh');
  ok(arming(x) && x.history.length === 2, 'UX-03: perangkap dipasang lagi setelah Kembali ditangani (Kembali berikutnya tetap ditangkap)');
  ok(x.log.toasts.length === 0 && x.S.tab === 'kasir', 'UX-03: menutup sheet tidak mengganti layar dan tidak memunculkan peringatan keluar');
}
{ // Back dari sub-layar Menu => Menu
  const x = mkNav({tab: 'menu'}); x.goto('menu'); x.fire('pointerdown'); x.goto('master'); x.history.back();
  ok(x.S.tab === 'menu' && x.log.rendered === 1, 'UX-03: Kembali dari sub-layar Menu (Data Master) => Menu');
  ok(arming(x), 'UX-03: perangkap terpasang lagi');
  x.goto('tutup'); x.history.back(); ok(x.S.tab === 'menu', 'UX-03: berlaku untuk semua sub-layar (Tutup kasir)');
}
{ // dari layar utama lain: kembali ke sana, bukan ke Menu
  const x = mkNav({tab: 'kasir'}); x.goto('kasir'); x.fire('pointerdown'); x.goto('tutup'); x.history.back();
  ok(x.S.tab === 'kasir', 'UX-03: banner Kasir => Tutup kasir => Kembali ke Kasir (bukan Menu)');
  const y = mkNav({tab: 'dash'}); y.goto('dash'); y.fire('pointerdown'); y.goto('settings'); y.goto('reset'); y.history.back(); ok(y.S.tab === 'menu', 'UX-03: sub-layar ke sub-layar => Menu, tidak berputar antar sub-layar');
}
{ // owner: Riwayat adalah sub-layar Menu; kasir: layar utama
  const o = mkNav({owner: true}); ok(!o.nav.navIsRoot('riwayat') && o.nav.navIsRoot('menu'), 'owner: Riwayat bukan layar utama');
  const k = mkNav({owner: false}); ok(k.nav.navIsRoot('riwayat') && !k.nav.navIsRoot('master'), 'non-owner: Riwayat layar utama; Data Master sub-layar');
}
{ // pengaturan belum disimpan
  const x = mkNav({tab: 'menu'}); x.goto('menu'); x.fire('pointerdown'); x.goto('settings'); x.S.dirty = true; x.history.back();
  ok(x.S.tab === 'settings' && /belum disimpan/.test(x.log.toasts[0]) && arming(x), 'UX-03: pengaturan belum disimpan => Kembali pertama hanya memperingatkan');
  x.history.back(); ok(x.S.tab === 'menu' && x.S.dirty === false, 'UX-03: Kembali kedua dalam jendela => membuang dan kembali ke Menu');
  const y = mkNav({tab: 'menu'}); y.goto('menu'); y.fire('pointerdown'); y.goto('settings'); y.S.dirty = true; y.history.back(); y.setNow(1000 + 3500); y.history.back();
  ok(y.S.tab === 'settings', 'UX-03: setelah jendela habis, Kembali kembali memperingatkan (tidak diam-diam membuang)');
}
{ // layar utama: dua langkah untuk keluar
  const x = mkNav({tab: 'kasir', cart: [{v: 1}]}); x.goto('kasir'); x.fire('pointerdown'); x.history.back();
  ok(/Keranjang masih terisi/.test(x.log.toasts[0]) && /sekali lagi untuk keluar/.test(x.log.toasts[0]), 'UX-03: di layar utama dengan keranjang terisi, Kembali pertama memperingatkan dan menyebut keranjang tersimpan');
  ok(!arming(x) && x.history.state.duado === 0, 'UX-03: perangkap dicabut selama jendela supaya Kembali kedua benar-benar keluar');
  x.fire('pointerdown'); ok(!arming(x), 'UX-03: sentuhan dalam jendela tidak memasang perangkap lebih awal');
  x.setNow(1000 + 3000); ok(arming(x), 'UX-03: jendela habis => perangkap dipasang lagi');
  const y = mkNav({tab: 'stok'}); y.goto('stok'); y.fire('pointerdown'); y.history.back(); ok(/Tekan Kembali sekali lagi untuk keluar/.test(y.log.toasts[0]) && !/Keranjang/.test(y.log.toasts[0]), 'UX-03: tanpa keranjang pesan keluar tidak menyebut keranjang');
}
{ // permintaan berjalan dan dialog yang tidak boleh ditutup
  const x = mkNav(); x.fire('pointerdown'); x.openSheet(); x.S.busyOn = true; x.history.back();
  ok(x.log.closed === 0 && arming(x), 'UX-03: saat permintaan berjalan Kembali diabaikan (sheet tidak ditutup di tengah penyimpanan)');
  x.S.busyOn = false; x.S.opin = {kind: 'pin'}; x.history.back(); ok(x.log.closed === 0 && arming(x), 'UX-03: dialog input yang tidak boleh dibatalkan (sama dengan tombol Esc) ditahan');
  x.S.opin = {kind: 'alasan'}; x.history.back(); ok(x.log.closed === 1, 'UX-03: dialog alasan bisa ditutup dengan Kembali');
}
{ // setelah keluar sesi: Kembali tidak dicegat
  const x = mkNav(); x.fire('pointerdown'); x.S.token = null; x.S.data = null; x.history.back(); ok(x.log.closed === 0 && x.log.toasts.length === 0 && x.history.length === 2 && !arming(x), 'UX-03: sudah keluar akun => Kembali tidak dicegat dan tidak memasang ulang perangkap');
}
{ // maju ke perangkap (desktop) tidak melakukan apa pun
  const x = mkNav(); x.fire('pointerdown'); x.history.back(); const t0 = x.log.toasts.length; x.nav.navBack({state: {duado: 1}}); ok(x.log.toasts.length === t0, 'UX-03: popstate ke entri perangkap diabaikan');
}
{ // navNote: ganti layar membersihkan galat layar lama, render ulang layar sama tidak
  const x = mkNav({tab: 'menu'}); x.goto('menu'); const c0 = x.log.cleared; x.nav.navNote(); ok(x.log.cleared === c0, 'navNote: render ulang di layar yang sama tidak menghapus galat (mis. sinkron latar belakang)');
  x.goto('master'); ok(x.log.cleared === c0 + 1, 'navNote: pindah layar menghapus galat layar sebelumnya');
}
{ // Escape dan Kembali memakai syarat yang sama
  const a = rd('src/app/13-aksi.js'); ok(/e\.key === 'Escape' && sheetClosable\(\)/.test(a), 'Esc memakai sheetClosable() yang sama dengan Kembali');
}
ok(/139-navigasi\.js/.test(JSON.stringify(fs.readdirSync(path.join(__dirname, '../src/app')))), 'berkas navigasi ada di src/app (ikut build)');
ok(/navNote\(\);/.test(rd('src/app/06-kerangka.js')) && /navArm\(\); flush\(\)/.test(rd('src/app/05-login.js')), 'render() memanggil navNote; login memanggil navArm');

console.log(failN ? 'GAGAL: ' + failN + ' dari ' + (pass + failN) : 'Semua lulus (' + pass + ' pemeriksaan)'); process.exit(failN ? 1 : 0);
