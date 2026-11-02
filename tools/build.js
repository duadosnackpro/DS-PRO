#!/usr/bin/env node
// Membangun web/js/app.js dengan menyambung src/app/*.js berurutan (urutan nama berkas). Tanpa dependensi, tanpa transformasi:
// hasil = gabungan persis isi berkas sumber. Semua bagian berbagi SATU fungsi pembungkus (IIFE) yang dibuka di 01-inti.js dan ditutup di 14-mulai.js,
// jadi variabel bersama antar bagian tetap sama seperti sebelumnya.
//   node tools/build.js          tulis web/js/app.js
//   node tools/build.js --check  gagal (kode 1) bila web/js/app.js tidak sama dengan hasil bangun (dipakai CI)
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '../src/app'), out = path.join(__dirname, '../web/js/app.js');
const parts = fs.readdirSync(dir).filter(f => /^\d+-.*\.js$/.test(f)).sort();
if (!parts.length) { console.error('Tidak ada berkas sumber di src/app/'); process.exit(2); }
const built = parts.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (cur !== built) { console.error('web/js/app.js TIDAK sama dengan hasil bangun src/app/*.js. Jalankan: npm run build (lalu commit). Jangan mengedit web/js/app.js langsung.'); process.exit(1); }
  console.log('web/js/app.js sesuai dengan src/app/ (' + parts.length + ' bagian)'); process.exit(0);
}
fs.writeFileSync(out, built); console.log('Dibangun: ' + path.relative(process.cwd(), out) + ' dari ' + parts.length + ' bagian (' + built.length + ' karakter)');
