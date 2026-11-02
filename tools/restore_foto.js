#!/usr/bin/env node
// Mengunggah ulang foto produk hasil cadangan ke bucket Storage proyek TARGET, lalu memverifikasi tiap berkas (unduh + sha256) terhadap manifest.
// Bagian 3.7 B4 di Framework-Efisiensi-End-to-End.md. Dipanggil oleh tools/restore.sh --foto.
//   node tools/restore_foto.js --manifest manifest.json --folder dir --url https://xxxx.supabase.co --kunci SERVICE_ROLE_KEY [--bucket product-photos]
// Kunci service role milik proyek TARGET hanya dipakai di sini dan tidak ditulis ke disk atau log. Kode keluar: 0 semua foto cocok, 1 ada yang gagal/tidak cocok.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const a = process.argv.slice(2), get = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const man = JSON.parse(fs.readFileSync(get('--manifest'), 'utf8')), dir = get('--folder'), base = String(get('--url') || '').replace(/\/+$/, ''), key = get('--kunci'), bucket = get('--bucket') || 'product-photos';
const MIME = {jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp'};
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
(async () => {
  const list = (man.foto && man.foto.berkas) || [];
  if (!base || !key) { console.error('--url dan --kunci wajib'); process.exit(1); }
  let bad = 0;
  const onDisk = new Set(); (function walk(d, p) { fs.readdirSync(d, {withFileTypes: true}).forEach(e => e.isDirectory() ? walk(path.join(d, e.name), p + e.name + '/') : onDisk.add(p + e.name)); })(dir, '');
  list.forEach(f => { if (!onDisk.has(f.nama)) { console.error('Foto ada di manifest tetapi tidak ada di arsip: ' + f.nama); bad++; } });
  onDisk.forEach(n => { if (!list.some(f => f.nama === n)) { console.error('Foto ada di arsip tetapi tidak ada di manifest: ' + n); bad++; } });
  for (const f of list) {
    const fp = path.join(dir, f.nama); if (!fs.existsSync(fp)) continue;
    const buf = fs.readFileSync(fp);
    if (sha(buf) !== f.sha256 || buf.length !== f.byte) { console.error('Arsip rusak, sha256/ukuran tidak cocok manifest: ' + f.nama); bad++; continue; }
    const ext = f.nama.split('.').pop().toLowerCase();
    try {
      const up = await fetch(base + '/storage/v1/object/' + bucket + '/' + f.nama.split('/').map(encodeURIComponent).join('/'), {method: 'POST', headers: {apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': MIME[ext] || 'application/octet-stream', 'x-upsert': 'true', 'cache-control': 'max-age=31536000'}, body: buf});
      if (!up.ok) { console.error('Unggah gagal (' + up.status + '): ' + f.nama); bad++; continue; }
      const dl = await fetch(base + '/storage/v1/object/public/' + bucket + '/' + f.nama.split('/').map(encodeURIComponent).join('/'));
      const got = dl.ok ? Buffer.from(await dl.arrayBuffer()) : null;
      if (!got || sha(got) !== f.sha256) { console.error('Verifikasi gagal setelah unggah: ' + f.nama); bad++; }
    } catch (e) { console.error('Galat jaringan untuk ' + f.nama + ': ' + e.message); bad++; }
  }
  console.log('Foto: ' + (list.length - bad < 0 ? 0 : list.length) + ' di manifest, ' + (bad ? bad + ' GAGAL' : 'semua terunggah dan sha256 cocok'));
  process.exit(bad ? 1 : 0);
})();
