#!/usr/bin/env node
// Pembanding manifest cadangan (sumber) dengan manifest database hasil pemulihan (target). Bagian 3.7 B2 di Framework-Efisiensi-End-to-End.md.
// Tanpa dependensi. Semua uang dan kuantitas dibandingkan sebagai DESIMAL EXACT (BigInt), bukan float: selisih Rp 0,01 pun terdeteksi.
//
//   node tools/restore_verify.js --sumber manifest.json --target target.json [--skema public,app] [--ketat] [--json]
//     --skema   skema yang ikut dipulihkan (bawaan: public,app). Tabel skema lain tidak dibandingkan.
//     --ketat   pemulihan sah hanya bila integrity_check di target NOL temuan (bukan sekadar tidak menambah temuan milik sumber).
// Kode keluar: 0 sah, 1 tidak sah, 2 salah pakai.
//
// Aturan putusan (dinyatakan terbuka, bukan disembunyikan):
//   - TIDAK SAH bila: ada selisih baris/hash tabel, selisih total kendali (satu rupiah atau satu satuan), sidik jari hak akses/RLS atau STRUKTUR (FK, indeks, trigger, kolom, fungsi) berbeda,
//     atau integrity_check di target menemukan LEBIH BANYAK pelanggaran daripada yang tercatat di sumber saat dicadangkan.
//   - Temuan integritas yang SUDAH ada di sumber (mis. data lama tanpa ledger) tidak membuat pemulihan tidak sah, tetapi ditampilkan sebagai
//     "SAH, dengan N temuan bawaan sumber" dan BUKAN "bersih". Pakai --ketat bila Anda ingin nol mutlak.
'use strict';

/* ---------- desimal exact ---------- */
function parseDec(s) {
  if (s === null || s === undefined) return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(s).trim());
  if (!m) return null;
  return {neg: m[1] === '-', int: m[2], frac: m[3] || ''};
}
function toScaled(d, scale) { // BigInt dalam satuan 10^-scale
  const frac = (d.frac + '0'.repeat(scale)).slice(0, scale);
  const v = BigInt(d.int + frac);
  return d.neg ? -v : v;
}
function fmtScaled(v, scale) {
  const neg = v < 0n; let s = (neg ? -v : v).toString();
  if (scale > 0) { s = s.padStart(scale + 1, '0'); s = s.slice(0, -scale) + '.' + s.slice(-scale); s = s.replace(/\.?0+$/, ''); }
  return (neg ? '-' : '') + (s === '' ? '0' : s);
}
/** a - b sebagai teks desimal exact; null bila salah satu bukan angka. */
function decDiff(a, b) {
  const x = parseDec(a), y = parseDec(b); if (!x || !y) return null;
  const sc = Math.max(x.frac.length, y.frac.length);
  return fmtScaled(toScaled(x, sc) - toScaled(y, sc), sc);
}
const absDec = s => (s && s[0] === '-' ? s.slice(1) : s);
function decGt(a, b) { const d = decDiff(a, b); return d !== null && d !== '0' && d[0] !== '-'; }

const MONEY_KEYS = new Set(['total', 'subtotal', 'diskon', 'ppn', 'fee_channel', 'hpp', 'jumlah_baris', 'jumlah_harga', 'jumlah_biaya', 'bahan', 'kemasan',
  'tenaga_kerja', 'overhead', 'ongkir', 'nilai', 'jumlah']);

/* ---------- perbandingan ---------- */
function leaves(o, path, out) {
  if (o !== null && typeof o === 'object' && !Array.isArray(o)) { Object.keys(o).forEach(k => leaves(o[k], path.concat(k), out)); if (!Object.keys(o).length) out[path.join('.')] = '{}'; }
  else out[path.join('.')] = o === null || o === undefined ? null : String(o);
  return out;
}

function compare(src, tgt, opt) {
  opt = opt || {};
  const skema = new Set(opt.skema || ['public', 'app']);
  const diffs = [], notes = []; const stat = {tabel: 0, baris_beda: 0, hash_beda: 0, kendali: 0, kendali_beda: 0, uangMax: '0', qtyMax: '0'};
  const add = (kind, msg, extra) => diffs.push(Object.assign({kind, msg}, extra || {}));

  // 1. migrasi
  if (src.migrasi_terakhir !== tgt.migrasi_terakhir) {
    const m = 'Versi migrasi terakhir berbeda: sumber ' + src.migrasi_terakhir + ', target ' + tgt.migrasi_terakhir;
    if (skema.has('supabase_migrations')) add('migrasi', m); else notes.push(m + ' (supabase_migrations tidak ikut dipulihkan, tidak dibandingkan)');
  }

  // 2. tabel
  const st = src.tabel || {}, tt = tgt.tabel || {};
  Object.keys(st).sort().forEach(k => {
    if (!skema.has(k.split('.')[0])) return;
    stat.tabel++;
    const a = st[k], b = tt[k];
    if (!b) { add('tabel', 'Tabel ' + k + ' tidak ada di target', {tabel: k}); return; }
    if (a.baris === null || a.baris === undefined || b.baris === null || b.baris === undefined) { notes.push('Tabel ' + k + ' tidak dapat dihitung di salah satu sisi (hak akses); tidak dibandingkan'); return; }
    if (Number(a.baris) !== Number(b.baris)) { stat.baris_beda++; add('baris', 'Jumlah baris ' + k + ': sumber ' + a.baris + ', target ' + b.baris, {tabel: k, sumber: a.baris, target: b.baris}); }
    else if (a.hash && b.hash && a.hash !== b.hash) { stat.hash_beda++; add('hash', 'Isi tabel ' + k + ' berbeda (jumlah baris sama, ' + a.baris + ', tetapi isinya tidak)', {tabel: k}); }
    else if ((a.hash && !b.hash) || (!a.hash && b.hash)) notes.push('Hash ' + k + ' hanya ada di satu sisi; tidak dibandingkan');
  });
  Object.keys(tt).sort().forEach(k => { if (skema.has(k.split('.')[0]) && !st[k]) add('tabel', 'Tabel ' + k + ' ada di target tetapi tidak ada di manifest sumber', {tabel: k}); });

  // 3. total kendali (exact)
  const ls = leaves(src.kendali || {}, [], {}), lt = leaves(tgt.kendali || {}, [], {});
  Object.keys(Object.assign({}, ls, lt)).sort().forEach(p => {
    stat.kendali++;
    const a = ls[p], b = lt[p];
    if (a === undefined || b === undefined) { stat.kendali_beda++; add('kendali', 'Kelompok kendali ' + p + ' hanya ada di ' + (a === undefined ? 'target' : 'sumber'), {jalur: p}); return; }
    if (a === b) return;
    const d = decDiff(b, a);   // target - sumber: positif = target lebih besar
    stat.kendali_beda++;
    const leaf = p.split('.').pop();
    if (d !== null) {
      const isMoney = MONEY_KEYS.has(leaf), key = isMoney ? 'uangMax' : 'qtyMax';
      if (leaf !== 'n' && decGt(absDec(d), stat[key])) stat[key] = absDec(d);
      add('kendali', 'Total kendali ' + p + ': sumber ' + a + ', target ' + b + ' (target-sumber ' + d + ')', {jalur: p, selisih: d, uang: isMoney});
    } else add('kendali', 'Total kendali ' + p + ': sumber ' + a + ', target ' + b, {jalur: p});
  });

  // 4. keamanan
  const ks = src.keamanan || {}, kt = tgt.keamanan || {};
  if (!src.keamanan) notes.push('Manifest sumber tidak memuat sidik jari hak akses; tidak dibandingkan');
  else Object.keys(ks).sort().forEach(k => { if (String(ks[k]) !== String(kt[k])) add('keamanan', 'Hak akses/RLS berbeda (' + k + '): sumber ' + ks[k] + ', target ' + kt[k] + '. Jalankan ulang pemulihan dengan hak (tanpa --no-privileges).', {kunci: k}); });
  // 5. struktur (konstrain/FK, indeks, trigger, kolom, isi fungsi)
  const strS = src.struktur || {}, strT = tgt.struktur || {};
  if (!src.struktur) notes.push('Manifest sumber tidak memuat sidik jari struktur (cadangan sebelum perbaikan ini); FK, indeks, dan trigger tidak dibandingkan');
  else Object.keys(strS).sort().forEach(k => { if (String(strS[k]) !== String(strT[k])) add('struktur', 'Struktur berbeda (' + k + '): sumber ' + strS[k] + ', target ' + strT[k] + '. Ada konstrain/indeks/trigger/kolom/fungsi yang tidak terpulihkan; lihat galat pg_restore.', {kunci: k}); });

  // 5. integrity_check
  const is = src.integritas, it = tgt.integritas; let ketat = null;
  if (!it || it.tersedia === false) add('integritas', 'integrity_check tidak dapat dijalankan di target' + (it && it.alasan ? ' (' + it.alasan + ')' : '') + '. Pemulihan tidak dapat dinyatakan sah.');
  else {
    const totT = Number(it.total_pelanggaran), totS = is && is.tersedia !== false ? Number(is.total_pelanggaran) : null;
    ketat = {sumber: totS, target: totT};
    if (totS === null) { notes.push('Manifest sumber tidak memuat hasil integrity_check; hanya nol mutlak yang dapat diterima'); if (totT > 0) add('integritas', 'integrity_check di target menemukan ' + totT + ' pelanggaran dan sumber tidak mencatat pembandingnya'); }
    else {
      Object.keys(it.outlet || {}).forEach(o => {
        const b = it.outlet[o], a = (is.outlet || {})[o];
        if (b.dilewati) return;
        if (!a || a.dilewati) { if (Number(b.pelanggaran) > 0) add('integritas', 'Outlet ' + o + ': ' + b.pelanggaran + ' pelanggaran di target; sumber tidak mencatat outlet ini', {outlet: o}); return; }
        Object.keys(b.per_kode || {}).forEach(c => { if (Number(b.per_kode[c]) > Number((a.per_kode || {})[c] || 0)) add('integritas', 'Outlet ' + o + ' ' + c + ': ' + b.per_kode[c] + ' pelanggaran di target, hanya ' + ((a.per_kode || {})[c] || 0) + ' di sumber (pemulihan menambah temuan)', {outlet: o, kode: c}); });
        if (Number(b.diperiksa) !== Number(a.diperiksa)) add('integritas', 'Outlet ' + o + ': jumlah baris diperiksa berbeda (sumber ' + a.diperiksa + ', target ' + b.diperiksa + ')', {outlet: o});
      });
      Object.keys(is.outlet || {}).forEach(o => { if (!(it.outlet || {})[o]) add('integritas', 'Outlet ' + o + ' ada di sumber tetapi tidak diperiksa di target', {outlet: o}); });
    }
    if (opt.ketat && totT > 0) add('integritas', 'Mode ketat: integrity_check di target menemukan ' + totT + ' pelanggaran (harus 0)');
  }

  const ok = diffs.length === 0;
  const bawaan = ketat && ketat.sumber !== null && ketat.target > 0 && ok ? ketat.target : 0;
  return {ok, bersih: ok && !bawaan, temuan_bawaan_sumber: bawaan, diffs, notes, stat, integritas: ketat,
    verdict: !ok ? 'TIDAK SAH' : bawaan ? 'SAH, dengan ' + bawaan + ' temuan integritas bawaan sumber (bukan bersih)' : 'SAH (bersih)'};
}

function report(r) {
  const L = [];
  L.push('Tabel dibandingkan: ' + r.stat.tabel + '  (baris berbeda: ' + r.stat.baris_beda + ', isi berbeda: ' + r.stat.hash_beda + ')');
  L.push('Total kendali dibandingkan: ' + r.stat.kendali + '  (berbeda: ' + r.stat.kendali_beda + ')');
  L.push('Selisih uang terbesar: Rp ' + r.stat.uangMax + '   Selisih kuantitas terbesar: ' + r.stat.qtyMax);
  if (r.integritas) L.push('integrity_check: sumber ' + (r.integritas.sumber === null ? 'tidak tercatat' : r.integritas.sumber + ' temuan') + ', target ' + r.integritas.target + ' temuan');
  r.notes.forEach(n => L.push('Catatan: ' + n));
  r.diffs.slice(0, 40).forEach(d => L.push('SELISIH [' + d.kind + '] ' + d.msg));
  if (r.diffs.length > 40) L.push('... dan ' + (r.diffs.length - 40) + ' selisih lain');
  L.push('PUTUSAN: ' + r.verdict);
  return L.join('\n');
}

module.exports = {compare, report, decDiff, parseDec};

if (require.main === module) {
  const fs = require('fs'), a = process.argv.slice(2), get = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const s = get('--sumber'), t = get('--target');
  if (!s || !t) { console.error('Pakai: node tools/restore_verify.js --sumber manifest.json --target target.json [--skema public,app] [--ketat] [--json]'); process.exit(2); }
  let src, tgt; try { src = JSON.parse(fs.readFileSync(s, 'utf8')); tgt = JSON.parse(fs.readFileSync(t, 'utf8')); } catch (e) { console.error('Berkas manifest tidak terbaca: ' + e.message); process.exit(2); }
  const r = compare(src, tgt, {skema: (get('--skema') || 'public,app').split(',').filter(Boolean), ketat: a.includes('--ketat')});
  console.log(a.includes('--json') ? JSON.stringify(r, null, 2) : report(r));
  process.exit(r.ok ? 0 : 1);
}
