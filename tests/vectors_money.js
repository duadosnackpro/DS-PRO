// Vektor uji uang bersama, sisi JS: menjalankan kode klien ASLI (costOf dari web/js/modules.js, dnum dari web/js/app.js) terhadap
// tests/vectors/money.json, berkas yang sama dengan supabase/tests/012_money_vectors.test.sql. Nilai harapan dihitung terpisah (Python Decimal).
const fs = require('fs'), vm = require('vm'), path = require('path');
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('GAGAL: ' + m); } };
const root = path.join(__dirname, '..');
const vec = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors/money.json'), 'utf8'));
function extract(file, name) {                                  // ambil teks fungsi asli dengan mencocokkan kurung kurawal
  const src = fs.readFileSync(path.join(root, file), 'utf8'), i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('fungsi ' + name + ' tidak ditemukan di ' + file);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1); }
  throw new Error('kurung tidak seimbang: ' + name);
}
const mats = {};
const ctx = {mById: id => mats[id], set: () => '', Number, Math, isNaN, String, parseFloat};
vm.createContext(ctx);
vm.runInContext(extract('web/js/app.js', 'dnum') + '\nthis.N = dnum;\n' + extract('web/js/modules.js', 'costOf') + '\nthis.costOf = costOf;', ctx);

const tolTotal = Number(vec.toleransi.produksi_total), tolUnit = Number(vec.toleransi.unit_4dp), EPS = 1e-6;
// 1) Biaya produksi: pratinjau klien harus sama dengan hasil server sampai batas pembulatan server (total 2 desimal, HPP 4 desimal)
vec.production.forEach((c, n) => {
  const items = []; c.bahan.forEach((b, i) => { const id = 'm' + n + '_' + i; mats[id] = {nama: id, satuan: 'kg', stok: 1e9, hpp_rata2: Number(b.avg), tipe: b.tipe}; items.push({material_id: id, qty: Number(b.per_batch)}); });
  const r = ctx.costOf(items, {tenaga_kerja: 0}, Number(c.batch), Number(c.qty_hasil), Number(c.tk), Number(c.oh));
  const e = c.expect;
  ok(Math.abs(r.total - Number(e.total)) <= tolTotal + EPS, 'produksi "' + c.nama + '": total klien ' + r.total + ' vs server ' + e.total);
  ok(Math.abs(r.bahan - Number(e.bahan)) <= tolTotal + EPS, 'produksi "' + c.nama + '": bahan klien ' + r.bahan + ' vs ' + e.bahan);
  ok(Math.abs(r.kem - Number(e.kemasan)) <= tolTotal + EPS, 'produksi "' + c.nama + '": kemasan klien ' + r.kem + ' vs ' + e.kemasan);
  ok(Math.abs(r.hpp - Number(e.unit)) <= tolUnit + tolTotal / Number(c.qty_hasil) + EPS, 'produksi "' + c.nama + '": HPP klien ' + r.hpp + ' vs server ' + e.unit);
  ok(r.short.length === 0, 'produksi "' + c.nama + '": tidak ada bahan kurang');
});
// 2) Parser angka klien: format Indonesia dan titik desimal
[['1.234,56', 1234.56], ['1234.56', 1234.56], ['0.5', 0.5], ['12,5', 12.5], [' 3 ', 3], [7, 7]].forEach(([a, b]) => ok(ctx.N(a) === b, 'dnum(' + JSON.stringify(a) + ') = ' + b + ', dapat ' + ctx.N(a)));
ok(Number.isNaN(ctx.N('')), 'dnum("") = NaN');
// 3) Vektor markup: implementasi JS baru ditulis di Fase 4. Di sini hanya dipastikan berkasnya utuh agar Fase 4 langsung memakainya.
ok(vec.markup.length >= 5 && vec.impl_markup.join() === 'js', 'vektor markup tersedia untuk Fase 4 (' + vec.markup.length + ' kasus)');
// 4) Vektor SQL ikut dipastikan utuh dari sisi JS (supaya perubahan berkas tidak lolos tanpa terlihat)
ok(vec.purchase_alloc.length >= 6 && vec.avg_cost.length >= 2 && vec.production.length >= 3, 'jumlah kasus vektor sesuai (alokasi ' + vec.purchase_alloc.length + ', rata-rata ' + vec.avg_cost.length + ', produksi ' + vec.production.length + ')');
vec.purchase_alloc.forEach(c => ok(c.expect.eff.length === c.items.length, 'alokasi "' + c.nama + '": jumlah biaya efektif = jumlah baris'));
console.log(fail ? 'GAGAL ' + fail + ' dari ' + (pass + fail) : 'Semua lulus (' + pass + ' pemeriksaan)'); process.exit(fail ? 1 : 0);
