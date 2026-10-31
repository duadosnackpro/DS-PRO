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
  chev: '<path d="m9 18 6-6-6-6"/>', trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/><path d="M10 11v5M14 11v5"/>', search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>', check: '<path d="M20 6 9 17l-5-5"/>'
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
  const nomor = S.nomor[rc.rid] || '(menunggu sinkron)', kasir = String(rc.kasir || ''), kv = (k, v) => add(lr(k, String(v).slice(0, w - k.length - 1), w));
  kv('No', nomor); kv('Waktu', dmy(rc.time) + ' ' + hms(rc.time).slice(0, 5)); if (kasir) kv('Kasir', kasir); kv('Via', rc.ch);
  hr();
  if (wide) { // tabel: ITEM | QTY | HARGA | TOTAL (satu baris per item; nama panjang turun ke baris berikutnya)
    const Q = 4, H = 10, TT = 11, N = w - Q - H - TT - 3;
    add(ljust('ITEM', N) + ' ' + rjust('QTY', Q) + ' ' + rjust('HARGA', H) + ' ' + rjust('TOTAL', TT), {b: true}); hr();
    rc.lines.forEach(l => wrapWords(l.n, N).forEach((x, i) => add(i ? x : ljust(x, N) + ' ' + rjust(String(l.q), Q) + ' ' + rjust(num(l.h), H) + ' ' + rjust(num(l.q * l.h), TT))));
  } else rc.lines.forEach(l => { wrapWords(l.n, w).forEach(x => add(x)); add(lr('  ' + l.q + ' x ' + num(l.h), num(l.q * l.h), w)); });
  const ind = wide ? 20 : 0, pad = ' '.repeat(ind), S2 = (a, b, x) => add(pad + lr(a, b, w - ind), x);
  hr(); S2('Subtotal', num(rc.sub)); if (rc.dis) S2('Diskon', '-' + num(rc.dis)); if (rc.ppn) S2(T(cfg('ppn_inklusif')) ? 'PPN (incl.)' : 'PPN', num(rc.ppn));
  S2('TOTAL', 'Rp ' + num(rc.total), {b: true});
  add(''); S2(pay === 'qris' ? 'QRIS' : pay.charAt(0).toUpperCase() + pay.slice(1), num(rc.terima)); if (pay === 'tunai') S2('Kembalian', num(rc.kembali));
  const ft = cfgOn('footer_aktif', true) ? noteLines(cfg('footer_struk'), w) : [], qr = String(cfg('qr_struk') || '').trim();
  if (ft.length || qr) add('');
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
