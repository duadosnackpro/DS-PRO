/* Modul Owner: Beranda (dashboard), Produksi + Resep (HPP produksi), Laporan, Impor Shopee. Memakai API di app.js lewat window.APP. */
(function () {
'use strict';
const A = window.APP, S = A.S, $ = A.$, api = A.api, rp = A.rp, num = A.num, esc = A.esc, LS = A.LS, T = A.T, sheet = A.sheet, closeSheet = A.closeSheet, toast = A.toast, busy = A.busy, skel = A.skel, ACT = A.ACT;
const set = k => S.data.settings[k];
const mById = id => S.data.materials.find(m => m.id === id);
const pct = n => (Math.round(Number(n) * 10) / 10).toLocaleString('id-ID') + '%';
const dec = n => (Math.round(Number(n) * 1000) / 1000).toLocaleString('id-ID', {maximumFractionDigits: 3});
const N = A.dnum, r6 = A.r6, wrapChips = A.wrapChips, emptyState = A.emptyState, idDate = A.idDate, idRange = A.idRange;
const ymd = d => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
const p2 = n => ('0' + n).slice(-2);
const kv = (a, b, cl) => '<div class="kv ' + (cl || '') + '"><span>' + a + '</span><span>' + b + '</span></div>';
const vLabel = id => { const v = A.vById(id); return v ? A.vName(v) + ' ' + A.vSub(v) : '(produk dihapus)'; };
S.dp = 'hari'; S.pform = {jenis: 'batch', recipe: '', batch: '1', catatan: ''}; S.rt = 'labarugi'; S.rto = A.today(); S.rfrom = S.rto.slice(0, 8) + '01';

/* ---------- Akurasi laba: produk terjual yang HPP-nya masih 0 ---------- */
const hc = {};
function hppCheck(from, to) {
  const k = from + '|' + to, vk = A.dverKey() + '|' + A.today(); if (hc[k] && hc[k].vk === vk) return Promise.resolve(hc[k].v);
  return api('report.get', {type: 'penjualan', from: from, to: to}, {silent: true}).then(r => { const v = hppOf(r.rows); hc[k] = {vk: vk, v: v}; return v; });
}
const hppOf = rows => { const bad = rows.filter(x => !(Number(x[5]) > 0)); return {n: bad.length, names: bad.map(x => (x[0] + ' ' + x[1]).trim())}; };
const warnBanner = v => '<div class="warn-b" role="alert"><div><b>Laba belum akurat:</b> ' + v.n + ' produk belum punya resep/HPP<div class="muted">' + esc(v.names.slice(0, 3).join(', ')) + (v.names.length > 3 ? ' dan ' + (v.names.length - 3) + ' lainnya' : '') + '</div></div><button class="btn pri sm" data-act="go_resep">Lengkapi di Resep</button></div>';
const qMark = '<span class="q-m" title="HPP belum diisi, margin belum bisa dihitung" aria-label="margin belum bisa dihitung">?</span>';

/* ---------- Beranda (dashboard) ---------- */
function vDash(force) { // force: tombol muat ulang (↻) memaksa ambil ulang dari server
  $('#main').innerHTML = wrapChips([['hari', 'Hari ini'], ['minggu', '7 hari'], ['bulan', 'Bulan ini']].map(p => '<button class="chip ' + (S.dp === p[0] ? 'on' : '') + '" data-act="dp" data-p="' + p[0] + '">' + p[1] + '</button>').join('') + '<button class="chip" data-act="dp" data-p="' + S.dp + '" aria-label="Muat ulang">↻</button>') + '<div id="dbody"></div>';
  /* Hasil disimpan bersama sidik versi data + tanggal ({k, d}). Layar langsung menampilkan hasil tersimpan; laporan penuh diambil hanya bila versi data berubah
     (ada penjualan/biaya/produksi baru), hari berganti, atau ↻ ditekan. Sidik diambil SEBELUM permintaan: bila data bergerak di sela, hasilnya tampak sedikit basi
     dan diambil ulang di kunjungan berikutnya (arah aman). Format lama (tanpa {k, d}) tetap ditampilkan lalu diperbarui. */
  const key = 'dash_' + S.dp, c = LS.get(key, null), want = S.dp, cached = c && c.k !== undefined ? c.d : c;
  if (cached) drawDash(cached); else $('#dbody').innerHTML = skel(4);
  if (!force && cached && navigator.onLine === false) return;
  A.verSync(force ? 0 : 15000).then(() => {
    if (S.tab !== 'dash' || S.dp !== want || !$('#dbody')) return;
    const k = A.dverKey() + '|' + A.today(); if (!force && c && c.k === k) return;
    return api('dashboard.get', {period: want}).then(d => { LS.set(key, {k: k, d: d}); if (S.tab === 'dash' && S.dp === want && $('#dbody')) drawDash(d); });
  }).catch(e => { try { console.error('dashboard', e); } catch (x) {} /* G: detail teknis hanya ke log; pengguna melihat pesan ramah + Coba lagi */ if (!cached && $('#dbody')) $('#dbody').innerHTML = '<div class="empty-s" role="alert"><h3>Data belum bisa dimuat</h3><p>Periksa sambungan internet, lalu coba lagi.</p><button class="btn sec" data-act="dp" data-p="' + esc(S.dp) + '">Coba lagi</button></div>'; });
}
function delta(c, p, lab) { if (!p) return '<span>—</span> ' + lab + ' (belum ada data)'; const x = (c - p) / Math.abs(p) * 100; return '<span style="color:' + (x >= 0 ? 'var(--ok)' : 'var(--err)') + ';font-weight:800">' + (x >= 0 ? '▲ ' : '▼ ') + pct(Math.abs(x)) + '</span> ' + lab; }
const kpi = (l, v, sub) => '<div class="kpi"><div class="muted">' + l + '</div><b>' + v + '</b><div class="muted">' + sub + '</div></div>';
function barChart(ser) {
  const W = 320, H = 130, pad = 18, n = ser.length, max = Math.max(1, ...ser.map(s => s.omzet)), bw = (W - 8) / n; let g = '';
  ser.forEach((s, i) => {
    const h = Math.max(1, Math.round(s.omzet / max * (H - pad - 14))), lh = Math.max(0, Math.round(Math.max(s.laba, 0) / max * (H - pad - 14))), x = 4 + i * bw + bw * .15, w = bw * .7;
    g += '<rect data-b="' + i + '" x="' + x + '" y="' + (H - pad - h) + '" width="' + w + '" height="' + h + '" rx="3" fill="#E4570E"/><rect data-b="' + i + '" x="' + x + '" y="' + (H - pad - lh) + '" width="' + w + '" height="' + lh + '" rx="3" fill="#5B1A14"/>';
    if (n <= 8 || i % 5 === 0) g += '<text x="' + (x + w / 2) + '" y="' + (H - 4) + '" font-size="10" text-anchor="middle" fill="#6A5851">' + s.d.slice(8) + '</text>';
    g += '<rect data-act="bar" data-i="' + i + '" x="' + (4 + i * bw) + '" y="0" width="' + bw + '" height="' + H + '" fill="transparent" style="cursor:pointer"/>'; // area ketuk selebar kolom
  });
  return '<svg class="bchart" viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Omzet dan laba kotor per hari. Ketuk batang untuk melihat nilai.">' + g + '</svg>';
}
const COL = ['#5B1A14', '#E4570E', '#FFC52E', '#14703A', '#8C7B6E']; // palet token "Dapur Pedas": maroon, cabai, kuning, hijau, abu hangat
function donut(parts, total) { // batang bertumpuk per channel
  return '<div class="stack" role="img" aria-label="Komposisi penjualan per channel">' + parts.map((p, i) => '<i style="width:' + (total ? p.omzet / total * 100 : 0) + '%;background:' + COL[i % 5] + '"></i>').join('') + '</div>';
}
const PLAB = {hari: 'hari ini', minggu: '7 hari terakhir', bulan: 'bulan ini'};
function heroHtml(d, lab) { // kartu utama: omzet, pembanding, batang harian (bagian bawah batang = laba kotor)
  const c = d.cur, p = d.prev, ser = d.series, n = ser.length, max = Math.max(1, ...ser.map(s => s.omzet));
  const bars = ser.map((s, i) => '<div data-act="bar" data-b="' + i + '" data-i="' + i + '"' + (i === n - 1 ? ' class="t"' : '') + ' style="height:' + Math.max(3, Math.round(s.omzet / max * 100)) + '%"><i style="height:' + (s.omzet > 0 ? Math.min(100, Math.round(Math.max(s.laba, 0) / s.omzet * 100)) : 0) + '%"></i></div>').join('');
  const labs = ser.map((s, i) => '<span>' + (n <= 8 || i % 5 === 0 || i === n - 1 ? s.d.slice(8) : '') + '</span>').join('');
  return '<div class="hero"><small>Omzet ' + (PLAB[d.period] || '') + '</small><div class="big">' + rp(c.omzet) + '</div><div class="dlt">' + delta(c.omzet, p.omzet, lab) + '</div><div class="hbars bchart" role="img" aria-label="Omzet per hari. Ketuk batang untuk melihat nilai.">' + bars + '</div><div class="hlab">' + labs + '</div><div class="btip" id="bt" aria-live="polite">Ketuk batang untuk nilai harian (bagian bawah batang = laba kotor)</div></div>';
}
const CMP = {hari: 'vs kemarin', minggu: 'vs 7 hari sebelumnya', bulan: 'vs periode sama bulan lalu'};
function drawDash(d) {
  const c = d.cur, p = d.prev, tot = d.channels.reduce((a, x) => a + x.omzet, 0), maxQ = Math.max(1, ...d.top.map(t => t.qty)), lab = CMP[d.period] || 'vs sebelumnya';
  const days = Math.round((new Date(d.to + 'T12:00:00') - new Date(d.from + 'T12:00:00')) / 86400000) + 1, pto = d.pto || A.addDays(d.from, -1), pfrom = d.pfrom || A.addDays(pto, -(days - 1)); S.dser = d.series;
  $('#dbody').innerHTML = '<div id="hppw"></div>' + (d.stok_minus && d.stok_minus.length ? '<div class="warn-b" role="alert"><div><b>Stok minus, perlu opname:</b> ' + esc(d.stok_minus.slice(0, 4).map(x => x.nama + ' (' + dec(x.stok) + ')').join(', ')) + (d.stok_minus.length > 4 ? ' dan ' + (d.stok_minus.length - 4) + ' lainnya' : '') + '<div class="muted">Penjualan tetap tercatat; stok server lebih kecil dari stok fisik.</div></div><button class="btn pri sm" data-act="tab" data-t="stok">Buka Stok</button></div>' : '') + (d.peringatan || []).map(w => '<div class="warn-b" role="alert"><div>' + esc(w) + '</div><button class="btn pri sm" data-act="go_settings">Pengaturan</button></div>').join('') + '<p class="muted rcap">' + esc(idRange(d.from, d.to)) + ' · omzet tanpa PPN · pembanding: ' + esc(idRange(pfrom, pto)) + '</p>' + heroHtml(d, lab) + '<div class="kgrid k3">' + kpi('Transaksi', num(c.trx), 'Rata-rata ' + rp(c.trx ? c.omzet / c.trx : 0)) +
    kpi('Laba kotor', rp(c.laba), '<span id="mgn">' + (c.omzet ? pct(c.laba / c.omzet * 100) : '0%') + ' margin</span>') + kpi('Laba bersih', rp(d.laba_bersih), 'setelah fee dan biaya') + '</div>' +
    '<div class="li" style="display:block"><b>Per channel</b><div style="display:block">' + donut(d.channels, tot) + '<div style="flex:1">' + (d.channels.map((x, i) => '<div class="kv"><span><span class="lgd" style="background:' + COL[i % 5] + ';margin-left:0"></span>' + esc(x.nama) + '</span><span>' + (tot ? pct(x.omzet / tot * 100) : '0%') + '</span></div>').join('') || '<span class="muted">Belum ada penjualan</span>') + '</div></div></div>' +
    '<div class="li" style="display:block"><b>Produk terlaris</b>' + (d.top.map(t => '<div style="margin-top:6px"><div class="kv"><span>' + esc(t.nama) + '</span><span>' + num(t.qty) + ' pcs</span></div><div class="bar"><i style="width:' + Math.round(t.qty / maxQ * 100) + '%"></i></div></div>').join('') || '<div class="muted">Belum ada data</div>') + '</div>' +
    '<div class="li" style="display:block"><b>Perlu perhatian</b>' + (d.low.map(l => '<div class="kv"><span>' + esc(l.nama) + '</span><span><span class="tag">Menipis</span> ' + dec(l.stok) + ' ' + esc(l.satuan) + '</span></div>').join('') || '<div class="muted">Semua stok bahan aman</div>') + (d.biaya ? kv('Biaya operasional', rp(d.biaya)) : '') + '</div>';
  if (c.trx) hppCheck(d.from, d.to).then(v => { if (!v.n || !$('#hppw')) return; $('#hppw').innerHTML = warnBanner(v); const mg = $('#mgn'); if (mg && c.omzet && c.laba / c.omzet >= .995) mg.innerHTML = qMark + ' margin belum bisa dihitung'; }).catch(() => {});
}

/* ---------- Biaya produksi (dipakai pratinjau, sama dengan hitungan server) ---------- */
const recItems = id => S.data.recipe_items.filter(i => i.recipe_id === id);
function costOf(items, rec, batch, qty, tk, oh) {
  let bahan = 0, kem = 0; const need = {}, blank = x => x === '' || x == null;
  items.forEach(i => { need[i.material_id] = (need[i.material_id] || 0) + Number(i.qty) * batch; });
  const lines = Object.keys(need).map(id => {
    const m = mById(id) || {nama: '(bahan dihapus)', satuan: '', stok: 0, hpp_rata2: 0, tipe: 'bahan'}, q = need[id], c = q * (Number(m.hpp_rata2) || 0);
    if (m.tipe === 'kemasan') kem += c; else bahan += c; return {nama: m.nama, satuan: m.satuan, q: q, stok: Number(m.stok) || 0, ok: (Number(m.stok) || 0) >= q};
  });
  const tkv = blank(tk) ? (N(rec.tenaga_kerja) || 0) * batch : N(tk) || 0;
  const ohv = blank(oh) ? (set('metode_overhead') === 'per_batch' ? (Number(set('overhead_per_batch')) || 0) * batch : (Number(set('overhead_per_unit')) || 0) * qty) : N(oh) || 0;
  const total = bahan + kem + tkv + ohv; return {lines: lines, short: lines.filter(l => !l.ok), bahan: bahan, kem: kem, tk: tkv, oh: ohv, total: total, hpp: qty > 0 ? total / qty : 0};
}
function costHtml(c) {
  return '<div class="li" style="display:block">' + c.lines.map(l => '<div class="kv"><span>' + esc(l.nama) + '</span><span style="' + (l.ok ? '' : 'color:var(--err);font-weight:800') + '">' + dec(l.q) + ' ' + esc(l.satuan) + ' (stok ' + dec(l.stok) + ')' + (l.ok ? '' : ' KURANG') + '</span></div>').join('') + '</div>' +
    '<div class="li" style="display:block">' + kv('Bahan baku', rp(c.bahan)) + kv('Kemasan', rp(c.kem)) + kv('Tenaga kerja', rp(c.tk)) + kv('Overhead', rp(c.oh)) + kv('Total biaya', rp(c.total), 'big') + kv('HPP per unit', rp(c.hpp), 'big') + '</div>';
}

/* ---------- Produksi ---------- */
const JN = {batch: 'Batch', pesanan: 'Per pesanan', repack: 'Repack'};
function vProduksi() {
  $('#main').innerHTML = '<div class="row2"><button class="btn pri" data-act="pnew">+ Produksi baru</button>' + (A.own() ? '<button class="btn sec" data-act="go_resep">Resep</button>' : '') + '</div><div id="plist" style="margin-top:10px">' + skel(3) + '</div>';
  A.vload('production.list', {}, r => { S.prod = r; drawProd(); }, {fail: e => { if ($('#plist')) $('#plist').innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; }});
}
function drawProd() {
  const el = $('#plist'); if (!el) return;
  el.innerHTML = S.prod.map(o => {
    const st = o.status, tag = st === 'selesai' ? '<span class="tag grn">Selesai</span>' : st === 'rencana' ? '<span class="tag">Rencana</span>' : '<span class="tag red">Batal</span>';
    return '<button class="li" style="width:100%;border:0;font:inherit;text-align:left" data-act="pdetail" data-id="' + esc(o.id) + '"><div><b>' + esc(vLabel(o.variant_id)) + '</b><div class="muted">' + esc(JN[o.jenis] || o.jenis) + ' · ' + num(o.jumlah_batch) + ' batch · ' + esc(String(o.tanggal).slice(0, 10)) + '</div></div><div class="r">' + tag +
      (st === 'selesai' ? '<div class="muted">' + num(o.qty_hasil) + ' pcs · HPP ' + rp(o.hpp_per_unit) + '</div>' : '') + '</div></button>';
  }).join('') || (S.data.recipes.length ? emptyState('produksi', 'Belum ada produksi', 'Catat produksi pertama untuk menambah stok produk jadi dan menghitung HPP otomatis.', '<button class="btn pri" data-act="pnew">+ Produksi baru</button>') : emptyState('produksi', 'Belum ada produksi', 'Buat resep dulu agar kebutuhan bahan dan HPP bisa dihitung otomatis.', '<button class="btn pri" data-act="redit" data-id="">Buat resep pertama</button>'));
}
function prodNew() {
  const f = S.pform, recs = S.data.recipes.filter(r => (f.jenis === 'repack') === (r.jenis === 'repack'));
  if (!recs.some(r => r.id === f.recipe)) f.recipe = recs[0] ? recs[0].id : '';
  sheet('<h2>Produksi baru</h2><div class="chips">' + Object.keys(JN).map(k => '<button class="chip ' + (f.jenis === k ? 'on' : '') + '" data-act="pjenis" data-j="' + k + '">' + JN[k] + '</button>').join('') + '</div>' +
    (recs.length ? '<label>Resep<select class="inp" data-pf="recipe">' + recs.map(r => '<option value="' + esc(r.id) + '"' + (r.id === f.recipe ? ' selected' : '') + '>' + esc(r.nama) + ' → ' + esc(vLabel(r.variant_id)) + '</option>').join('') + '</select></label>' +
      '<label>Jumlah batch<input class="inp" data-pf="batch" inputmode="decimal" value="' + esc(f.batch) + '"></label><label>' + (f.jenis === 'pesanan' ? 'Referensi pesanan (nama/nomor)' : 'Catatan') + '<input class="inp" data-pf="catatan" value="' + esc(f.catatan) + '"></label><div id="pv"></div><button class="btn pri" data-act="psave">Simpan rencana produksi</button>'
      : '<p class="muted">Belum ada resep untuk jenis ini. Buat di Produksi, Resep.</p>'));
  pv();
}
function pv() {
  const el = $('#pv'); if (!el) return; const rec = S.data.recipes.find(r => r.id === S.pform.recipe), b = N(S.pform.batch);
  if (!rec || !(b > 0)) { el.innerHTML = ''; return; }
  const qty = Number(rec.hasil_standar) * b, c = costOf(recItems(rec.id), rec, b, qty, '', '');
  el.innerHTML = '<p class="muted">Estimasi hasil ' + num(qty) + ' unit</p>' + costHtml(c) + (c.short.length ? '<p class="err">Stok kurang: ' + esc(c.short.map(x => x.nama).join(', ')) + '. Rencana tetap bisa disimpan, tetapi tidak bisa diselesaikan sebelum stok cukup.</p>' : '');
}
function prodDetail(id) {
  const o = S.prod.find(x => x.id === id); if (!o) return;
  let h = '<h2>' + esc(vLabel(o.variant_id)) + '</h2><p class="muted">' + esc(JN[o.jenis] || o.jenis) + ' · ' + num(o.jumlah_batch) + ' batch · ' + esc(String(o.tanggal).slice(0, 16)) + (o.catatan ? ' · ' + esc(o.catatan) : '') + '</p>';
  if (o.status === 'selesai') h += '<div class="li" style="display:block">' + kv('Hasil standar', num(o.qty_standar)) + kv('Hasil aktual', num(o.qty_hasil)) + kv('Susut', num(o.qty_standar - o.qty_hasil)) + kv('Bahan baku', rp(o.bahan)) + kv('Kemasan', rp(o.kemasan)) + kv('Tenaga kerja', rp(o.tenaga_kerja)) + kv('Overhead', rp(o.overhead)) + kv('Total biaya', rp(o.total), 'big') + kv('HPP per unit', rp(o.hpp_per_unit), 'big') + '</div>';
  else if (o.status === 'rencana') h += '<button class="btn pri" data-act="pdone" data-id="' + esc(id) + '">Selesaikan produksi</button><button class="btn dan" data-act="pcancel" data-id="' + esc(id) + '">Batalkan rencana</button>';
  else h += '<p class="muted">Produksi ini dibatalkan.</p>';
  sheet(h + '<button class="btn sec" data-act="close">Tutup</button>');
}
function prodDone(id) {
  const o = S.prod.find(x => x.id === id), rec = S.data.recipes.find(r => r.id === o.recipe_id);
  if (!rec) return toast('Resep produksi ini sudah dihapus');
  S.pd = {id: id, qty: String(o.qty_standar), tk: '', oh: ''};
  sheet('<h2>Selesaikan produksi</h2><p class="muted">' + esc(vLabel(o.variant_id)) + ' · ' + num(o.jumlah_batch) + ' batch · standar ' + num(o.qty_standar) + ' unit</p><label>Hasil aktual (unit jadi)<input class="inp" data-pd="qty" inputmode="decimal" value="' + esc(S.pd.qty) + '"></label>' +
    '<div class="row2"><div style="flex:1"><label>Tenaga kerja (Rp)<input class="inp" data-pd="tk" inputmode="numeric" placeholder="otomatis"></label></div><div style="flex:1"><label>Overhead (Rp)<input class="inp" data-pd="oh" inputmode="numeric" placeholder="otomatis"></label></div></div><div id="pdv"></div><button class="btn pri" id="pdbtn" data-act="pdosave">Selesaikan dan masukkan ke stok</button>');
  pdv();
}
function pdv() {
  const o = S.prod.find(x => x.id === S.pd.id), rec = S.data.recipes.find(r => r.id === o.recipe_id), q = N(S.pd.qty), el = $('#pdv'); if (!el) return;
  if (!(q > 0)) { el.innerHTML = '<p class="err">Isi hasil aktual</p>'; return; }
  const c = costOf(recItems(rec.id), rec, Number(o.jumlah_batch), q, S.pd.tk, S.pd.oh), v = A.vById(o.variant_id), pos = Math.max(Number(v && v.stok) || 0, 0), lama = Number(v && v.hpp_rata2) || 0, baru = (pos * lama + q * c.hpp) / (pos + q);
  el.innerHTML = costHtml(c) + '<div class="li" style="display:block">' + kv('Susut vs standar', dec(o.qty_standar - q) + ' unit') + kv('HPP produk (rata-rata)', rp(lama) + ' → ' + rp(baru)) + '</div>' + (c.short.length ? '<p class="err">Stok bahan kurang, tidak bisa diselesaikan.</p>' : '');
  const b = $('#pdbtn'); if (b) b.disabled = c.short.length > 0;
}

/* ---------- Resep ---------- */
function vResep() {
  $('#main').innerHTML = '<button class="chip" data-act="tab" data-t="menu">← Menu</button> <button class="chip" data-act="tab" data-t="produksi">Produksi</button><button class="btn pri" data-act="redit" data-id="" style="margin-top:8px">+ Resep baru</button><div style="height:8px"></div>' +
    (S.data.recipes.map(r => { const c = costOf(recItems(r.id), r, 1, Number(r.hasil_standar), '', '');
      return '<div class="li rl"><button class="rl-main" data-act="redit" data-id="' + esc(r.id) + '"><div><b>' + esc(r.nama) + '</b><div class="muted">' + esc(vLabel(r.variant_id)) + ' · ' + esc(JN[r.jenis] || r.jenis) + ' · ' + num(r.hasil_standar) + ' unit/batch</div></div><div class="r"><div class="muted">HPP estimasi</div><b>' + rp(c.hpp) + '</b></div></button><button class="chip" data-act="rdup" data-id="' + esc(r.id) + '" aria-label="Duplikat resep ' + esc(r.nama) + '">Duplikat</button></div>'; }).join('') ||
      emptyState('produksi', 'Belum ada resep', 'Resep menentukan bahan per batch dan hasilnya, sehingga HPP produk dihitung otomatis.', '<button class="btn pri" data-act="redit" data-id="">Buat resep pertama</button>'));
}
/* ---------- Duplikat resep: salin ke satu atau banyak varian sekaligus ---------- */
function dupSheet(id) {
  const r = S.data.recipes.find(x => x.id === id); if (!r) return;
  const items = recItems(id), src = A.vById(r.variant_id), pid = src && src.product_id, hasR = vid => S.data.recipes.filter(x => x.variant_id === vid).map(x => x.nama);
  const vs = S.data.variants.filter(v => v.id !== r.variant_id && !A.isAddon(v)).map((v, i) => [v, i]).sort((a, b) => ((b[0].product_id === pid) - (a[0].product_id === pid)) || (a[1] - b[1])).map(x => x[0]); // varian produk yang sama di atas
  S.dp2 = {src: id, nama: r.nama, sel: {}};
  sheet('<div class="grab"></div><h2>Duplikat resep</h2><p class="muted">Menyalin <b>' + esc(r.nama) + '</b>: ' + items.length + ' bahan, hasil ' + dec(r.hasil_standar) + ' unit per batch, tenaga kerja ' + rp(r.tenaga_kerja || 0) + '. Pilih varian tujuan. Setelah dibuat, tiap resep bisa disesuaikan (mis. jumlah cabai untuk level lebih pedas).</p>' +
    '<label>Nama dasar resep<input class="inp" data-dp="nama" value="' + esc(r.nama) + '"></label>' +
    (vs.length ? '<div class="set-card" style="padding:4px 12px;max-height:38vh;overflow:auto">' + vs.map(v => { const hr = hasR(v.id); return '<label class="sw"><input type="checkbox" data-dv="' + esc(v.id) + '"><span class="sw-t" aria-hidden="true"></span><span class="sw-l"><b>' + esc(A.vName(v) + ' ' + A.vSub(v)) + '</b><small>' + (hr.length ? 'Sudah punya resep: ' + esc(hr.join(', ')) : 'Belum punya resep') + '</small></span></label>'; }).join('') + '</div>' : '<p class="muted">Tidak ada varian lain. Tambahkan varian di Data Master dulu.</p>') +
    '<div class="muted" id="dpn" aria-live="polite">Belum ada varian dipilih</div><div class="muted" id="dpx"></div><button class="btn pri" id="dpbtn" data-act="dpsave" disabled>Buat salinan</button><button class="btn sec" data-act="close">Batal</button>');
}
const dupName = v => (S.dp2.nama.trim() || 'Resep') + ' · ' + (A.vName(v) + ' ' + A.vSub(v)).replace(/^\s+|\s+$/g, '');
function dupUpd() {
  const ids = Object.keys(S.dp2.sel).filter(k => S.dp2.sel[k]), n = ids.length, b = $('#dpbtn'); if (b) b.disabled = !n;
  const nn = $('#dpn'); if (nn) nn.textContent = n ? n + ' varian dipilih' : 'Belum ada varian dipilih';
  const x = $('#dpx'); if (x) x.textContent = n ? 'Contoh nama: ' + dupName(A.vById(ids[0])) : '';
}
const unitAlt = mm => { // satuan kecil: dari Data Master, atau bawaan untuk kg dan Liter
  if (!mm) return null; if (mm.satuan_kecil && Number(mm.faktor_kecil) > 1) return {n: mm.satuan_kecil, f: Number(mm.faktor_kecil)};
  return ({kg: {n: 'gram', f: 1000}, liter: {n: 'ml', f: 1000}, l: {n: 'ml', f: 1000}, ltr: {n: 'ml', f: 1000}, lusin: {n: 'pcs', f: 12}})[String(mm.satuan || '').trim().toLowerCase()] || null;
};
const fmtQ = (q, mm) => { const a = unitAlt(mm); return dec(q) + ' ' + (mm ? mm.satuan : '') + (a && q < 1 ? ' (' + dec(q * a.f) + ' ' + a.n + ')' : ''); };
S.ri = {m: '', q: '', u: 'main'};
function redit(id) {
  const r = id ? S.data.recipes.find(x => x.id === id) : null;
  S.rf = r ? {id: r.id, nama: r.nama, variant_id: r.variant_id, jenis: r.jenis || 'batch', hasil_standar: String(r.hasil_standar).replace('.', ','), tenaga_kerja: String(r.tenaga_kerja || 0).replace('.', ','), items: recItems(r.id).map(i => ({material_id: i.material_id, qty: Number(i.qty)}))}
    : {id: '', nama: '', variant_id: (S.data.variants[0] || {}).id || '', jenis: 'batch', hasil_standar: '', tenaga_kerja: '0', items: []};
  S.ri = {m: (S.data.materials[0] || {}).id || '', q: '', u: 'main'}; rfSheet();
}
function rfSheet() {
  const f = S.rf, mats = S.data.materials, ri = S.ri; if (!mats.some(x => x.id === ri.m)) ri.m = mats[0] ? mats[0].id : '';
  const adder = mats.length ? '<div class="card-s" style="padding:12px"><b>Tambah bahan</b><label>Bahan<select class="inp" id="ri_m" data-ri="m">' + mats.map(x => '<option value="' + esc(x.id) + '"' + (x.id === ri.m ? ' selected' : '') + '>' + esc(x.nama) + ' (' + esc(x.satuan) + ')</option>').join('') + '</select></label>' +
    '<div class="row2"><div style="flex:2"><label id="ri_l">Jumlah per batch</label><input class="inp" id="ri_q" data-ri="q" inputmode="decimal" placeholder="mis. 0,5" value="' + esc(ri.q) + '"></div><div style="flex:1" id="ri_uw"><label>Satuan</label><select class="inp" id="ri_u" data-ri="u"></select></div></div>' +
    '<div class="chips" id="ri_ch"></div><div class="muted" id="ri_h" style="min-height:18px"></div><button class="btn sec" data-act="riadd">Tambah ke resep</button></div>'
    : '<div class="card-s"><p class="muted">Belum ada bahan di Data Master. Tambahkan dulu bahan dan kemasan yang dipakai resep.</p><button class="btn pri" data-act="rimat">Buka Data Master, Bahan</button></div>';
  sheet('<div class="grab"></div><h2>' + (f.id ? 'Ubah resep' : 'Resep baru') + '</h2><label>Nama resep<input class="inp" data-rf="nama" value="' + esc(f.nama) + '"></label><label>Produk hasil (varian)<select class="inp" data-rf="variant_id">' + S.data.variants.map(v => '<option value="' + esc(v.id) + '"' + (v.id === f.variant_id ? ' selected' : '') + '>' + esc(A.vName(v) + ' ' + A.vSub(v)) + '</option>').join('') + '</select></label>' +
    '<label>Jenis<select class="inp" data-rf="jenis"><option value="batch"' + (f.jenis === 'batch' ? ' selected' : '') + '>Batch (produksi sendiri)</option><option value="repack"' + (f.jenis === 'repack' ? ' selected' : '') + '>Repack (kemas ulang)</option></select></label>' +
    '<div class="row2"><div style="flex:1"><label>Hasil standar per batch (unit)<input class="inp" data-rf="hasil_standar" inputmode="decimal" value="' + esc(f.hasil_standar) + '"></label></div><div style="flex:1"><label>Tenaga kerja per batch (Rp)<input class="inp" data-rf="tenaga_kerja" inputmode="decimal" value="' + esc(f.tenaga_kerja) + '"></label></div></div>' +
    '<b>Bahan per batch</b>' + (f.items.map((i, n) => { const mm = mById(i.material_id); return '<div class="li"><div><b>' + esc(mm ? mm.nama : '(bahan dihapus)') + '</b><div class="muted">' + esc(mm ? fmtQ(i.qty, mm) : dec(i.qty)) + (mm && Number(mm.hpp_rata2) > 0 ? ' · ' + rp(i.qty * Number(mm.hpp_rata2)) : '') + '</div></div><button class="chip" data-act="ridel" data-i="' + n + '">Hapus</button></div>'; }).join('') || '<p class="muted">Belum ada bahan.</p>') +
    adder + '<div id="rfv"></div><button class="btn pri" data-act="rsave">Simpan resep</button>' + (f.id ? '<button class="btn sec" data-act="rdup" data-id="' + esc(f.id) + '">Duplikat resep ini</button><button class="btn dan" data-act="rdel">Hapus resep</button>' : ''));
  riRefresh(true); rfv();
}
function riRefresh(full) {
  const mm = mById(S.ri.m), a = unitAlt(mm); if (!$('#ri_m')) return;
  if (full) {
    if (S.ri.u === 'sub' && !a) S.ri.u = 'main'; $('#ri_uw').style.display = a ? '' : 'none';
    $('#ri_u').innerHTML = '<option value="main"' + (S.ri.u === 'main' ? ' selected' : '') + '>' + esc(mm ? mm.satuan : '') + '</option>' + (a ? '<option value="sub"' + (S.ri.u === 'sub' ? ' selected' : '') + '>' + esc(a.n) + '</option>' : '');
    $('#ri_l').textContent = 'Jumlah per batch (' + (S.ri.u === 'sub' && a ? a.n : (mm ? mm.satuan : '')) + ')';
    $('#ri_ch').innerHTML = (S.ri.u === 'sub' && a ? [50, 100, 250, 500] : [0.1, 0.25, 0.5, 1]).map(x => '<button class="chip" data-act="riq" data-q="' + x + '">' + dec(x) + '</button>').join('');
  }
  const q = N(S.ri.q); let h = ''; if (q > 0 && mm) { const main = S.ri.u === 'sub' && a ? q / a.f : q; h = '= ' + fmtQ(r6(main), mm) + ' per batch'; if (Number(mm.hpp_rata2) > 0) h += ' · biaya ' + rp(main * Number(mm.hpp_rata2)); } $('#ri_h').textContent = h;
}
function rfv() {
  const el = $('#rfv'); if (!el) return; const f = S.rf, q = N(f.hasil_standar);
  if (!f.items.length || !(q > 0)) { el.innerHTML = '<p class="muted">Tambahkan bahan dan isi hasil standar untuk melihat estimasi HPP.</p>'; return; }
  const c = costOf(f.items, {tenaga_kerja: f.tenaga_kerja}, 1, q, '', ''), v = A.vById(f.variant_id), cur = v ? Number(v.hpp_rata2) || 0 : 0;
  el.innerHTML = '<div class="li" style="display:block"><b>Estimasi per batch</b>' + kv('Bahan baku', rp(c.bahan)) + kv('Kemasan', rp(c.kem)) + kv('Tenaga kerja', rp(c.tk)) + kv('Overhead', rp(c.oh)) + kv('HPP per unit (estimasi)', rp(c.hpp), 'big') + kv('HPP produk saat ini', rp(cur)) +
    '<p class="muted">HPP dan stok berubah otomatis saat produksi diselesaikan, bukan saat resep disimpan.</p>' + (v && Number(v.stok) >= 0 ? '<button class="btn sec sm" data-act="rhpp">Pakai estimasi sebagai HPP awal produk</button>' : '') + '</div>';
}

/* ---------- Laporan ---------- */
const RTYPES_ALL = [['labarugi', 'Laba rugi'], ['penjualan', 'Penjualan'], ['channel', 'Channel'], ['hpp', 'HPP & margin'], ['stok', 'Stok & nilai'], ['produksi', 'Produksi'], ['pembelian', 'Pembelian'], ['pengeluaran', 'Biaya']];
/* F7: jenis laporan mengikuti peran (sama dengan rpc_report_legacy): tanpa akses biaya, laba rugi dan HPP disembunyikan. */
const rtypes = () => RTYPES_ALL.filter(t => A.can('cost') || ['labarugi', 'hpp'].indexOf(t[0]) < 0);
const PRE = [['today', 'Hari ini'], ['yday', 'Kemarin'], ['7d', '7 hari'], ['month', 'Bulan ini'], ['lmonth', 'Bulan lalu'], ['custom', 'Custom']];
S.rpre = 'month';
function setPreset() {
  const t = A.today();
  if (S.rpre === 'today') { S.rfrom = S.rto = t; } else if (S.rpre === 'yday') { S.rfrom = S.rto = A.addDays(t, -1); } else if (S.rpre === '7d') { S.rfrom = A.addDays(t, -6); S.rto = t; }
  else if (S.rpre === 'month') { S.rfrom = t.slice(0, 8) + '01'; S.rto = t; } else if (S.rpre === 'lmonth') { S.rfrom = ymd(new Date(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 2, 1)); S.rto = ymd(new Date(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1, 0)); }
}
function vLaporan(skipRun) {
  const RTYPES = rtypes(); if (!RTYPES.some(t => t[0] === S.rt)) S.rt = RTYPES[0][0];
  const noDate = ['stok', 'hpp'].indexOf(S.rt) >= 0, tabs = RTYPES.map(t => '<button class="chip ' + (S.rt === t[0] ? 'on' : '') + '" data-act="rt" data-t="' + t[0] + '">' + t[1] + '</button>').join('');
  $('#main').innerHTML = '<button class="chip" data-act="tab" data-t="menu">← Menu</button><div class="rt-chips" style="margin-top:8px">' + wrapChips(tabs) + '</div>' +
    '<label class="rt-sel" style="margin-top:8px">Jenis laporan<select class="inp" data-chg="rtsel">' + RTYPES.map(t => '<option value="' + t[0] + '"' + (S.rt === t[0] ? ' selected' : '') + '>' + t[1] + '</option>').join('') + '</select></label>' +
    (noDate ? '' : wrapChips(PRE.map(p => '<button class="chip ' + (S.rpre === p[0] ? 'on' : '') + '" data-act="rpre" data-p="' + p[0] + '">' + p[1] + '</button>').join('')) + '<p class="muted rcap">' + esc(idRange(S.rfrom, S.rto)) + '</p>' +
      (S.rpre === 'custom' ? '<div class="row2"><div style="flex:1"><label>Dari<input type="date" class="inp" data-rg="rfrom" value="' + S.rfrom + '"></label></div><div style="flex:1"><label>Sampai<input type="date" class="inp" data-rg="rto" value="' + S.rto + '"></label></div></div><button class="btn pri" data-act="rrun" style="margin-top:0">Tampilkan</button>' : '')) + '<div id="rres" style="margin-top:10px"></div>';
  if (!skipRun) runReport();
}
function fmtCell(v, f) { return f === 'rp' ? rp(v) : f === 'num' ? dec(v) : f === 'pct' ? pct(v) : esc(v); }
function runReport() {
  const el = $('#rres'); if (!el) return; el.innerHTML = skel(4); const want = S.rt;
  A.vload('report.get', {type: want, from: S.rfrom, to: S.rto}, r => {
    if (S.tab !== 'laporan' || S.rt !== want || !$('#rres')) return; S.rres = r;
    const mgHpp = !A.can('cost') ? {} : r.type === 'penjualan' ? {7: 5} : r.type === 'hpp' ? {6: 5, 7: 5} : {}, cell = (row, i, v) => (mgHpp[i] !== undefined && !(Number(row[mgHpp[i]]) > 0)) ? qMark : (v === '' || v == null) && r.fmt[i] !== 'txt' ? '-' : fmtCell(v, r.fmt[i]); // margin tanpa HPP tampil ?; kolom angka kosong tampil -
    $('#rres').innerHTML = '<div id="hppw"></div><b>' + esc(r.title) + '</b> <span class="muted">' + (['stok', 'hpp'].indexOf(want) >= 0 ? 'kondisi saat ini' : esc(idRange(r.from, r.to))) + '</span>' +
      (r.peringatan ? '<div class="warn-b" role="alert"><div><b>Perhatian:</b> ' + esc(r.peringatan) + '</div></div>' : '') +
      (r.summary.length ? '<div class="kgrid" style="margin-top:8px">' + r.summary.map(s => kpi(esc(s.label), /^Margin/.test(s.label) ? '<span class="mgv" data-v="' + s.value + '">' + fmtCell(s.value, s.fmt) + '</span>' : fmtCell(s.value, s.fmt), '')).join('') + '</div>' : '') +
      (r.rows.length ? '<div class="tw"><table><thead><tr>' + r.columns.map((c, i) => '<th class="' + (r.fmt[i] === 'txt' ? '' : 'n') + '">' + esc(c) + '</th>').join('') + '</tr></thead><tbody>' +
        r.rows.map(row => '<tr>' + row.map((v, i) => '<td class="' + (r.fmt[i] === 'txt' ? '' : 'n') + '">' + cell(row, i, v) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>' :
        emptyState('laporan', 'Tidak ada data', 'Belum ada data pada periode ini. Pilih periode lain.', '')) +
      '<div class="row2"><button class="btn sec" data-act="rcsv">Unduh CSV</button><button class="btn sec" data-act="rwa">Bagikan WhatsApp</button></div>';
    const show = v => { if (!v.n || !$('#hppw')) return; $('#hppw').innerHTML = warnBanner(v); document.querySelectorAll('.mgv').forEach(e => { if (Number(e.dataset.v) >= 99.5) e.innerHTML = qMark; }); };
    if (!A.can('cost')) return; if (r.type === 'penjualan' || r.type === 'hpp') show(hppOf(r.rows)); else if (r.type === 'labarugi' || r.type === 'channel') hppCheck(r.from, r.to).then(show).catch(() => {});
  }, {fail: e => { if ($('#rres')) $('#rres').innerHTML = '<p class="err">' + esc(e.message) + '</p>'; }});
}
function csvText(r) { const q = x => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"'; return [r.columns.map(q).join(',')].concat(r.rows.map(row => row.map(q).join(','))).join('\r\n'); }
function download(name, text) { try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\uFEFF' + text], {type: 'text/csv;charset=utf-8'})); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); } catch (e) { toast('Unduh tidak didukung di perangkat ini'); } }
function reportText(r) { return [(set('nama_usaha') || 'Duado Snack') + ' - ' + r.title, r.from + ' s/d ' + r.to].concat(r.summary.map(s => s.label + ': ' + fmtCell(s.value, s.fmt)), r.rows.slice(0, 12).map(row => row.map((v, i) => r.fmt[i] === 'txt' ? v : fmtCell(v, r.fmt[i])).join(' | '))).join('\n'); }

/* ---------- Impor Shopee (CSV) ---------- */
const SM = [['order', 'No. pesanan', [/no\.?\s*pesanan/i, /order\s*(id|sn|no)/i, /nomor\s*pesanan/i]], ['sku', 'SKU (harus sama dengan SKU varian)', [/nomor referensi sku/i, /sku variasi|variation sku/i, /sku/i]], ['qty', 'Jumlah', [/^jumlah$/i, /quantity|^qty$/i, /jumlah/i]],
  ['harga', 'Harga satuan (opsional)', [/harga setelah diskon/i, /price after/i, /harga satuan|unit price/i, /harga awal/i]], ['tanggal', 'Tanggal pesanan (opsional)', [/waktu pesanan dibuat/i, /order creation/i, /waktu pesanan|tanggal/i]], ['status', 'Status (opsional)', [/status pesanan|order status/i, /^status/i]]];
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, ''); const first = text.split(/\r?\n/, 1)[0], d = [',', ';', '\t'].map(c => [c, first.split(c).length]).sort((a, b) => b[1] - a[1])[0][0], rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === d) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; rows.push(row); row = []; } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); } return rows.filter(r => r.some(x => String(x).trim() !== ''));
}
function parseNum(s) {
  s = String(s == null ? '' : s).replace(/[^\d.,-]/g, ''); if (!s) return NaN; const hc = s.indexOf(',') >= 0, hd = s.indexOf('.') >= 0;
  if (hc && hd) { s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, ''); }
  else if (hc) s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, ''); else if (hd && (/\.\d{3}$/.test(s) || (s.match(/\./g) || []).length > 1)) s = s.replace(/\./g, '');
  return Number(s);
}
function normDate(s) {
  s = String(s || '').trim(); let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/); if (m) return m[1] + '-' + m[2] + '-' + m[3] + ' ' + p2(m[4]) + ':' + m[5] + ':' + (m[6] || '00');
  m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/); if (m) return m[3] + '-' + p2(m[2]) + '-' + p2(m[1]) + ' ' + p2(m[4] || 0) + ':' + (m[5] || '00') + ':' + (m[6] || '00');
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? s + ' 12:00:00' : '';
}
function shLoad(text) {
  const rows = parseCSV(text); if (rows.length < 2) { toast('File CSV kosong atau tidak terbaca'); return; }
  const header = rows[0].map(x => String(x).trim()), map = {};
  SM.forEach(m => { let idx = -1; for (const re of m[2]) { idx = header.findIndex(h => re.test(h)); if (idx >= 0) break; } map[m[0]] = idx; });
  S.sh = {header: header, data: rows.slice(1), map: map}; S.shRes = null; vShopee();
}
function shBuild() {
  const m = S.sh.map, skip = /batal|cancel|belum dibayar|unpaid|dikembalikan|return/i, g = {}, orders = []; let skipped = 0, bad = 0;
  S.sh.data.forEach(r => {
    const id = String(r[m.order] || '').trim(), sku = String(r[m.sku] || '').trim(), qty = parseNum(r[m.qty]);
    if (m.status >= 0 && skip.test(String(r[m.status] || ''))) { skipped++; return; }
    if (!id || !sku || !(qty > 0)) { bad++; return; }
    if (!g[id]) { g[id] = {order_id: id, tanggal: m.tanggal >= 0 ? normDate(r[m.tanggal]) : '', items: []}; orders.push(g[id]); }
    const h = m.harga >= 0 ? parseNum(r[m.harga]) : NaN; g[id].items.push({sku: sku, qty: qty, harga: isNaN(h) ? '' : h});
  });
  return {orders: orders, skipped: skipped, bad: bad};
}
function vShopee() {
  const sh = S.sh, res = S.shRes;
  let h = '<button class="chip" data-act="tab" data-t="menu">← Menu</button><div class="li" style="display:block;margin-top:8px"><b>Impor pesanan Shopee</b><p class="muted">Ekspor pesanan dari Shopee Seller Centre, simpan sebagai <b>CSV (UTF-8)</b>, lalu pilih file di bawah. Pesanan diberi tanggal asli dan memotong stok. Aman diimpor ulang: pesanan yang sudah masuk dilewati.</p><input type="file" id="shfile" accept=".csv,.txt,text/csv" class="inp" style="padding-top:10px"></div>';
  if (sh) {
    const opts = (cur) => '<option value="-1">(tidak ada)</option>' + sh.header.map((x, i) => '<option value="' + i + '"' + (i === cur ? ' selected' : '') + '>' + esc(x) + '</option>').join('');
    const b = shBuild();
    h += '<div class="li" style="display:block"><b>Petakan kolom</b>' + SM.map(m => '<label>' + m[1] + '<select class="inp" data-sm="' + m[0] + '">' + opts(sh.map[m[0]]) + '</select></label>').join('') + '</div>' +
      '<div class="li" style="display:block">' + kv('Baris data', num(sh.data.length)) + kv('Pesanan siap impor', num(b.orders.length)) + kv('Dilewati (batal/belum bayar)', num(b.skipped)) + kv('Baris tidak lengkap', num(b.bad)) + '<label style="margin-top:8px"><input type="checkbox" id="sh_ign" checked> Abaikan stok kurang (pesanan sudah terjadi di Shopee)</label></div>' +
      '<button class="btn pri" data-act="shgo"' + (b.orders.length ? '' : ' disabled') + '>Impor ' + num(b.orders.length) + ' pesanan</button>';
  }
  if (res) h += '<div class="li" style="display:block"><b>Hasil impor</b>' + kv('Berhasil', num(res.ok)) + kv('Sudah ada (dilewati)', num(res.duplikat)) + kv('Gagal', num(res.gagal.length)) + res.gagal.slice(0, 15).map(g => '<div class="muted">• ' + esc(g.order_id) + ': ' + esc(g.error) + '</div>').join('') + (res.gagal.length > 15 ? '<div class="muted">… dan ' + (res.gagal.length - 15) + ' lainnya</div>' : '') + '</div>';
  $('#main').innerHTML = h;
}
async function shGo() {
  const b = shBuild(); if (!b.orders.length) return toast('Tidak ada pesanan yang bisa diimpor'); const tot = {ok: 0, duplikat: 0, gagal: []}, ign = $('#sh_ign').checked;
  await busy('Mengimpor 0/' + b.orders.length + ' pesanan…', async () => {
    for (let i = 0; i < b.orders.length; i += 20) {
      const chunk = b.orders.slice(i, i + 20);
      try { const r = await api('shopee.import', {orders: chunk, abaikan_stok: ign}); tot.ok += r.ok; tot.duplikat += r.duplikat; tot.gagal = tot.gagal.concat(r.gagal); }
      catch (e) { chunk.forEach(o => tot.gagal.push({order_id: o.order_id, error: e.message})); if (e.auth) break; }
      A.busyLabel('Mengimpor ' + Math.min(i + 20, b.orders.length) + '/' + b.orders.length + ' pesanan…');
    }
    try { await A.loadData(); } catch (e) {}
  });
  S.shRes = tot; S.sh = null; vShopee(); toast('Impor selesai');
}

/* ---------- Pemeriksaan data: kelengkapan master dan kesesuaian stok dengan riwayat ---------- */
const priceOf = (vid, cid) => { const x = S.data.prices.find(p => p.variant_id === vid && p.channel_id === cid); return x ? Number(x.harga_jual) : null; };
function checks() {
  const d = S.data, out = [], add = (lv, title, items, go, hint, extra) => { if (items.length) out.push({lv: lv, title: title, items: items, go: go, hint: hint, extra: extra || ''}); };
  const hasV = new Set(d.variants.map(v => v.product_id)), usedMat = new Set(d.recipe_items.map(i => i.material_id)), matIds = new Set(d.materials.map(m => m.id));
  const withPrice = new Set(d.prices.map(p => p.channel_id)), skuCount = {};
  d.variants.forEach(v => { const k = String(v.sku || '').trim().toLowerCase(); if (k) skuCount[k] = (skuCount[k] || 0) + 1; });
  add('err', 'Produk belum punya varian (tidak tampil di Kasir)', d.products.filter(p => !hasV.has(p.id)).map(p => p.nama), 'product_variants', 'Tambahkan varian (ukuran dan level pedas).');
  add('err', 'Varian belum punya harga jual di channel mana pun', d.variants.filter(v => !d.channels.some(c => priceOf(v.id, c.id) != null)).map(vLabel2), 'channel_prices', 'Isi di Data Master, Harga jual.');
  add('info', 'Varian belum punya harga di channel yang sudah dipakai produk lain', d.variants.flatMap(v => d.channels.filter(c => withPrice.has(c.id) && priceOf(v.id, c.id) == null && d.channels.some(x => priceOf(v.id, x.id) != null)).map(c => vLabel2(v) + ' → ' + c.nama)), 'channel_prices', 'Abaikan jika memang tidak dijual di channel itu.');
  add('err', 'SKU ganda (merusak impor Shopee dan pencarian)', d.variants.filter(v => skuCount[String(v.sku || '').trim().toLowerCase()] > 1).map(vLabel2), 'product_variants', 'Setiap varian harus punya SKU unik.');
  add('err', 'Resep memakai bahan yang sudah dihapus', d.recipes.filter(r => d.recipe_items.some(i => i.recipe_id === r.id && !matIds.has(i.material_id))).map(r => r.nama), 'resep', 'Ganti bahan di resep.');
  add('err', 'Bahan dipakai resep tetapi HPP masih 0 (HPP produksi tidak akurat)', d.materials.filter(m => usedMat.has(m.id) && !(Number(m.hpp_rata2) > 0)).map(m => m.nama), 'stok', 'Isi lewat Pembelian bahan atau Penyesuaian stok (HPP awal).');
  add('info', 'Varian belum punya resep (belum bisa diproduksi dari aplikasi)', d.variants.filter(v => !d.recipes.some(r => r.variant_id === v.id)).map(vLabel2), 'resep', 'Abaikan untuk produk yang tidak diproduksi sendiri.');
  add('info', 'Varian dengan HPP 0 (laba kotor dan margin belum akurat)', d.variants.filter(v => !(Number(v.hpp_rata2) > 0)).map(vLabel2), 'stok', 'Isi HPP awal lewat Stok, atau selesaikan satu produksi.');
  add('info', 'Produk tanpa kategori', d.products.filter(p => !String(p.kategori || '').trim()).map(p => p.nama), 'products', '');
  return out;
}
const vLabel2 = v => typeof v === 'string' ? v : A.vName(v) + ' ' + A.vSub(v);
function vCek() {
  const c = checks(), err = c.filter(x => x.lv === 'err').length;
  $('#main').innerHTML = '<button class="chip" data-act="tab" data-t="menu">← Menu</button><div class="li" style="display:block;margin-top:8px"><b>Pemeriksaan data</b><p class="muted">Mengecek kelengkapan data master di perangkat ini (sesuai data terakhir yang dimuat). ' + (c.length ? err + ' hal perlu diperbaiki, ' + (c.length - err) + ' catatan.' : 'Semua data lengkap.') + '</p></div>' +
    c.map(x => '<div class="li" style="display:block"><div class="kv"><b>' + esc(x.title) + '</b><span class="tag ' + (x.lv === 'err' ? 'red' : '') + '">' + (x.lv === 'err' ? 'Perbaiki' : 'Info') + ' · ' + x.items.length + '</span></div>' +
      '<div class="muted">' + x.items.slice(0, 8).map(esc).join(', ') + (x.items.length > 8 ? ' dan ' + (x.items.length - 8) + ' lainnya' : '') + '</div>' + (x.hint ? '<div class="muted">' + esc(x.hint) + '</div>' : '') +
      '<div style="margin-top:6px">' + x.extra + '<button class="chip" data-act="cekgo" data-t="' + x.go + '">Buka</button></div></div>').join('') +
    '<div class="li" style="display:block"><b>Kesesuaian stok</b><p class="muted">Membandingkan stok setiap item dengan jumlah riwayat mutasinya di server. Selisih berarti ada perubahan stok di luar aplikasi (misalnya diedit langsung di Google Sheets).</p><button class="btn sec" data-act="caudit" style="margin-top:0">Periksa stok sekarang</button><div id="caud"></div></div>';
}
async function stockAudit() {
  const el = $('#caud'); el.innerHTML = skel(2);
  try {
    const r = await api('stock.audit', {}); if (!$('#caud')) return;
    $('#caud').innerHTML = '<p class="muted">' + num(r.diperiksa) + ' item diperiksa.</p>' + (r.selisih.length ? r.selisih.map(x => '<div class="li" style="display:block"><div class="kv"><b>' + esc(x.nama) + '</b><span class="tag red">Selisih ' + dec(x.selisih) + '</span></div><div class="muted">Stok tercatat ' + dec(x.stok) + ' · menurut riwayat ' + dec(x.riwayat) + '</div>' +
      '<button class="chip" data-act="creco" data-t="' + x.tipe + '" data-id="' + esc(x.id) + '">Terima stok tercatat</button> <button class="chip" data-act="adj" data-t="' + x.tipe + '" data-id="' + esc(x.id) + '">Hitung ulang (opname)</button></div>').join('') : '<p style="color:var(--ok);font-weight:800">Semua stok sesuai dengan riwayat.</p>') +
      (r.penjualan_proses && r.penjualan_proses.length ? '<div class="li" style="display:block"><div class="kv"><b>Transaksi tersangkut (status proses)</b><span class="tag red">' + r.penjualan_proses.length + '</span></div><div class="muted">Penulisan terhenti di tengah. Selesaikan bila datanya lengkap, atau batalkan.</div>' + r.penjualan_proses.map(x => '<div class="kv" style="margin-top:6px"><span>' + esc(x.nomor) + ' · ' + esc(x.tanggal) + ' · ' + rp(x.total) + '</span><span><button class="chip" data-act="srec" data-a="selesai" data-id="' + esc(x.id) + '">Selesaikan</button> <button class="chip" data-act="srec" data-a="batal" data-id="' + esc(x.id) + '">Batalkan</button></span></div>').join('') + '</div>' : '') +
      (r.selisih_total && r.selisih_total.length ? '<div class="li" style="display:block"><div class="kv"><b>Total struk berbeda dari server</b><span class="tag red">' + r.selisih_total.length + '</span></div><div class="muted">' + r.selisih_total.map(x => esc(x.nomor) + ' (struk ' + rp(x.total_klien) + ', server ' + rp(x.total) + ')').join(', ') + '</div></div>' : '') +
      (r.penjualan_tanpa_item && r.penjualan_tanpa_item.length ? '<div class="li" style="display:block"><div class="kv"><b>Penjualan tanpa rincian item</b><span class="tag red">' + r.penjualan_tanpa_item.length + '</span></div><div class="muted">' + r.penjualan_tanpa_item.map(x => esc(x.nomor) + ' (' + rp(x.total) + ')').join(', ') + '</div><div class="muted">Transaksi ini tersimpan setengah. Periksa tab sales dan sale_items di Google Sheets.</div></div>' : '<p class="muted">Tidak ada penjualan tanpa rincian item.</p>');
  } catch (e) { if ($('#caud')) $('#caud').innerHTML = '<p class="err">' + esc(e.message) + '</p>'; }
}

/* ---------- Aksi ---------- */
Object.assign(ACT, {
  caudit: stockAudit, cekgo: el => { const t = el.dataset.t; if (t === 'resep' || t === 'stok') S.tab = t; else { S.mt = t; S.tab = 'master'; } A.render(); },
  srec: el => busy('Memproses…', async () => { try { await api('sale.recover', {id: el.dataset.id, aksi: el.dataset.a}); await A.loadData(); toast(el.dataset.a === 'selesai' ? 'Transaksi diselesaikan' : 'Transaksi dibatalkan'); stockAudit(); } catch (e) { toast(e.message); } }),
  creco: el => busy('Menyelaraskan riwayat…', async () => { try { await api('stock.reconcile', {tipe: el.dataset.t, id: el.dataset.id}); toast('Riwayat disesuaikan'); stockAudit(); } catch (e) { toast(e.message); } }),
  dp: el => { const again = el.dataset.p === S.dp; S.dp = el.dataset.p; vDash(again); },
  bar: el => { const s = (S.dser || [])[Number(el.dataset.i)], bt = $('#bt'); if (!s || !bt) return; bt.innerHTML = '<b>' + esc(idDate(s.d)) + '</b> · Omzet <b>' + rp(s.omzet) + '</b> · Laba kotor <b>' + rp(s.laba) + '</b>'; document.querySelectorAll('.bchart [data-b]').forEach(r => { r.style.opacity = r.dataset.b === el.dataset.i ? 1 : .35; }); },
  rpre: el => { S.rpre = el.dataset.p; if (S.rpre !== 'custom') setPreset(); vLaporan(S.rpre === 'custom'); },
  pnew: prodNew, pjenis: el => { S.pform.jenis = el.dataset.j; prodNew(); },
  psave: () => busy('Menyimpan rencana…', async () => { try { await api('production.create', {recipe_id: S.pform.recipe, jumlah_batch: N(S.pform.batch), jenis: S.pform.jenis, catatan: S.pform.catatan}); closeSheet(); toast('Rencana produksi tersimpan'); vProduksi(); } catch (e) { toast(e.message); } }),
  pdetail: el => prodDetail(el.dataset.id), pdone: el => prodDone(el.dataset.id),
  pcancel: el => { if (!confirm('Batalkan rencana produksi ini?')) return; return busy('Membatalkan…', async () => { try { await api('production.cancel', {id: el.dataset.id}); closeSheet(); vProduksi(); } catch (e) { toast(e.message); } }); },
  pdosave: () => busy('Menyelesaikan produksi…', async () => {
    try {
      const r = await api('production.complete', {id: S.pd.id, qty_hasil: N(S.pd.qty), tenaga_kerja: S.pd.tk === '' ? '' : N(S.pd.tk), overhead: S.pd.oh === '' ? '' : N(S.pd.oh)});
      r.materials.forEach(u => { const m = mById(u.id); if (m) m.stok = u.stok; }); const v = A.vById(r.variant.id); if (v) { v.stok = r.variant.stok; v.hpp_rata2 = r.variant.hpp_rata2; }
      LS.set('data', S.data); closeSheet(); toast('Produksi selesai. HPP per unit ' + rp(r.costs.hpp_per_unit)); vProduksi();
    } catch (e) { toast(e.message); }
  }),
  redit: el => redit(el.dataset.id),
  rdup: el => dupSheet(el.dataset.id),
  dpsave: () => { const ids = Object.keys(S.dp2.sel).filter(k => S.dp2.sel[k]); if (!ids.length) return toast('Pilih minimal satu varian tujuan');
    return busy('Membuat salinan resep…', async () => { try { const r = await api('recipe.copy', {source_id: S.dp2.src, targets: ids.map(id => ({variant_id: id, nama: dupName(A.vById(id))}))}); await A.loadData(); closeSheet(); A.render(); toast(r.dibuat.length + ' resep dibuat. Periksa jumlah bahan tiap varian.'); } catch (e) { toast(e.message); } }); },
  riadd: () => {
    const mm = mById(S.ri.m), a = unitAlt(mm); let q = N(S.ri.q);
    if (!mm) return toast('Pilih bahan terlebih dahulu'); if (!(q > 0)) return toast('Isi jumlah lebih dari 0. Boleh desimal, mis. 0,5');
    if (S.ri.u === 'sub' && a) q = q / a.f; q = r6(q); const ex = S.rf.items.find(i => i.material_id === mm.id);
    if (ex) ex.qty = r6(ex.qty + q); else S.rf.items.push({material_id: mm.id, qty: q}); S.ri.q = ''; S.ri.u = 'main'; rfSheet(); toast(mm.nama + ' ditambahkan');
  },
  riq: el => { S.ri.q = String(el.dataset.q).replace('.', ','); const i = $('#ri_q'); if (i) i.value = S.ri.q; riRefresh(false); },
  rimat: () => { closeSheet(); S.mt = 'materials'; S.tab = 'master'; A.render(); },
  rhpp: () => { const f = S.rf, v = A.vById(f.variant_id), c = costOf(f.items, {tenaga_kerja: f.tenaga_kerja}, 1, N(f.hasil_standar), '', ''); if (!v || !confirm('Set HPP produk menjadi ' + rp(c.hpp) + ' (stok tidak berubah)?')) return;
    return busy('Menyimpan HPP…', async () => { try { const r = await api('stock.adjust', {tipe: 'varian', id: v.id, stok_baru: Number(v.stok) || 0, hpp: Math.round(c.hpp * 100) / 100, alasan: 'HPP awal dari estimasi resep'}); v.hpp_rata2 = r.hpp_rata2; LS.set('data', S.data); rfv(); toast('HPP produk diperbarui'); } catch (e) { toast(e.message); } }); },
  ridel: el => { S.rf.items.splice(el.dataset.i, 1); rfSheet(); },
  rsave: () => busy('Menyimpan resep…', async () => { try { const f = S.rf; const rr = await api('recipe.save', {id: f.id || undefined, variant_id: f.variant_id, nama: f.nama, hasil_standar: N(f.hasil_standar), jenis: f.jenis, tenaga_kerja: N(f.tenaga_kerja) || 0, items: f.items}); if (!A.patchRecipe(rr)) await A.loadData(); closeSheet(); A.render(); toast('Resep tersimpan'); } catch (e) { toast(e.message); } }),
  rdel: () => { if (!confirm('Hapus resep ini?')) return; return busy('Menghapus…', async () => { try { await api('master.remove', {table: 'recipes', id: S.rf.id}); await A.loadData(); closeSheet(); A.render(); } catch (e) { toast(e.message); } }); },
  rt: el => { S.rt = el.dataset.t; vLaporan(); }, rrun: runReport,
  rcsv: () => S.rres && download('laporan-' + S.rres.type + '-' + S.rres.to + '.csv', csvText(S.rres)),
  rwa: () => S.rres && window.open('https://wa.me/?text=' + encodeURIComponent(reportText(S.rres)), '_blank'),
  shgo: shGo
});
document.addEventListener('input', e => {
  const t = e.target, d = t.dataset || {};
  if (d.pf) { S.pform[d.pf] = t.value; if (d.pf === 'recipe' || d.pf === 'batch') pv(); }
  else if (d.pd) { S.pd[d.pd] = t.value; pdv(); }
  else if (d.rf) { S.rf[d.rf] = t.value; if (d.rf === 'hasil_standar' || d.rf === 'tenaga_kerja' || d.rf === 'variant_id') rfv(); }
  else if (d.dp) { S.dp2[d.dp] = t.value; dupUpd(); }
  else if (d.dv) { S.dp2.sel[d.dv] = t.checked; dupUpd(); }
  else if (d.ri) { S.ri[d.ri] = t.value; if (d.ri === 'm') S.ri.u = 'main'; riRefresh(d.ri !== 'q'); }
  else if (d.rg) S[d.rg] = t.value;
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'shfile' && t.files && t.files[0]) { const f = t.files[0]; (f.text ? f.text() : new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsText(f); })).then(shLoad); }
  else if (t.dataset && t.dataset.sm) { S.sh.map[t.dataset.sm] = Number(t.value); vShopee(); }
  else if (t.dataset && t.dataset.chg === 'rtsel') { S.rt = t.value; vLaporan(); }
});
A.issueCount = () => { try { return checks().filter(x => x.lv === 'err').length; } catch (e) { return 0; } };
Object.assign(A.views, {dash: vDash, produksi: vProduksi, resep: vResep, laporan: vLaporan, shopee: vShopee, cek: vCek});
Object.assign(A, {shopeeText: shLoad, parseCSV: parseCSV, parseNum: parseNum, normDate: normDate});
A.start();
})();
