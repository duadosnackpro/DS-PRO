#!/usr/bin/env node
// Pemeriksaan tipe bertahap ("ratchet"): menjalankan tsc (checkJs) pada kode klien dan membandingkan dengan types/baseline.txt.
// Galat yang SUDAH ada (hampir semuanya derau tipe DOM seperti EventTarget.value) dicatat di baseline; galat BARU membuat CI gagal.
// Bila galat berkurang karena perbaikan, jalankan: node tools/typecheck.js --update  (baseline mengecil, tidak pernah dilonggarkan diam-diam).
const {spawnSync} = require('child_process'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), BASE = path.join(root, 'types/baseline.txt'), upd = process.argv.includes('--update');
const local = path.join(root, 'node_modules/.bin/tsc'), tsc = fs.existsSync(local) ? local : (process.env.TSC || 'tsc');
const sig = [];
for (const cfg of ['tsconfig.json', 'tsconfig.sw.json']) {
  const r = spawnSync(tsc, ['-p', cfg, '--pretty', 'false'], {cwd: root, encoding: 'utf8'});
  if (r.error) { console.error('tsc tidak dapat dijalankan: ' + r.error.message + ' (jalankan npm ci, atau set env TSC)'); process.exit(2); }
  (r.stdout + r.stderr).split('\n').forEach(l => { const m = l.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/); if (m) sig.push(m[1] + ' | ' + m[4] + ' | ' + m[5]); }); // tanpa nomor baris: tahan terhadap pergeseran baris
}
sig.sort(); const count = a => a.reduce((o, x) => (o[x] = (o[x] || 0) + 1, o), {});
if (upd) { fs.writeFileSync(BASE, sig.join('\n') + '\n'); console.log('Baseline diperbarui: ' + sig.length + ' galat tipe tercatat'); process.exit(0); }
const base = fs.existsSync(BASE) ? fs.readFileSync(BASE, 'utf8').split('\n').filter(Boolean) : [], cb = count(base), cn = count(sig);
const added = Object.keys(cn).filter(k => (cn[k] || 0) > (cb[k] || 0)), gone = Object.keys(cb).filter(k => (cn[k] || 0) < (cb[k] || 0));
if (added.length) { console.error('GALAT TIPE BARU (' + added.length + ' jenis):'); added.forEach(k => console.error('  + ' + k)); process.exit(1); }
console.log('Tipe OK: ' + sig.length + ' galat lama (baseline ' + base.length + '), 0 baru' + (gone.length ? '. ' + gone.length + ' jenis galat sudah hilang: jalankan "node tools/typecheck.js --update" agar baseline mengecil' : ''));
