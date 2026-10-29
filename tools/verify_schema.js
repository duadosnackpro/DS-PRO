#!/usr/bin/env node
// Memastikan database yang dituju sudah memasang migrasi terakhir di repo (P0-3). Tanpa dependensi.
//   node tools/verify_schema.js <SUPABASE_URL> <SUPABASE_PUBLISHABLE_KEY>
// Memanggil rpc_schema_version (boleh anon) dan membandingkan dengan nama berkas migrasi terbaru. Keluar 1 bila tidak sama.
const fs = require('fs'), path = require('path');
const [url, key] = process.argv.slice(2);
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url || '') || !key) { console.error('Pemakaian: verify_schema.js <https://ref.supabase.co> <publishable key>'); process.exit(2); }
if (/service_role/.test(key)) { console.error('Kunci service_role tidak boleh dipakai di sini'); process.exit(2); }
const dir = path.join(__dirname, '../supabase/migrations');
const latest = fs.readdirSync(dir).filter(f => /^\d+_.*\.sql$/.test(f)).map(f => f.split('_')[0]).sort().pop();
(async () => {
  let r; try { r = await fetch(url + '/rest/v1/rpc/rpc_schema_version', {method: 'POST', headers: {apikey: key, 'Content-Type': 'application/json'}, body: '{"p":{}}'}); }
  catch (e) { console.error('Tidak bisa menghubungi ' + url + ': ' + e.message); process.exit(1); }
  const b = await r.json().catch(() => null);
  if (!r.ok || !b) { console.error('rpc_schema_version gagal (HTTP ' + r.status + '). Migrasi 0016 belum terpasang?', JSON.stringify(b)); process.exit(1); }
  if (b.version === 'unknown') { console.error("Versi skema 'unknown': migrasi dipasang tanpa Supabase CLI. Jalankan 'supabase migration repair' (lihat supabase/README.md)."); process.exit(1); }
  if (b.version !== latest) { console.error('Skema database ' + b.version + ' != migrasi terakhir di repo ' + latest); process.exit(1); }
  console.log('Skema cocok: ' + b.version + ' (min_client ' + b.min_client + ')');
})();
