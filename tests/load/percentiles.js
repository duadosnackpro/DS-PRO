// Membaca log transaksi pgbench (--log) dan mencetak persentil latensi (ms) dalam satu baris JSON.
// Pemakaian: node percentiles.js <awalan-log> <detik>   (membaca semua berkas <awalan>.*)
const fs = require('fs'), path = require('path');
const [prefix, secs] = [process.argv[2], Number(process.argv[3] || 0)];
const dir = path.dirname(prefix), base = path.basename(prefix);
const lat = [];
for (const f of fs.readdirSync(dir).filter(x => x === base || x.startsWith(base + '.'))) {
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    const c = line.trim().split(/\s+/); if (c.length < 6 || c[2] === 'skipped' || c[2] === 'failed') continue;
    lat.push(Number(c[2]) / 1000);   // kolom 3 = latensi transaksi (mikrodetik) -> ms
  }
}
lat.sort((a, b) => a - b);
const q = p => lat.length ? lat[Math.min(lat.length - 1, Math.ceil(p / 100 * lat.length) - 1)] : null, r = x => x == null ? null : Math.round(x * 100) / 100;
console.log(JSON.stringify({n: lat.length, tps: secs ? r(lat.length / secs) : null, avg: r(lat.reduce((a, b) => a + b, 0) / (lat.length || 1)), p50: r(q(50)), p95: r(q(95)), p99: r(q(99)), max: r(lat[lat.length - 1])}));
