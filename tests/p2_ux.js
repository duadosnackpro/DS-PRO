// Tes P2 UX (audit UI/UX v2.5.6, dikerjakan di v2.5.8): UX-06 tanpa confirm()/prompt() bawaan browser, UX-04 status kasir, UX-11 halaman Pengaturan, UX-15 struk.
// Memuat kode ASLI dari src/app (bukan salinan) ke konteks dengan DOM tiruan sekecil mungkin. Skenario di browser: e2e_p2_chromium.py (di luar CI).
//   node tests/p2_ux.js
const fs = require('fs'), path = require('path'), assert = require('assert');
const rd = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let pass = 0, failN = 0; const ok = (c, m) => { if (c) pass++; else { failN++; console.log('GAGAL: ' + m); } };
const cut = (s, a, b) => { const i = s.indexOf(a); assert(i >= 0, 'penanda tidak ditemukan: ' + a); const j = s.indexOf(b, i + a.length); assert(j > i, 'penanda akhir tidak ditemukan: ' + b); return s.slice(i, j); };
const srcDir = path.join(__dirname, '..', 'src/app'), parts = fs.readdirSync(srcDir).filter(f => /^\d+-.*\.js$/.test(f)).sort();
const all = parts.map(f => fs.readFileSync(path.join(srcDir, f), 'utf8')).join('\n'), mods = rd('web/js/modules.js');

/* ---------- UX-06: tidak ada dialog bawaan browser ---------- */
const native = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).split('\n').flatMap((l, i) => { const code = l.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, ''); const m = code.match(/(^|[^\w.$])(confirm|prompt|alert)\s*\(/g); return m ? [(i + 1) + ': ' + l.trim().slice(0, 80)] : []; });
ok(native(all).length === 0, 'UX-06: src/app tanpa confirm()/prompt()/alert() bawaan: ' + native(all).join(' | '));
ok(native(mods).length === 0, 'UX-06: modules.js tanpa confirm()/prompt()/alert() bawaan: ' + native(mods).join(' | '));
ok((all.match(/\bev\.prompt\(\)/g) || []).length === 1, 'UX-06: satu-satunya "prompt(" yang tersisa adalah API pasang PWA (ev.prompt)');
ok(/askConfirm: askConfirm, busyPause: busyPause/.test(rd('src/app/14-mulai.js')), 'UX-06: askConfirm dan busyPause diekspor ke modules.js lewat APP');
ok(/kind === 'konfirm'/.test(rd('src/app/139-navigasi.js')), 'UX-06: sheetClosable (Esc dan Kembali) mengizinkan penutupan konfirmasi');
ok(/dismissSheet\(\); return;/.test(rd('src/app/13-aksi.js')) && /act === 'sheet'\) dismissSheet\(\)/.test(rd('src/app/139-navigasi.js')), 'UX-06: Esc dan Kembali memakai dismissSheet (= Batal pada konfirmasi)');

/* askConfirm / cfDone dengan sheet tiruan */
class Node { constructor(html) { this.html = html; this.parent = null; this.attrs = {}; this.focused = 0; } setAttribute(k, v) { this.attrs[k] = v; } focus() { this.focused++; } }
class Host { // meniru #sheet dan DocumentFragment: appendChild memindahkan (bukan menyalin) node
  constructor() { this.kids = []; this.hidden = true; }
  get firstChild() { return this.kids[0] || null; }
  appendChild(c) { if (c instanceof Host) { c.kids.splice(0).forEach(k => this.appendChild(k)); return c; } if (c.parent) c.parent.kids.splice(c.parent.kids.indexOf(c), 1); c.parent = this; this.kids.push(c); return c; }
  set innerHTML(v) { this.kids.forEach(k => { k.parent = null; }); this.kids = []; }
  querySelector(sel) { return sel === '.sheet-bg' ? this.kids.find(k => /sheet-bg/.test(k.cls || '')) || null : sel === '.sheet' ? this.kids.find(k => k.cls === 'sheet') || null : null; }
}
const setup = () => {
  const host = new Host(), S = {opin: null, qopen: true}, log = {closed: 0, clears: 0, shown: []};
  const sheet = html => { host.hidden = false; host.innerHTML = ''; const bg = new Node(''), d = new Node(html); bg.cls = 'sheet-bg'; d.cls = 'sheet'; host.appendChild(bg); host.appendChild(d); log.shown.push(html); };
  const closeSheet = () => { if (S.opin) { const r = S.opin.res; S.opin = null; r(null); } host.hidden = true; host.innerHTML = ''; log.closed++; };
  const f = new Function('S', '$', 'esc', 'sheet', 'closeSheet', 'failClear', 'document', cut(rd('src/app/01-inti.js'), '/* P2 (UX-06): pengganti confirm()', '/* Tab tetap berputar') + '\nreturn {askConfirm, cfDone, dismissSheet};');
  const api = f(S, () => host, s => String(s).replace(/</g, '&lt;'), sheet, closeSheet, () => { log.clears++; }, {createDocumentFragment: () => new Host()});
  return Object.assign(api, {S, host, log, sheet, closeSheet});
};
(async () => {
  { const t = setup(); const p = t.askConfirm('Hapus?', 'Pesan <b>', 'Hapus', {danger: true, cancel: 'Kembali'});
    const h = t.log.shown[0]; ok(/<h2>Hapus\?<\/h2>/.test(h) && /btn dan" data-act="cf_ok">Hapus</.test(h) && /btn sec" data-act="cf_no">Kembali</.test(h) && h.indexOf('cf_ok') < h.indexOf('cf_no'), 'UX-06: konfirmasi: judul, tombol utama merah di atas, Batal di bawah: ' + h);
    ok(h.indexOf('<b>') < 0, 'UX-06: pesan di-escape');
    ok(t.host.querySelector('.sheet-bg').attrs['data-act'] === 'cf_no', 'UX-06: ketuk latar diarahkan ke Batal (bukan close)');
    ok(t.S.opin && t.S.opin.kind === 'konfirm' && t.S.qopen === false, 'UX-06: S.opin.kind=konfirm dan qopen=false (badge() tidak menimpa dialog)');
    t.cfDone(true); ok(await p === true, 'UX-06: OK => true'); ok(t.host.hidden && t.S.opin === null, 'UX-06: tanpa sheet sebelumnya, OK menutup sheet'); }
  { const t = setup(), p = t.askConfirm('A', 'B', 'C'); t.dismissSheet(); ok(await p === false, 'UX-06: dismissSheet (Esc/Kembali) = false'); ok(!/btn dan/.test(t.log.shown[0]), 'UX-06: bukan danger => tombol utama biasa'); }
  { const t = setup(), p = t.askConfirm('A', 'B', 'C'); t.closeSheet(); ok(await p === false, 'UX-06: sheet ditutup dari luar => false (tidak menggantung)'); }
  { const t = setup(); t.sheet('FORM'); t.S.qopen = true; const orig = t.host.kids.slice(), p = t.askConfirm('Hapus data ini?', 'x', 'Hapus', {danger: true});
    ok(t.host.kids.length === 2 && /Hapus data ini/.test(t.host.kids[1].html), 'UX-06: konfirmasi tampil di atas sheet yang terbuka');
    t.cfDone(false); ok(await p === false, 'UX-06: Batal => false');
    ok(t.host.kids.length === orig.length && t.host.kids.every((k, i) => k === orig[i]) && !t.host.hidden, 'UX-06: sheet semula dipasang kembali dengan NODE yang sama (isian yang diketik tidak hilang)');
    ok(t.S.qopen === true && t.log.closed === 0, 'UX-06: qopen dipulihkan dan sheet tidak ditutup');
    const p2 = t.askConfirm('Lagi', 'x', 'Ya'); t.cfDone(true); ok(await p2 === true && !t.host.hidden && t.host.kids[1] === orig[1], 'UX-06: OK juga mengembalikan sheet semula (aksi lanjutan yang menutupnya)'); }
  { const t = setup(); t.cfDone(true); t.S.opin = {kind: 'alasan', res: () => { throw new Error('tidak boleh'); }}; t.cfDone(true); ok(t.S.opin && t.S.opin.kind === 'alasan', 'UX-06: cfDone mengabaikan sheet lain (alasan/otorisasi)'); }
  /* ---------- UX-04: chip status kasir di header ---------- */
  { const el = {hidden: true, className: '', textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }};
    const mk = (S, sell) => { const f = new Function('S', '$', 'can', cut(rd('src/app/06-kerangka.js'), 'function shiftUpd() {', 'function qstatUpd()') + '\nreturn shiftUpd;'); return f(S, () => el, () => sell); };
    mk({data: {}, wajibBuka: true, shiftOpen: false}, true)(); ok(!el.hidden && el.textContent === 'Kasir belum dibuka' && el.attrs['data-act'] === 'kbuka' && el.className === 'shs warn', 'UX-04: belum buka => chip kuning "Kasir belum dibuka" membuka sheet (kbuka)');
    mk({data: {}, wajibBuka: true, shiftOpen: true}, true)(); ok(!el.hidden && el.textContent === 'Kasir buka' && el.attrs['data-act'] === 'go_tutup' && el.className === 'shs ok', 'UX-04: sudah buka => "Kasir buka" menuju Tutup kasir');
    mk({data: {}, wajibBuka: true, shiftOpen: undefined}, true)(); ok(el.hidden, 'UX-04: status belum diketahui => chip tersembunyi (tidak menebak)');
    mk({data: {}, wajibBuka: false, shiftOpen: false}, true)(); ok(el.hidden, 'UX-04: buka kasir tidak diwajibkan => chip tersembunyi');
    mk({data: {}, wajibBuka: true, shiftOpen: false}, false)(); ok(el.hidden, 'UX-04: peran tanpa hak menjual => chip tersembunyi'); }
  const kasir = rd('src/app/07-kasir-foto.js'), tutup = rd('src/app/11-tutup-kasir.js');
  ok(/data-act="kbuka">Buka kasir/.test(kasir) && !/data-act="go_tutup">Buka kasir/.test(kasir), 'UX-04: tombol banner Kasir membuka sheet (kbuka), bukan pindah layar');
  ok(/kbuka: kasOpenSheet/.test(rd('src/app/136-transfer.js')) && /id="bm"/.test(tutup) && /if \(inSheet\) closeSheet\(\)/.test(tutup), 'UX-04: sheet Buka kasir terpasang (kolom #bm, menutup sendiri setelah berhasil)');
  ok(!/S\.shiftOpen = false; const r = await api\('shift\.close'/.test(tutup), 'UX-04: S.shiftOpen tidak diubah sebelum server menjawab (tutup gagal tidak membuat status palsu)');
  ok(!/\bprompt\(/.test(tutup) && /askReason\('Tinjau selisih/.test(tutup) && /askReason\('Buka kembali penutupan\?'/.test(tutup) && /askReason\('Batalkan pembelian ini\?'/.test(rd('src/app/09-stok-pembelian.js')), 'UX-06: tiga prompt() lama kini askReason');
  /* ---------- UX-11: halaman Pengaturan ---------- */
  { const set = rd('src/app/10-menu-master-pengaturan.js'), vs = set.slice(set.indexOf('function vSettings()'), set.indexOf('async function sSave()'));
    const map = new Function(cut(set, 'const SET_PAGES', 'function setPageNav') + '\nreturn {SET_PAGES, SET_PAGE_OF};')();
    const titles = [...vs.matchAll(/card\('([^']+)'/g)].map(m => m[1]);
    ok(titles.length === 11, 'UX-11: vSettings punya 11 kartu: ' + titles.length);
    ok(titles.every(t => t in map.SET_PAGE_OF), 'UX-11: setiap kartu terpetakan ke halaman: ' + titles.filter(t => !(t in map.SET_PAGE_OF)).join(', '));
    const per = map.SET_PAGES.map((_, i) => Object.keys(map.SET_PAGE_OF).filter(k => map.SET_PAGE_OF[k] === i).length);
    ok(per.every(n => n >= 1 && n <= 4) && per.reduce((a, b) => a + b, 0) === 11, 'UX-11: kartu per halaman = ' + per.join('/') + ' (maks. 4)');
    ok(/setPageNav\(pg\)/.test(vs) && /<div id="sf"/.test(vs) && vs.indexOf('id="sf"') < vs.indexOf('setPageNav(pg)') && vs.indexOf('setPageNav(pg)') < vs.indexOf('card(\'Usaha'), 'UX-11: navigasi halaman berada DI DALAM form #sf (satu form, satu Simpan)');
    ok(!/spage[^}]*S\.dirty\s*=/.test(rd('src/app/13-aksi.js').split('\n').find(l => /^\s*spage:/.test(l)) || ''), 'UX-11: pindah halaman tidak menyentuh S.dirty'); }
  /* ---------- UX-15: struk ---------- */
  { const k = kasir.slice(kasir.indexOf('function showReceipt'), kasir.indexOf('function refreshRc'));
    ok(/btUsable = \(\) => isAndroid\(\) \|\| !!navigator\.bluetooth \|\| btHasSerial\(\)/.test(kasir), 'UX-15: tombol Bluetooth hanya bila perangkat bisa (Android/Bluetooth/Serial)');
    ok(/canShare \? '<button[^']*data-act="share"/.test(k), 'UX-15: Bagikan hanya bila ada navigator.share');
    ok(/<details class="more"><summary>Lainnya<\/summary>/.test(k) && k.indexOf('Lainnya') < k.indexOf('data-act="copyrc"') && k.indexOf('Lainnya') < k.indexOf('id="rtxt"'), 'UX-15: Salin dan cetak browser dilipat ke "Lainnya"');
    ok(/<div class="sticky-act"><button class="btn pri big" data-act="close">Transaksi baru<\/button><\/div>'\);$/.test(k.trim().split('\n').filter(l => /Transaksi baru/.test(l))[0] || ''), 'UX-15: "Transaksi baru" di pembungkus sticky, elemen terakhir');
    ok(/No\. WhatsApp \(opsional\)/.test(k) && /Cetak lewat browser/.test(k) && !/>Cetak<\/button>/.test(k), 'UX-15: label "No. WhatsApp (opsional)" dan "Cetak lewat browser" (tidak ada dua "Cetak")');
    ok(/\.sticky-act\{position:sticky;bottom:0/.test(rd('web/css/app.css')), 'UX-15: CSS .sticky-act menempel di dasar'); }
  console.log(failN ? failN + ' GAGAL, ' + pass + ' lulus' : 'Semua lulus (' + pass + ' pemeriksaan)'); process.exit(failN ? 1 : 0);
})().catch(e => { console.log('GALAT TES: ' + (e && e.stack || e)); process.exit(1); });
