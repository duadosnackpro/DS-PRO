#!/usr/bin/env node
// Menggabungkan potongan manifest cadangan menjadi satu berkas JSON (dipakai tools/backup.sh dan tools/restore_verify.sh).
//   node tools/backup_finalize.js --inti inti.json [--integritas integritas.json] [--foto foto.tsv] [--meta k=v ...] --keluar manifest.json
//   foto.tsv: satu baris per berkas, kolom dipisah TAB: nama, byte, sha256
// Tanpa dependensi. Angka uang tetap berupa teks (tidak diubah).
'use strict';
const fs = require('fs');
const a = process.argv.slice(2), get = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const rd = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const inti = get('--inti'), out = get('--keluar');
if (!inti || !out) { console.error('Pakai: node tools/backup_finalize.js --inti inti.json [--integritas f.json] [--foto f.tsv] [--meta k=v] --keluar manifest.json'); process.exit(2); }
const m = rd(inti);
if (get('--integritas')) m.integritas = rd(get('--integritas'));
if (get('--foto')) {
  const rows = fs.readFileSync(get('--foto'), 'utf8').split('\n').filter(Boolean).map(l => { const [nama, byte, sha256] = l.split('\t'); return {nama, byte: Number(byte), sha256}; });
  rows.sort((x, y) => (x.nama < y.nama ? -1 : x.nama > y.nama ? 1 : 0));
  m.foto = {jumlah: rows.length, total_byte: rows.reduce((s, r) => s + r.byte, 0), berkas: rows};
}
a.forEach((x, i) => { if (x === '--meta' && a[i + 1]) { const [k, ...v] = a[i + 1].split('='); m.meta = m.meta || {}; m.meta[k] = v.join('='); } });
fs.writeFileSync(out, JSON.stringify(m));
console.log('Manifest ditulis: ' + out + ' (' + Object.keys(m.tabel || {}).length + ' tabel' + (m.foto ? ', ' + m.foto.jumlah + ' foto' : '') + ')');
