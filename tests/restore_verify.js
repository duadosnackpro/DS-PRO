// Uji pembanding manifest cadangan (tools/restore_verify.js) tanpa database. Jalankan: node tests/restore_verify.js
const {compare, decDiff} = require('../tools/restore_verify.js');
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('GAGAL: ' + m); } };
const base = () => ({migrasi_terakhir: 'v1', tabel: {'public.sales': {baris: 3, hash: 'aa'}, 'public.products': {baris: 2, hash: 'bb'}, 'auth.users': {baris: 5, hash: null}},
  kendali: {penjualan: {'sale|paid': {n: 3, total: '36535.00', subtotal: '37035.00'}}, ledger: {'material|purchase': {n: 2, qty: '12.5000', nilai: '48000.0000'}}},
  keamanan: {hak_tabel_hash: 'h1', rls_tabel_hash: 'r1'}, struktur: {konstrain_n: 171, konstrain_hash: 'k1', indeks_hash: 'i1', trigger_hash: 't1', kolom_hash: 'c1', fungsi_hash: 'f1'}, integritas: {tersedia: true, total_pelanggaran: 0, outlet: {A: {ok: true, pelanggaran: 0, per_kode: {K1: 0, K3: 0}, diperiksa: 9}}}});

// desimal exact
ok(decDiff('0.30', '0.1') === '0.2', '0.30-0.1 = 0.2 persis (float akan 0.19999999999999998)');
ok(decDiff('36535.01', '36535.00') === '0.01', 'selisih 1 sen terbaca persis');
ok(decDiff('-1.5', '2') === '-3.5' && decDiff('5', '5.000') === '0' && decDiff('x', '1') === null, 'tanda, skala, dan bukan-angka');
ok(decDiff('99999999999999999999.9999', '99999999999999999999.9998') === '0.0001', 'angka sangat besar tidak kehilangan presisi (BigInt)');

// identik
let r = compare(base(), base()); ok(r.ok && r.bersih && r.verdict === 'SAH (bersih)', 'identik => SAH (bersih)');
// skema: auth tidak dibandingkan bila tidak dipulihkan
let t = base(); t.tabel['auth.users'].baris = 999; r = compare(base(), t); ok(r.ok, 'auth tidak ikut dipulihkan: bedanya diabaikan');
r = compare(base(), t, {skema: ['public', 'app', 'auth']}); ok(!r.ok, 'auth ikut dipulihkan: bedanya terdeteksi');
// baris, hash
t = base(); t.tabel['public.sales'].baris = 2; r = compare(base(), t); ok(!r.ok && r.diffs.some(d => d.kind === 'baris'), 'baris hilang terdeteksi');
t = base(); t.tabel['public.sales'].hash = 'zz'; r = compare(base(), t); ok(!r.ok && r.diffs.some(d => d.kind === 'hash') && r.stat.kendali_beda === 0, 'isi beda, baris sama, kendali sama => hanya hash menangkap');
t = base(); delete t.tabel['public.products']; r = compare(base(), t); ok(!r.ok, 'tabel hilang di target');
t = base(); t.tabel['public.baru'] = {baris: 1, hash: 'q'}; r = compare(base(), t); ok(!r.ok, 'tabel ekstra di target');
t = base(); t.tabel['public.sales'] = {baris: null, hash: null}; r = compare(base(), t); ok(r.ok && r.notes.length > 0, 'tabel tak terbaca dicatat sebagai catatan, tidak diam-diam');
// kendali exact
t = base(); t.kendali.penjualan['sale|paid'].total = '36535.01'; r = compare(base(), t); ok(!r.ok && r.stat.uangMax === '0.01', 'Rp 0,01 terdeteksi; selisih uang terbesar = 0.01');
t = base(); t.kendali.ledger['material|purchase'].qty = '12.5001'; r = compare(base(), t); ok(!r.ok && r.stat.qtyMax === '0.0001' && r.stat.uangMax === '0', 'kuantitas 0,0001 terdeteksi dan tidak dihitung sebagai uang');
t = base(); t.kendali.penjualan['sale|void'] = {n: 1}; r = compare(base(), t); ok(!r.ok, 'kelompok kendali baru di target');
t = base(); t.kendali.penjualan['sale|paid'].n = 4; r = compare(base(), t); ok(!r.ok && r.stat.uangMax === '0', 'jumlah transaksi beda bukan dihitung sebagai uang');
// struktur (FK/indeks/trigger/kolom/fungsi)
t = base(); t.struktur.konstrain_n = 170; t.struktur.konstrain_hash = 'k2'; r = compare(base(), t); ok(!r.ok && r.diffs.some(d => d.kind === 'struktur'), 'FK/konstrain hilang terdeteksi walau baris dan uang sama');
t = base(); t.struktur.indeks_hash = 'i2'; r = compare(base(), t); ok(!r.ok && r.diffs.some(d => d.kind === 'struktur'), 'indeks beda terdeteksi');
t = base(); t.struktur.trigger_hash = 't2'; r = compare(base(), t); ok(!r.ok && r.diffs.some(d => d.kind === 'struktur'), 'trigger beda terdeteksi');
t = base(); t.struktur.fungsi_hash = 'f2'; r = compare(base(), t); ok(!r.ok && r.diffs.some(d => d.kind === 'struktur'), 'isi fungsi beda terdeteksi');
t = base(); delete t.struktur; r = compare(base(), t); ok(!r.ok, 'target tanpa sidik jari struktur tidak lolos');
const s2 = base(); delete s2.struktur; r = compare(s2, base()); ok(r.ok && r.notes.some(n => /struktur/.test(n)), 'manifest lama tanpa struktur: lolos dengan catatan, bukan galat');
// keamanan
t = base(); t.keamanan.hak_tabel_hash = 'h2'; r = compare(base(), t); ok(!r.ok && r.diffs.some(d => d.kind === 'keamanan'), 'hak akses beda');
// migrasi
t = base(); t.migrasi_terakhir = 'v0'; r = compare(base(), t); ok(r.ok && r.notes.length === 1, 'migrasi beda tanpa supabase_migrations dipulihkan => catatan');
r = compare(base(), t, {skema: ['public', 'app', 'supabase_migrations']}); ok(!r.ok, 'migrasi beda dengan supabase_migrations dipulihkan => tidak sah');
// integritas
const sumberTemuan = () => { const s = base(); s.integritas = {tersedia: true, total_pelanggaran: 2, outlet: {A: {ok: false, pelanggaran: 2, per_kode: {K1: 1, K3: 1}, diperiksa: 9}}}; return s; };
r = compare(sumberTemuan(), sumberTemuan()); ok(r.ok && !r.bersih && r.temuan_bawaan_sumber === 2 && /bukan bersih/.test(r.verdict), 'temuan bawaan sumber: SAH tetapi BUKAN bersih');
r = compare(sumberTemuan(), sumberTemuan(), {ketat: true}); ok(!r.ok, '--ketat menolak temuan bawaan');
t = sumberTemuan(); t.integritas.outlet.A.per_kode.K1 = 2; t.integritas.total_pelanggaran = 3; r = compare(sumberTemuan(), t); ok(!r.ok && r.diffs.some(d => d.kind === 'integritas'), 'pemulihan menambah temuan => tidak sah');
t = sumberTemuan(); t.integritas.outlet.A.per_kode.K1 = 0; t.integritas.total_pelanggaran = 1; r = compare(sumberTemuan(), t); ok(r.ok, 'temuan berkurang tidak membuat tidak sah');
t = base(); t.integritas = {tersedia: false, alasan: 'tidak ada owner aktif'}; r = compare(base(), t); ok(!r.ok, 'integrity_check tak dapat dijalankan => tidak sah (tidak diam-diam lolos)');
t = base(); delete t.integritas; r = compare(base(), t); ok(!r.ok, 'target tanpa hasil integritas => tidak sah');
t = base(); t.integritas.outlet.A.diperiksa = 8; r = compare(base(), t); ok(!r.ok, 'jumlah baris diperiksa beda => tidak sah');
const sOld = base(); delete sOld.integritas; t = base(); t.integritas.total_pelanggaran = 1; r = compare(sOld, t); ok(!r.ok, 'sumber tanpa integritas, target punya temuan => tidak sah');
console.log('Uji pembanding restore_verify: ' + pass + ' lulus, ' + fail + ' gagal'); process.exit(fail ? 1 : 0);
