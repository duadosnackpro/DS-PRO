// Pemeriksa rilis (tanpa dependensi): mencegah kesalahan unggah/rilis yang pernah terjadi.
//  - versi config.js == sw.js (banner pembaruan tidak muncul bila beda)
//  - setiap berkas di daftar CORE sw.js benar-benar ada (unggahan tanpa folder = pemasangan SW gagal / 404)
//  - setiap url() di CSS, ikon di manifest, dan <script>/<link> di index.html ada
//  - CSP ada dan tidak melonggarkan script (tanpa 'unsafe-inline'/'unsafe-eval' di script-src), tanpa handler inline
//  - hanya satu blok :root di CSS
//  - MIN_SCHEMA di sb-adapter.js menunjuk migrasi yang ada dan tidak lebih baru dari migrasi terakhir (P0-3)
//  - versi package.json == judul supabase/README.md == config.js == sw.js (P1-7)
// Jalankan: node tests/release_check.js
const fs = require('fs'), path = require('path');
const WEB = process.env.WEB_SRC || path.join(__dirname, '../web'), rd = f => fs.readFileSync(path.join(WEB, f), 'utf8'), ex = f => fs.existsSync(path.join(WEB, f));
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('GAGAL: ' + m); } };

const sw = rd('sw.js'), cfg = rd('js/config.js'), html = rd('index.html'), css = rd('css/app.css');
const vSw = (sw.match(/const VERSION = 'duado-v([^']+)'/) || [])[1], vCfg = (cfg.match(/VERSION:\s*'([^']+)'/) || [])[1];
ok(vSw && vCfg && vSw === vCfg, 'versi sw.js (' + vSw + ') harus sama dengan config.js (' + vCfg + ')');

const core = (sw.match(/const CORE = \[([^\]]*)\]/) || [, ''])[1].match(/'([^']+)'/g) || [];
ok(core.length >= 9, 'daftar CORE terbaca (' + core.length + ' berkas)');
core.map(x => x.slice(1, -1)).forEach(f => ok(f === './' || ex(f), 'berkas CORE sw.js ada: ' + f));
(sw.match(/const OPTIONAL = \[([^\]]*)\]/) || [, ''])[1].match(/'([^']+)'/g) || []; // OPTIONAL boleh kosong

[...html.matchAll(/(?:src|href)="([^"#?]+)"/g)].map(m => m[1]).filter(u => !/^(https?:|data:)/.test(u)).forEach(u => ok(ex(u), 'index.html merujuk berkas yang ada: ' + u));
[...css.matchAll(/url\(([^)]+)\)/g)].map(m => m[1].replace(/["']/g, '')).filter(u => !/^(data:|#)/.test(u)).forEach(u => ok(ex(path.normalize(path.join('css', u))), 'CSS merujuk berkas yang ada: ' + u));

const man = JSON.parse(rd('manifest.webmanifest'));
man.icons.forEach(i => ok(ex(i.src), 'ikon manifest ada: ' + i.src));
ok(man.icons.some(i => /maskable/.test(i.purpose) && /512/.test(i.sizes)), 'ada ikon maskable 512');
ok(man.icons.some(i => /maskable/.test(i.purpose) && /192/.test(i.sizes)), 'ada ikon maskable 192');
ok(man.icons.some(i => i.purpose === 'any' && /512/.test(i.sizes)), 'ada ikon "any" 512');
ok(man.orientation === 'any', 'orientation = any (kasir di tablet landscape), dapat: ' + man.orientation);
ok(man.start_url && man.scope && man.id, 'manifest punya id, start_url, scope');

const cm = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/); ok(!!cm, 'index.html punya meta Content-Security-Policy');
if (cm) {
  const d = {}; cm[1].split(';').forEach(x => { const [k, ...v] = x.trim().split(/\s+/); if (k) d[k] = v; });
  ok(d['default-src'] && d['default-src'].join() === "'none'", "default-src 'none'");
  ok(d['script-src'] && d['script-src'].join() === "'self'", "script-src hanya 'self'");
  ok(!/unsafe-(inline|eval)/.test((d['script-src'] || []).join(' ')), 'script-src tanpa unsafe-inline/unsafe-eval');
  ok((d['object-src'] || []).join() === "'none'" && (d['base-uri'] || []).join() === "'none'", "object-src dan base-uri 'none'");
  ok(!(d['connect-src'] || []).some(x => x === '*' || x === 'https:'), 'connect-src tidak memakai wildcard');
}
ok(!/\son[a-z]+\s*=/i.test(html), 'index.html tanpa atribut handler inline');
['js/app.js', 'js/modules.js'].forEach(f => { const t = rd(f); ok(!/\son(click|error|load|change|input|submit|keydown|keyup)=["']/.test(t), f + ' tanpa atribut handler inline (diblokir CSP)'); ok(!/\beval\(|new Function\(/.test(t), f + ' tanpa eval/new Function'); ok(!/createElement\(['"]style['"]\)/.test(t), f + ' tidak menyisipkan elemen <style> (diblokir CSP)'); });

ok((css.match(/:root\s*\{/g) || []).length === 1, 'CSS hanya punya satu blok :root (ada ' + (css.match(/:root\s*\{/g) || []).length + ')');
const ad = rd('js/sb-adapter.js'), minSchema = (ad.match(/const MIN_SCHEMA = '(\d+)'/) || [])[1], migDir = path.join(__dirname, '../supabase/migrations');
const migs = fs.existsSync(migDir) ? fs.readdirSync(migDir).filter(f => /^\d+_.*\.sql$/.test(f)).map(f => f.split('_')[0]).sort() : [];
ok(!!minSchema, 'sb-adapter.js punya MIN_SCHEMA');
ok(migs.length > 0 && migs.indexOf(minSchema) >= 0, 'MIN_SCHEMA (' + minSchema + ') adalah salah satu berkas di supabase/migrations');
ok(migs.length > 0 && minSchema <= migs[migs.length - 1], 'MIN_SCHEMA tidak lebih baru dari migrasi terakhir (' + migs[migs.length - 1] + ')');
const pkgV = fs.existsSync(path.join(__dirname, '../package.json')) ? JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version : null;
if (pkgV) ok(pkgV === vCfg, 'versi package.json (' + pkgV + ') harus sama dengan config.js (' + vCfg + ')');
const rdm = path.join(__dirname, '../supabase/README.md');
if (fs.existsSync(rdm)) { const m = fs.readFileSync(rdm, 'utf8').match(/^# .*\(v(\d+\.\d+\.\d+)/m); ok(!!m && m[1] === vCfg, 'versi di judul supabase/README.md (' + (m && m[1]) + ') harus sama dengan config.js (' + vCfg + ')'); }
console.log(fail ? 'GAGAL: ' + fail + ' dari ' + (pass + fail) : 'Semua lulus (' + pass + ' pemeriksaan)'); process.exit(fail ? 1 : 0);
