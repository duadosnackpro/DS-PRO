// Uji adapter Supabase (tanpa jaringan): fetch palsu merekam permintaan dan memberi jawaban skenario.
const fs = require('fs'), vm = require('vm'), path = require('path');
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('GAGAL: ' + m); } };
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (expMs) => 'h.' + b64({exp: Math.floor(expMs / 1000), sub: 'u1'}) + '.s';
function load(handler, cfg) {
  const store = {}, calls = [], schema = {reply: () => ({status: 200, body: {version: '99999999999999', min_client: '0.0.0'}})};   // skema palsu: cocok untuk semua tes kecuali tes penjaga skema
  const ctx = {window: {CONFIG: Object.assign({SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_KEY: 'pk'}, cfg || {})}, console, atob: s => Buffer.from(s, 'base64').toString('binary'), crypto: require('crypto').webcrypto, Date, JSON, Math, Object, Promise, Error, String, Number, encodeURIComponent,
    localStorage: {getItem: k => k in store ? store[k] : null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; }},
    fetch: async (url, opt) => { const body = opt && typeof opt.body === 'string' ? JSON.parse(opt.body) : null; calls.push({url, opt, body}); const r = /rpc_schema_version/.test(url) ? schema.reply(url) : await handler(url, opt, body); if (r instanceof Error) throw r; return {ok: r.status < 400, status: r.status, json: async () => r.body}; }};
  ctx.window.localStorage = ctx.localStorage; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/js/sb-adapter.js'), 'utf8'), ctx);
  return {S: ctx.window.SBAPI, calls, store, schema};
}
const boot = role => ({user: {uid: 'u1', nama: 'Tia', username: 'tia'}, outlets: [{id: 'o1', code: 'OUT-001', name: 'Utama', kind: 'store', status: 'active', role}], outlet: {id: 'o1', code: 'OUT-001', name: 'Utama'}, role, channels: [], products: [], variants: [], prices: [], settings: {}, ver: 'a~b', cat_ver: 'a', stock_ver: 'b'});
(async () => {
  const good = jwt(Date.now() + 3600e3);
  let h = (url, opt, body) => {
    if (/grant_type=password/.test(url)) return body.password === '123789' ? {status: 200, body: {access_token: good, refresh_token: 'r1'}} : {status: 400, body: {error_description: 'Invalid login credentials'}};
    if (/rpc_bootstrap/.test(url)) return {status: 200, body: boot('kasir')};
    if (/rpc_sale_create/.test(url)) return {status: 200, body: {sale: {nomor: 'OUT-001-261027-001'}}};
    return {status: 404, body: {message: 'x'}};
  };
  let {S, calls, store} = load(h);
  ok(S.enabled(), 'adapter aktif bila URL dan kunci valid');
  ok(!load(h, {SUPABASE_KEY: ''}).S.enabled(), 'nonaktif tanpa kunci');
  ok(!load(h, {SUPABASE_URL: 'https://evil.example.com'}).S.enabled(), 'URL non-supabase ditolak');
  try { await S.call('login', {username: 'tia', pin: '000'}); ok(false, 'login salah harus gagal'); } catch (e) { ok(e.server && /salah/.test(e.message), 'login salah => pesan Indonesia'); }
  const r = await S.call('login', {username: ' Tia ', pin: '123789'});
  ok(calls.find(c => /grant_type=password/.test(c.url) && c.body.email === 'tia@users.duado.local'), 'username dinormalkan jadi email sintetis');
  ok(r.role === 'kasir' && r.uid === 'u1' && store.sb_rt === 'r1', 'login meneruskan peran asli dan menyimpan refresh token');
  ok(store.sb_outlet === 'o1', 'outlet aktif tersimpan');
  await S.call('sale.create', {request_id: 'rq-123456', items: []}, good);
  const sc = calls.filter(c => /rpc_sale_create/.test(c.url)).pop();
  ok(sc.body.p.outlet_id === 'o1', 'sale.create menyisipkan outlet aktif');
  ok(sc.opt.headers.Authorization === 'Bearer ' + good && sc.opt.headers.apikey === 'pk', 'header Authorization + apikey');
  await S.call('sale.create', {request_id: 'rq-123457', outlet_id: 'o9', items: []}, good);
  ok(calls.filter(c => /rpc_sale_create/.test(c.url)).pop().body.p.outlet_id === 'o9', 'outlet_id dari antrean tidak ditimpa');
  try { await S.call('archive.run', {}, good); ok(false, 'aksi belum didukung harus jelas gagal'); } catch (e) { ok(e.server && /belum dipindahkan/.test(e.message), 'aksi belum didukung => pesan jelas'); }

  // pemetaan galat
  const mk = (st, body) => load(() => ({status: st, body}));
  for (const [st, body, auth, retry, label] of [[401, {message: 'JWT expired'}, true, false, '401'], [200 + 300, {message: 'boom'}, false, true, '500 => retry'], [400, {message: 'Stok X tidak cukup', code: 'P0001'}, false, false, 'galat bisnis'], [400, {message: 'deadlock', code: '40P01'}, false, true, 'deadlock => retry'], [400, {message: 'Sesi berakhir, silakan masuk lagi.', code: '28000'}, true, false, '28000']]) {
    const x = mk(st, body); try { await x.S.call('stock.get', {}, good); ok(false, label + ' harus gagal'); } catch (e) { ok(!!e.auth === auth && !!e.retry === retry && e.server === true, 'pemetaan galat ' + label + ' (auth=' + e.auth + ', retry=' + e.retry + ')'); }
  }
  const net = load(() => new Error('offline')); try { await net.S.call('stock.get', {}, good); } catch (e) { ok(!e.server, 'galat jaringan BUKAN e.server (antrean tetap mencoba lagi)'); }

  // refresh token otomatis saat hampir kedaluwarsa dan saat 401
  const old = jwt(Date.now() + 10e3); let rf = 0, seen = [];
  const y = load((url, opt, body) => { if (/refresh_token/.test(url)) { rf++; return {status: 200, body: {access_token: good, refresh_token: 'r2'}}; } seen.push(opt.headers.Authorization); return {status: 200, body: {stok: {}}}; });
  y.store.sb_rt = 'r1'; let got = null; await y.S.call('stock.get', {}, old, t => { got = t; });
  ok(rf === 1 && got === good && seen[0] === 'Bearer ' + good && y.store.sb_rt === 'r2', 'token hampir habis disegarkan sebelum permintaan');
  let n401 = 0; const z = load((url) => { if (/refresh_token/.test(url)) return {status: 200, body: {access_token: good, refresh_token: 'r3'}}; return ++n401 === 1 ? {status: 401, body: {message: 'JWT expired'}} : {status: 200, body: {ok: 1}}; });
  z.store.sb_rt = 'r1'; await z.S.call('ping', {}, good); ok(n401 === 2, '401 => segarkan lalu ulangi sekali');
  const dead = load((url) => /refresh_token/.test(url) ? {status: 400, body: {}} : {status: 401, body: {message: 'JWT expired'}}); dead.store.sb_rt = 'r1';
  try { await dead.S.call('ping', {}, good); } catch (e) { ok(e.auth, 'refresh gagal => galat sesi'); }

  // override supervisor/owner: PIN diverifikasi Auth, token approver hanya untuk satu permintaan, tidak untuk kasir biasa
  const ov = load((url, opt, body) => {
    if (/grant_type=password/.test(url)) return {status: 200, body: {access_token: body.email.startsWith('own') ? 'T_OWNER' : 'T_KASIR', refresh_token: 'x'}};
    if (/rpc_bootstrap/.test(url)) return {status: 200, body: boot(opt.headers.Authorization === 'Bearer T_OWNER' ? 'owner' : 'kasir')};
    if (/rpc_approval_issue/.test(url)) return {status: 200, body: {approval_id: 'bbbbbbbb-0000-0000-0000-000000000002'}};
    return {status: 200, body: {sale: {nomor: 'OK'}}};
  });
  await ov.S.call('login', {username: 'kasir1', pin: '123789'});
  const g = await ov.S.call('override.grant', {username: 'owner1', pin: '123789', kind: 'retur', request_id: 'rt-1234567', nilai: 20000, ref_id: 's1'}); ok(g.token === 'sbap:bbbbbbbb-0000-0000-0000-000000000002', 'override.grant(retur) memberi id persetujuan server');
  const ai0 = ov.calls.filter(c => /rpc_approval_issue/.test(c.url)).pop(); ok(ai0.body.p.kind === 'retur' && ai0.body.p.ref_id === 's1' && ai0.body.p.amount === 20000 && ai0.opt.headers.Authorization === 'Bearer T_OWNER', 'persetujuan retur terikat transaksi asal + nilai, diterbitkan dengan token penyetuju');
  try { await ov.S.call('override.grant', {username: 'kasir2', pin: '123789'}); ok(false, 'kasir tidak boleh menyetujui'); } catch (e) { ok(/tidak berwenang/.test(e.message), 'akun non-supervisor ditolak sebagai approver'); }
  await ov.S.call('sale.return', {request_id: 'rt-1234567', id: 's1', override_token: g.token}, 'T_KASIR');
  const rc = ov.calls.filter(c => /rpc_sale_return/.test(c.url)).pop();
  ok(rc.opt.headers.Authorization === 'Bearer T_KASIR' && !('override_token' in rc.body.p) && rc.body.p.approval_id === 'bbbbbbbb-0000-0000-0000-000000000002', 'F-03: retur dijalankan dengan token KASIR + approval_id (bukan JWT approver)');
  try { await ov.S.call('override.grant', {username: 'owner1', pin: '123789'}); ok(false, 'jenis persetujuan wajib'); } catch (e) { ok(/tidak dikenal/.test(e.message), 'override.grant tanpa jenis ditolak'); }

  // aksi yang dilayani fungsi database (dashboard, laporan, produksi, resep, biaya, audit stok)
  const A = {BRG: 'Bearer ' + good};
  const rt = {}, hh = (url, opt, body) => {
    const m = url.match(/rpc_([a-z_]+)/); if (m) { rt[m[1]] = body.p; }
    if (/rpc_dashboard/.test(url)) return {status: 200, body: {period: 'hari', cur: {omzet: 0}}};
    if (/rpc_report_ops/.test(url)) return {status: 200, body: {type: body.p.type, title: 'O', columns: [], fmt: [], rows: [], summary: []}};
    if (/rpc_report_legacy/.test(url)) return {status: 200, body: {type: body.p.type, title: 'T', columns: [], fmt: [], rows: [], summary: []}};
    if (/rpc_production_list/.test(url)) return {status: 200, body: []};
    if (/rpc_recipe_save/.test(url)) return {status: 200, body: {recipe: {id: 'r-1', nama: 'Resep A'}}};
    if (/rpc_recipe_delete/.test(url)) return {status: 200, body: {id: body.p.id}};
    if (/rpc_recipe_copy/.test(url)) return {status: 200, body: {dibuat: [{id: 'r-2'}]}};
    if (/recipe_items\?/.test(url)) return rt.__failItems ? new Error('offline') : {status: 200, body: [{id: 'i1', recipe_id: 'r-1', material_id: 'm1', qty: 2}]};
    if (/\/expenses\?/.test(url)) return {status: 200, body: [{id: 'e1', expense_date: '2026-10-28', category: 'Gas', amount: '15000.00', note: null, outlet_id: 'o1'}]};
    if (/rpc_stock_reconcile/.test(url)) return {status: 200, body: {jumlah: 2, selisih: [{outlet_id: 'o1', item_type: 'variant', item_id: 'v1', saldo: 5, ledger: 4, selisih: 1}, {outlet_id: 'o1', item_type: 'material', item_id: 'm1', saldo: '2.5', ledger: 3, selisih: '-0.5'}]}};
    if (/rpc_bootstrap/.test(url)) return {status: 200, body: Object.assign(boot('owner'), {products: [{id: 'p1', nama: 'Makaroni'}], variants: [{id: 'v1', product_id: 'p1', ukuran: '70', level_pedas: 'Level 1'}, {id: 'v2', product_id: 'p1', ukuran: '100'}], materials: [{id: 'm1', nama: 'Tepung'}]})};
    if (/rpc_(sale_reject_log|cash_open|cash_movement_add|cash_summary|transfer_action|user_unlock|shift_list|cash_approve|expense_void|purchase_cancel|period_lock_set|hpp_backfill)/.test(url)) return {status: 200, body: {ok: true}};
    return {status: 404, body: {message: 'x'}};
  };
  const q = load(hh); q.S.setOutlet('o1');
  await q.S.call('dashboard.get', {period: 'bulan'}, good);
  ok(rt.dashboard.period === 'bulan' && rt.dashboard.outlet_id === 'o1', 'dashboard.get => rpc_dashboard + outlet aktif');
  await q.S.call('report.get', {type: 'penjualan', from: '2026-10-01', to: '2026-10-28'}, good);
  ok(rt.report_legacy.type === 'penjualan' && rt.report_legacy.from === '2026-10-01' && rt.report_legacy.outlet_id === 'o1', 'report.get => rpc_report_legacy dengan jenis, rentang, outlet');
  for (const ty of ['stok_minimum', 'lead_transfer', 'durasi_shift']) {
    delete rt.report_ops; await q.S.call('report.get', {type: ty, from: '2026-10-01', to: '2026-10-30'}, good);
    ok(rt.report_ops && rt.report_ops.type === ty && rt.report_ops.outlet_id === 'o1' && rt.report_ops.from === '2026-10-01' && rt.report_legacy.type === 'penjualan', '0027: report.get(' + ty + ') => rpc_report_ops dengan outlet aktif (tidak menyentuh report_legacy)');
  }
  rt.report_legacy = null; await q.S.call('report.get', {type: 'selisih_kas', from: '2026-10-01', to: '2026-10-30'}, good);
  ok(rt.report_legacy && rt.report_legacy.type === 'selisih_kas', '0027: jenis lama tetap lewat rpc_report_legacy');
  await q.S.call('production.list', {}, good);
  ok(rt.production_list.outlet_id === 'o1', 'production.list => rpc_production_list + outlet aktif');
  const rs = await q.S.call('recipe.save', {variant_id: 'v1', nama: 'Resep A', hasil_standar: 10, jenis: 'batch', tenaga_kerja: 0, items: [{material_id: 'm1', qty: 2}]}, good);
  ok(rs.recipe.id === 'r-1' && Array.isArray(rs.items) && rs.items.length === 1 && rs.items[0].material_id === 'm1', 'recipe.save menyertakan bahan terbaru (patchRecipe butuh items)');
  ok(q.calls.some(c => /recipe_items\?.*recipe_id=eq\.r-1/.test(c.url)), 'bahan dibaca ulang untuk resep yang baru disimpan');
  rt.__failItems = true; const rs2 = await q.S.call('recipe.save', {variant_id: 'v1', nama: 'X', hasil_standar: 1, items: []}, good);
  ok(rs2 && !rs2.recipe && !('items' in rs2), 'bahan gagal dibaca => {} agar UI memuat ulang data (bukan items undefined)'); rt.__failItems = false;
  // F3/F4/F2: aksi baru dilayani database (bukan stub)
  await q.S.call('sale.reject_log', {request_id: 'req-abcdefgh', alasan: 'x', aksi: 'hapus'}, good);
  ok(rt.sale_reject_log && rt.sale_reject_log.outlet_id === 'o1' && rt.sale_reject_log.request_id === 'req-abcdefgh', 'sale.reject_log => rpc_sale_reject_log (bukan stub lokal)');
  await q.S.call('shift.open', {modal_awal: 50000}, good);
  ok(rt.cash_open.modal_awal === 50000 && rt.cash_open.outlet_id === 'o1', 'shift.open => rpc_cash_open dengan outlet aktif');
  await q.S.call('cash.move', {jenis: 'out', nominal: 5000, alasan: 'es batu'}, good);
  ok(rt.cash_movement_add.nominal === 5000, 'cash.move => rpc_cash_movement_add');
  await q.S.call('shift.summary', {}, good);
  ok(rt.cash_summary.outlet_id === 'o1', 'shift.summary mengirim outlet aktif');
  await q.S.call('transfer.action', {id: 't1', action: 'approve'}, good);
  ok(rt.transfer_action.action === 'approve' && /^[0-9a-f-]{8,}|^x/.test(rt.transfer_action.request_id), 'transfer.action => rpc_transfer_action dengan request_id idempoten');
  await q.S.call('user.unlock', {id: 'u1'}, good);
  ok(rt.user_unlock.user_id === 'u1', 'user.unlock => rpc_user_unlock (bukan stub)');
  const cp = await q.S.call('recipe.copy', {source_id: 'r-1', targets: [{variant_id: 'v2', nama: 'S'}]}, good);
  ok(rt.recipe_copy.source_id === 'r-1' && cp.dibuat.length === 1, 'recipe.copy => rpc_recipe_copy');
  const rd = await q.S.call('master.remove', {table: 'recipes', id: 'r-9'}, good);
  ok(rt.recipe_delete && rt.recipe_delete.id === 'r-9' && rd.id === 'r-9', 'master.remove(recipes) => rpc_recipe_delete (bukan galat "belum didukung")');
  // ---- P1 (F-08, F-15, F-16, F-17) ----
  await q.S.call('shift.list', {}, good);
  ok(rt.shift_list && rt.shift_list.outlet_id === 'o1', 'shift.list => rpc_shift_list (nama kasir, fisik_sebelumnya dari server)');
  await q.S.call('shift.approve', {id: 's1', catatan: 'uang kembalian salah'}, good);
  ok(rt.cash_approve.id === 's1' && rt.cash_approve.catatan === 'uang kembalian salah', 'shift.approve => rpc_cash_approve dengan catatan');
  await q.S.call('expense.void', {id: 'e1', alasan: 'salah ketik'}, good);
  ok(rt.expense_void.id === 'e1' && rt.expense_void.alasan === 'salah ketik' && /^[0-9a-f-]{8,}|^x/.test(rt.expense_void.request_id), 'expense.void => rpc_expense_void dengan request_id');
  await q.S.call('purchase.cancel', {id: 'p1', alasan: 'dobel input'}, good);
  ok(rt.purchase_cancel.id === 'p1', 'purchase.cancel => rpc_purchase_cancel');
  await q.S.call('period.lock', {sampai: '2026-09-30', alasan: 'tutup buku'}, good);
  ok(rt.period_lock_set.sampai === '2026-09-30', 'period.lock => rpc_period_lock_set');
  await q.S.call('hpp.backfill', {from: '2026-10-01', to: '2026-10-28', terapkan: false}, good);
  ok(rt.hpp_backfill.outlet_id === 'o1' && rt.hpp_backfill.terapkan === false, 'hpp.backfill => rpc_hpp_backfill (pratinjau bawaan)');
  const ex = await q.S.call('master.list', {table: 'expenses'}, good);
  ok(ex[0].dibatalkan === false && ex[0].pembalik === false, 'daftar biaya menandai dibatalkan/pembalik (F-16)');
  ok(ex.length === 1 && ex[0].tanggal === '2026-10-28' && ex[0].kategori === 'Gas' && ex[0].nominal === 15000 && ex[0].catatan === '' && /outlet_id\.eq\.o1,outlet_id\.is\.null/.test(q.calls.filter(c => /\/expenses\?/.test(c.url)).pop().url), 'master.list biaya dipetakan ke bentuk legacy: outlet aktif + biaya pusat');
  try { await q.S.call('master.list', {table: 'channels'}, good); ok(false, 'tabel lain belum didukung'); } catch (e) { ok(e.server && /belum didukung/.test(e.message), 'master.list tabel lain => pesan jelas'); }
  const au = await q.S.call('stock.audit', {}, good);
  ok(au.diperiksa === 3 && au.selisih.length === 2, 'stock.audit menghitung item diperiksa dan selisih');
  ok(au.selisih[0].tipe === 'varian' && au.selisih[0].nama === 'Makaroni 70 · Level 1' && au.selisih[0].stok === 5 && au.selisih[0].riwayat === 4 && au.selisih[0].selisih === 1, 'stock.audit: varian dipetakan (tipe, nama, stok, riwayat, selisih)');
  ok(au.selisih[1].tipe === 'bahan' && au.selisih[1].nama === 'Tepung' && au.selisih[1].stok === 2.5 && au.selisih[1].selisih === -0.5, 'stock.audit: bahan dipetakan dan angka teks diubah jadi angka');
  try { await q.S.call('stock.reconcile', {tipe: 'varian', id: 'v1'}, good); ok(false, 'reconcile harus ditolak'); } catch (e) { ok(e.server && /opname/.test(e.message), 'stock.reconcile => arahan ke opname, tidak diam-diam berhasil'); }

  // logo, foto produk (Storage), produk tambahan, saran overhead, impor Shopee
  const n = {}, h2 = (url, opt, body) => {
    const m = url.match(/rpc_([a-z_]+)/); if (m) n[m[1]] = body.p;
    if (/rpc_settings_set/.test(url)) return {status: 200, body: {ok: true, jumlah: 1}};
    if (/rpc_addon_create/.test(url)) return {status: 200, body: {product_id: 'p9', variant_id: 'v9', sku: 'KK'}};
    if (/rpc_overhead_saran/.test(url)) return {status: 200, body: {saran_per_unit: 310.5, bulan: 'September 2026', biaya: 1000, unit: 100}};
    if (/rpc_shopee_import/.test(url)) return {status: 200, body: {ok: body.p.orders.length, duplikat: 0, gagal: []}};
    if (/products\?select=photo_url/.test(url)) return {status: 200, body: [{photo_url: 'https://abc.supabase.co/storage/v1/object/public/product-photos/p1/lama.webp?v=1'}]};
    if (/\/storage\/v1\/object\/product-photos\//.test(url)) return n.__denyUpload && opt.method === 'POST' ? {status: 403, body: {statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy'}} : {status: 200, body: {Key: 'ok'}};
    if (/\/rest\/v1\/products\?id=eq\./.test(url) && opt.method === 'PATCH') return {status: 200, body: n.__noRow ? [] : [{id: 'p1'}]};
    return {status: 404, body: {message: 'x'}};
  };
  const w = load(h2); w.S.setOutlet('o1');
  await w.S.call('setting.logo', {data: 'L1;8x8;t;AAAA', aktif: true}, good);
  ok(n.settings_set.values.logo_data === 'L1;8x8;t;AAAA' && n.settings_set.values.logo_aktif === true, 'setting.logo menyimpan logo_data dan mengaktifkannya saat pertama');
  await w.S.call('setting.logo', {data: ''}, good);
  ok(n.settings_set.values.logo_data === '' && n.settings_set.values.logo_aktif === false, 'setting.logo kosong => logo dihapus dan dinonaktifkan');
  const ad = await w.S.call('addon.create', {nama: 'Kantong Kresek', harga: 500, hpp: 100, stok: 50}, good);
  ok(n.addon_create.outlet_id === 'o1' && n.addon_create.nama === 'Kantong Kresek' && ad.sku === 'KK', 'addon.create => rpc_addon_create + outlet aktif');
  const oh = await w.S.call('overhead.saran', {}, good);
  ok(n.overhead_saran.outlet_id === 'o1' && oh.saran_per_unit === 310.5, 'overhead.saran => rpc_overhead_saran');
  const sh = await w.S.call('shopee.import', {orders: [{order_id: 'A1', items: []}, {order_id: 'A2', items: []}], abaikan_stok: false}, good);
  ok(n.shopee_import.outlet_id === 'o1' && n.shopee_import.abaikan_stok === false && sh.ok === 2, 'shopee.import => rpc_shopee_import dengan pilihan stok dan outlet aktif');
  await w.S.call('shopee.import', {orders: [{order_id: 'A3', items: []}]}, good);
  ok(n.shopee_import.abaikan_stok === true, 'shopee.import: abaikan stok kurang aktif secara bawaan');
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');
  const f1 = await w.S.call('produk.foto', {product_id: '11111111-1111-1111-1111-111111111111', data: jpg}, good);
  const up = w.calls.filter(c => /\/storage\/v1\/object\/product-photos\//.test(c.url) && c.opt.method === 'POST').pop();
  ok(/^https:\/\/abc\.supabase\.co\/storage\/v1\/object\/public\/product-photos\/11111111-1111-1111-1111-111111111111\/[a-z0-9]+\.jpg$/.test(f1.foto_url), 'produk.foto mengembalikan alamat publik di bucket product-photos');
  ok(up && up.opt.headers['Content-Type'] === 'image/jpeg' && up.opt.body.length === 8 && up.opt.headers.Authorization === 'Bearer ' + good, 'foto diunggah sebagai biner dengan tipe isi dari berkas dan token pengguna');
  const pt = w.calls.filter(c => /\/rest\/v1\/products\?id=eq\./.test(c.url) && c.opt.method === 'PATCH').pop();
  ok(pt && pt.body.photo_url === f1.foto_url, 'alamat foto disimpan di products.photo_url');
  ok(w.calls.some(c => c.opt.method === 'DELETE' && /product-photos\/p1\/lama\.webp$/.test(c.url)), 'berkas foto lama dibuang setelah foto baru tersimpan');
  const f2 = await w.S.call('produk.foto', {product_id: '11111111-1111-1111-1111-111111111111', data: ''}, good);
  ok(f2.foto_url === '' && w.calls.filter(c => /\/rest\/v1\/products\?id=eq\./.test(c.url) && c.opt.method === 'PATCH').pop().body.photo_url === null, 'produk.foto kosong => photo_url dikosongkan');
  try { await w.S.call('produk.foto', {product_id: 'x', data: jpg}, good); ok(false, 'id produk tidak valid'); } catch (e) { ok(e.server && /tidak valid/.test(e.message), 'produk.foto menolak id produk tidak valid'); }
  try { await w.S.call('produk.foto', {product_id: '11111111-1111-1111-1111-111111111111', data: Buffer.from('hello world').toString('base64')}, good); ok(false, 'format salah'); } catch (e) { ok(e.server && /Format foto/.test(e.message), 'produk.foto menolak format selain JPG/PNG/WebP'); }
  try { await w.S.call('produk.foto', {product_id: '11111111-1111-1111-1111-111111111111', data: Buffer.alloc(262145, 0xff).toString('base64').replace(/^/, '/9j/')}, good); ok(false, 'terlalu besar'); } catch (e) { ok(e.server && /terlalu besar/.test(e.message), 'produk.foto menolak foto di atas batas 256 KB'); }
  n.__denyUpload = true; try { await w.S.call('produk.foto', {product_id: '11111111-1111-1111-1111-111111111111', data: jpg}, good); ok(false, 'kasir ditolak'); } catch (e) { ok(e.server && /Owner atau Admin/.test(e.message), 'unggah ditolak RLS => pesan Indonesia'); } n.__denyUpload = false;
  n.__noRow = true; const del0 = w.calls.length; try { await w.S.call('produk.foto', {product_id: '11111111-1111-1111-1111-111111111111', data: jpg}, good); ok(false, 'tanpa baris'); } catch (e) { ok(/tidak tersimpan/.test(e.message) && w.calls.slice(del0).some(c => c.opt.method === 'DELETE'), 'gagal menyimpan alamat => berkas yang baru diunggah dibersihkan'); } n.__noRow = false;
  // ---- P0-1: user.save tidak boleh menurunkan/mengubah peran secara diam-diam ----
  const us = load((url, opt, body) => {
    if (/grant_type=password/.test(url)) return {status: 200, body: {access_token: good, refresh_token: 'r1'}};
    if (/rpc_bootstrap/.test(url)) return {status: 200, body: boot('supervisor')};
    if (/rpc_membership_set/.test(url)) return {status: 200, body: {ok: 1}};
    if (/functions\/v1\/admin-users/.test(url)) return {status: 200, body: {id: 'u9'}};
    return {status: 404, body: {message: 'x'}};
  });
  const lg = await us.S.call('login', {username: 'tia', pin: '123789'});
  ok(lg.role === 'supervisor', 'login meneruskan peran asli (supervisor tidak dipetakan ke kasir): ' + lg.role);
  const edge = () => us.calls.filter(c => /admin-users/.test(c.url)), nRpc = () => us.calls.filter(c => /rpc_membership_set/.test(c.url)).length;
  await us.S.call('user.save', {id: 'u9', nama: 'Nama Baru', aktif: true}, good);
  ok(nRpc() === 0, 'edit tanpa mengubah peran TIDAK memanggil membership_set');
  ok(edge().length === 1 && edge()[0].body.action === 'update' && edge()[0].body.user_id === 'u9' && !('role' in edge()[0].body), 'edit tanpa peran => hanya Edge Function update, tanpa role');
  await us.S.call('user.save', {id: 'u9', nama: 'X', aktif: true, role: 'supervisor'}, good);
  ok(nRpc() === 0 && edge().length === 2, 'P1-6: perubahan peran TIDAK lagi memanggil membership_set dari klien; satu permintaan saja ke Edge Function');
  ok(edge()[1].body.role === 'supervisor' && edge()[1].body.outlet_id === 'o1' && edge()[1].body.user_id === 'u9', 'peran supervisor dikirim apa adanya (bukan dipaksa kasir), bersama outlet aktif');
  for (const r of ['admin', 'stok', 'produksi', 'auditor']) { await us.S.call('user.save', {id: 'u9', nama: 'X', aktif: true, role: r}, good); ok(edge().pop().body.role === r, 'peran ' + r + ' diteruskan'); }
  await us.S.call('user.save', {id: 'u9', nama: 'X', aktif: true, role: 'owner'}, good);
  { const eb = edge().pop().body; ok(eb.role === 'owner' && eb.outlet_id === undefined, 'owner => keanggotaan global (tanpa outlet_id)'); }
  try { await us.S.call('user.save', {id: 'u9', nama: 'X', aktif: true, role: 'hacker'}, good); ok(false, 'peran tak dikenal harus ditolak'); } catch (e) { ok(e.server && /tidak dikenal/.test(e.message), 'peran tak dikenal ditolak, tidak diam-diam jadi kasir'); }
  const n0 = us.calls.length; try { await us.S.call('user.save', {nama: 'Baru', username: 'baru', pin: '135792'}, good); ok(false, 'buat tanpa peran'); } catch (e) { ok(e.server && /Peran wajib/.test(e.message) && us.calls.length === n0, 'buat pengguna tanpa peran ditolak sebelum memanggil server'); }
  await us.S.call('user.save', {nama: 'Baru', username: 'baru', pin: '135792', role: 'stok'}, good);
  { const cb = us.calls.filter(c => /admin-users/.test(c.url)).pop().body; ok(cb.role === 'stok' && JSON.stringify(cb.outlet_ids) === '["o1"]', 'buat pengguna: peran stok pada outlet aktif'); }
  const lst = load((url) => {
    if (/\/profiles\?/.test(url)) return {status: 200, body: [{id: 'a', username: 'a', full_name: 'A', status: 'active'}]};
    if (/\/memberships\?/.test(url)) return {status: 200, body: [{user_id: 'a', role: 'kasir', outlet_id: 'o1', status: 'active'}, {user_id: 'a', role: 'owner', outlet_id: null, status: 'active'}]};
    return {status: 404, body: {message: 'x'}};
  });
  ok((await lst.S.call('user.list', {}, good))[0].role === 'owner', 'user.list menampilkan peran tertinggi, bukan urutan acak');

  // ---- P0-3: penjaga versi skema ----
  const sg = (reply, cfg) => { const x = load((url, opt, body) => /grant_type=password/.test(url) ? {status: 200, body: {access_token: good, refresh_token: 'r1'}} : /rpc_bootstrap/.test(url) ? {status: 200, body: boot('kasir')} : {status: 404, body: {message: 'x'}}, cfg); x.schema.reply = reply; return x; };
  let sgx = sg(() => ({status: 200, body: {version: '20261031000025', min_client: '2.3.0'}}), {VERSION: '2.3.1'});
  ok((await sgx.S.call('login', {username: 'tia', pin: '123789'})).uid === 'u1', 'skema sama dengan MIN_SCHEMA => login lolos');
  const nSch = () => sgx.calls.filter(c => /rpc_schema_version/.test(c.url)).length, n1 = nSch();
  await sgx.S.call('bootstrap', {}, good); ok(nSch() === n1, 'hasil pemeriksaan skema disimpan sementara (bootstrap tidak memanggil ulang)');
  sgx = sg(() => ({status: 404, body: {code: 'PGRST202', message: 'Could not find the function public.rpc_schema_version'}}), {VERSION: '2.3.1'});
  try { await sgx.S.call('login', {username: 'tia', pin: '123789'}); ok(false, 'DB tanpa rpc_schema_version harus memblokir'); } catch (e) { ok(e.schema && /belum diperbarui/.test(e.message), 'fungsi versi tidak ada => DB belum dimigrasi: ' + e.message); }
  ok(sgx.store.sb_rt === undefined || sgx.store.sb_rt === null, 'login yang diblokir skema tidak meninggalkan refresh token');
  sgx = sg(() => ({status: 200, body: {version: '20261027000015', min_client: '2.3.0'}}), {VERSION: '2.3.1'});
  try { await sgx.S.call('login', {username: 'tia', pin: '123789'}); ok(false, 'DB lebih lama harus memblokir'); } catch (e) { ok(e.schema && /20261027000015/.test(e.message), 'DB lebih lama dari MIN_SCHEMA => diblokir'); }
  sgx = sg(() => ({status: 200, body: {version: '20261031000025', min_client: '9.0.0'}}), {VERSION: '2.3.1'});
  try { await sgx.S.call('login', {username: 'tia', pin: '123789'}); ok(false, 'klien terlalu lama harus memblokir'); } catch (e) { ok(e.schema && /terlalu lama/.test(e.message), 'klien lebih lama dari min_client => minta perbarui'); }
  sgx = sg(() => ({status: 200, body: {version: 'unknown', min_client: '2.3.0'}}), {VERSION: '2.3.1'});
  ok((await sgx.S.call('login', {username: 'tia', pin: '123789'})).uid === 'u1', "versi 'unknown' (migrasi tanpa CLI) tidak memblokir klien");
  sgx = sg(() => new Error('offline'), {VERSION: '2.3.1'});
  try { await sgx.S.call('login', {username: 'tia', pin: '123789'}); ok(false, 'jaringan putus'); } catch (e) { ok(!e.schema, 'jaringan putus BUKAN dianggap skema lama'); }

  { // blok sendiri: nama variabel tidak bentrok dengan tes lain
  // ---- P1-5: persetujuan diskon dari server, tanpa JWT approver di antrean ----
  const U1 = '11111111-1111-1111-1111-111111111111', U2 = '22222222-2222-2222-2222-222222222222';
  const ap = load((url, opt, body) => {
    if (/grant_type=password/.test(url)) return {status: 200, body: {access_token: body.email.startsWith('own') ? 'T_OWNER' : 'T_KASIR', refresh_token: 'x'}};
    if (/rpc_bootstrap/.test(url)) return {status: 200, body: boot(opt.headers.Authorization === 'Bearer T_OWNER' ? 'owner' : 'kasir')};
    if (/rpc_(report_konsolidasi|sale_reject_log)/.test(url)) return {status: 200, body: {ok: true}};
    if (/rpc_approval_issue/.test(url)) return {status: 200, body: {approval_id: 'aaaaaaaa-0000-0000-0000-000000000001'}};
    if (/rpc_sale_create|rpc_sale_batch/.test(url)) return {status: 200, body: /batch/.test(url) ? [{ok: true, data: {}}] : {sale: {nomor: 'X-1'}}};
    return {status: 404, body: {message: 'x'}};
  });
  await ap.S.call('outlet.use', {id: 'o1'});   // tanpa login: token uji bukan JWT sungguhan (login menyimpan refresh token dan memicu penyegaran)
  const gd = await ap.S.call('override.grant', {username: 'owner1', pin: '123789', kind: 'diskon', request_id: 'rq-diskon-1', nilai: 5000}, 'T_KASIR');
  ok(gd.token === 'sbap:aaaaaaaa-0000-0000-0000-000000000001', 'override.grant(diskon) mengembalikan id persetujuan server, bukan JWT: ' + gd.token);
  const ai = ap.calls.filter(c => /rpc_approval_issue/.test(c.url)).pop();
  ok(ai.opt.headers.Authorization === 'Bearer T_OWNER' && ai.body.p.request_id === 'rq-diskon-1' && ai.body.p.amount === 5000 && ai.body.p.kind === 'diskon' && ai.body.p.outlet_id === 'o1', 'persetujuan diterbitkan dengan token PENYETUJU, terikat request_id dan nominal');
  const gh = await ap.S.call('override.grant', {username: 'owner1', pin: '123789', kind: 'hapus', request_id: 'rq-hapus-01', nilai: 0}, 'T_KASIR');
  ok(gh.token.indexOf('sbap:') === 0 && ap.calls.filter(c => /rpc_approval_issue/.test(c.url)).pop().body.p.kind === 'hapus', 'persetujuan hapus-antrean juga lewat server');
  await ap.S.call('sale.reject_log', {request_id: 'rq-hapus-01', aksi: 'hapus', alasan: 'batal', override_token: gh.token}, 'T_KASIR');
  const rl = ap.calls.filter(c => /rpc_sale_reject_log/.test(c.url)).pop(); ok(rl.body.p.approval_id === gh.token.slice(5) && !('override_token' in rl.body.p), 'reject_log membawa approval_id, bukan token');
  await ap.S.call('report.get', {type: 'konsolidasi', from: '2026-10-01', to: '2026-10-30'}, 'T_KASIR');
  const rk = ap.calls.filter(c => /rpc_report_konsolidasi/.test(c.url)).pop(); ok(rk && rk.body.p.type === 'konsolidasi' && !('outlet_id' in rk.body.p), 'F-07: report.get(konsolidasi) => rpc_report_konsolidasi tanpa outlet');
  await ap.S.call('sale.batch', {sales: [{request_id: 'rq-diskon-1', items: [], override: {diskon: gd.token}}]}, 'T_KASIR');
  const bb = ap.calls.filter(c => /rpc_sale_batch/.test(c.url)).pop(), s0 = bb.body.p.sales[0];
  ok(s0.approval_id === 'aaaaaaaa-0000-0000-0000-000000000001' && !('override' in s0) && bb.opt.headers.Authorization === 'Bearer T_KASIR', 'sale.batch: approval_id dikirim dengan token kasir; override tidak diteruskan');
  ok(!JSON.stringify(ap.calls.filter(c => /rpc_sale_batch/.test(c.url)).map(c => c.body)).includes('T_OWNER'), 'tidak ada JWT approver dalam payload batch');
  await ap.S.call('sale.create', {request_id: 'rq-diskon-2', items: [], override: {diskon: gd.token}}, 'T_KASIR');
  const sc2 = ap.calls.filter(c => /rpc_sale_create/.test(c.url)).pop();
  ok(sc2.body.p.approval_id && sc2.opt.headers.Authorization === 'Bearer T_KASIR', 'sale.create dengan sbap: memakai token kasir + approval_id');

  // ---- P1-2: sale.lookup ----
  const lk = load((url) => /\/sales\?/.test(url) ? {status: 200, body: /rq-ada-0001/.test(url) ? [{id: 's1', receipt_no: 'OUT-001-261029-001', outlet_id: 'o1', total: '20000.00'}] : []} : {status: 404, body: {message: 'x'}});
  const f1 = await lk.S.call('sale.lookup', {request_id: 'rq-ada-0001'}, good); ok(f1.sale && f1.sale.nomor === 'OUT-001-261029-001' && f1.sale.total === 20000, 'sale.lookup menemukan transaksi yang sudah tercatat');
  const f2 = await lk.S.call('sale.lookup', {request_id: 'rq-tidak-ada'}, good); ok(f2.sale === null, 'sale.lookup: tidak ada => sale null');
  try { await lk.S.call('sale.lookup', {request_id: "x' or 1=1"}, good); ok(false, 'request_id jahat'); } catch (e) { ok(e.server && /tidak valid/.test(e.message), 'sale.lookup menolak request_id tidak valid'); }

  // ---- P1-3: master.remove tidak boleh pura-pura sukses ----
  const rm = (rows) => load((url, opt) => /\/rest\/v1\/(channel_prices|products|suppliers)\?/.test(url) ? {status: 200, body: rows} : {status: 404, body: {message: 'x'}});
  let m = rm([{variant_id: U1, channel_id: U2}]);
  const d1 = await m.S.call('master.remove', {table: 'channel_prices', id: U1 + ':' + U2}, good);
  const dc = m.calls.filter(c => /channel_prices\?/.test(c.url)).pop();
  ok(d1.id === U1 + ':' + U2 && dc.opt.method === 'DELETE' && /variant_id=eq\./.test(dc.url) && /channel_id=eq\./.test(dc.url) && dc.opt.headers.Prefer === 'return=representation', 'channel_prices => DELETE sungguhan pada kunci majemuk');
  m = rm([]); try { await m.S.call('master.remove', {table: 'channel_prices', id: U1 + ':' + U2}, good); ok(false, 'tanpa baris'); } catch (e) { ok(/tidak terhapus/.test(e.message), 'DELETE tanpa baris terkena => galat, bukan sukses palsu'); }
  m = rm([{id: U1}]); await m.S.call('master.remove', {table: 'suppliers', id: U1}, good);
  const pc = m.calls.filter(c => /suppliers\?/.test(c.url)).pop(); ok(pc.opt.method === 'PATCH' && pc.body.active === false, 'tabel ber-active => nonaktifkan (hapus lunak)');
  m = rm([]); try { await m.S.call('master.remove', {table: 'suppliers', id: U1}, good); ok(false, 'PATCH tanpa baris'); } catch (e) { ok(/tidak terhapus/.test(e.message), 'PATCH tanpa baris => galat'); }
  try { await m.S.call('master.remove', {table: 'expenses', id: U1}, good); ok(false, 'tabel tak didukung'); } catch (e) { ok(/belum didukung/.test(e.message), 'tabel tak didukung => galat eksplisit'); }
  try { await m.S.call('master.remove', {table: 'channel_prices', id: 'bukan-uuid'}, good); ok(false, 'id buruk'); } catch (e) { ok(/tidak valid/.test(e.message), 'id harga tidak valid ditolak'); }
  const pb = load((url, opt, body) => /grant_type=password/.test(url) ? {status: 200, body: {access_token: good, refresh_token: 'r1'}} : /rpc_bootstrap/.test(url) ? {status: 200, body: Object.assign(boot('owner'), {prices: [{variant_id: U1, channel_id: U2, harga_jual: 5000}]})} : {status: 404, body: {message: 'x'}});
  const bl = await pb.S.call('login', {username: 'tia', pin: '123789'}); const bs = await pb.S.call('bootstrap', {}, good);
  ok(bs.prices[0].id === U1 + ':' + U2, 'bootstrap memberi id majemuk pada baris harga');

  // ---- P1-4: logout membersihkan outlet tersimpan dan refresh token ----
  const lo = load((url) => /grant_type=password/.test(url) ? {status: 200, body: {access_token: good, refresh_token: 'r9'}} : /rpc_bootstrap/.test(url) ? {status: 200, body: boot('kasir')} : {status: 200, body: {}});
  await lo.S.call('login', {username: 'tia', pin: '123789'}); ok(lo.store.sb_outlet === 'o1' && lo.store.sb_rt === 'r9', 'prasyarat: outlet dan refresh token tersimpan');
  await lo.S.call('logout', {}, good); ok(!lo.store.sb_outlet && !lo.store.sb_rt, 'logout menghapus sb_outlet dan sb_rt');

  }
  console.log(fail ? 'GAGAL: ' + fail + ' dari ' + (pass + fail) : 'Semua lulus (' + pass + ' pemeriksaan)'); process.exit(fail ? 1 : 0);
})();
