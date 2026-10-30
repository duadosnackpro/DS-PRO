/* Adapter Supabase (v2.1.0). Menerjemahkan "aksi" UI ke Supabase Auth + RPC/REST, supaya UI v2.0.0 tetap dipakai.
   Aktif bila SUPABASE_URL (https://<ref>.supabase.co) dan SUPABASE_KEY terisi. Tanpa dependensi: memakai fetch langsung ke GoTrue dan PostgREST.
   Tidak ada kunci rahasia di sini: hanya publishable/anon key. Otorisasi sebenarnya ada di RLS dan fungsi database. */
(function () {
'use strict';
const C = /** @type {any} */ (window.CONFIG || {});
const enabled = () => /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(C.SUPABASE_URL || '') && !!C.SUPABASE_KEY;
const EMAIL_DOMAIN = '@users.duado.local';
const LSK = {rt: 'sb_rt', outlet: 'sb_outlet'};
const ls = {get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }};
let outletId = ls.get(LSK.outlet) || null, refreshing = null, onToken = null, lastBoot = null, myUid = null;

const fail = (msg, o) => Object.assign(new Error(msg), {server: true}, o || {});
const uuid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
function jwtExp(t) { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000; } catch (e) { return 0; } }

async function raw(path, opt, token) {
  let r;
  try {
    r = await fetch(C.SUPABASE_URL + path, Object.assign({}, opt, {headers: Object.assign({apikey: C.SUPABASE_KEY, 'Content-Type': 'application/json'}, token ? {Authorization: 'Bearer ' + token} : {}, (opt && opt.headers) || {})}));
  } catch (e) { throw new Error('Tidak ada koneksi ke server'); }   // bukan e.server => dianggap galat jaringan oleh antrean
  let j = null; try { j = await r.json(); } catch (e) {}
  return {status: r.status, ok: r.ok, body: j};
}
function mapErr(r) {
  const b = r.body || {}, msg = b.message || b.msg || b.error_description || b.error || ('Galat server ' + r.status), code = b.code || '';
  if (r.status === 401 || code === '28000' || /JWT|Sesi berakhir/i.test(msg)) return fail(/Sesi/.test(msg) ? msg : 'Sesi berakhir, silakan masuk lagi.', {auth: true});
  const transient = r.status >= 500 || r.status === 429 || ['40001', '40P01', '55P03', '57014'].indexOf(code) >= 0;
  return fail(msg, {retry: transient, code});
}
async function refresh() {
  if (refreshing) return refreshing;
  const rt = ls.get(LSK.rt); if (!rt) throw fail('Sesi berakhir, silakan masuk lagi.', {auth: true});
  return refreshing = (async () => {
    const r = await raw('/auth/v1/token?grant_type=refresh_token', {method: 'POST', body: JSON.stringify({refresh_token: rt})});
    if (!r.ok) { ls.set(LSK.rt, null); throw fail('Sesi berakhir, silakan masuk lagi.', {auth: true}); }
    ls.set(LSK.rt, r.body.refresh_token); if (onToken) onToken(r.body.access_token); return r.body.access_token;
  })().finally(() => { refreshing = null; });
}
async function authed(path, opt, token) {
  if (token && jwtExp(token) - Date.now() < 60000 && ls.get(LSK.rt)) token = await refresh();
  let r = await raw(path, opt, token);
  if (r.status === 401 && ls.get(LSK.rt) && !(opt && opt.noRetry)) { token = await refresh(); r = await raw(path, opt, token); }
  if (!r.ok) throw mapErr(r);
  return r.body;
}
const rpc = (name, p, token) => authed('/rest/v1/rpc/rpc_' + name, {method: 'POST', body: JSON.stringify({p: p || {}})}, token);
const rest = (path, token, opt) => authed('/rest/v1/' + path, opt || {method: 'GET'}, token);
const withOutlet = p => Object.assign({outlet_id: outletId}, p || {});

/* ---- Peran (P0-1): peran asli dari server diteruskan apa adanya ke UI; tidak ada lagi pemetaan ke 'owner'/'kasir'.
   Layar mana yang tampil ditentukan UI lewat can(); penegakan hak akses tetap di server. ---- */
const ROLE_ORDER = ['owner', 'admin', 'supervisor', 'stok', 'produksi', 'kasir', 'auditor'];   // sama dengan urutan prioritas di app.bootstrap
const MANAGE_ROLES = ['owner', 'admin'];

/* ---- Penjaga versi skema (P0-3) ----
   MIN_SCHEMA = migrasi terakhir yang dibutuhkan klien ini (harus ada di supabase/migrations; dijaga tests/release_check.js).
   Database lebih lama => berhenti dengan pesan jelas (bukan galat 404 acak di tengah transaksi).
   Database mensyaratkan klien lebih baru (min_client) => minta perangkat memperbarui aplikasi. */
const MIN_SCHEMA = '20261031000024';
const semverLt = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; };
let schemaOkAt = 0;
async function checkSchema(token) {
  if (Date.now() - schemaOkAt < 30 * 60000) return;
  let r;
  try { r = await rpc('schema_version', {}, token); }
  catch (e) { if (e.code === 'PGRST202' || /rpc_schema_version/.test(e.message || '')) throw fail('Database belum diperbarui ke versi yang dibutuhkan aplikasi ini. Hubungi admin sebelum memakai aplikasi.', {schema: true}); throw e; }
  const v = String((r && r.version) || '');
  if (/^\d{10,}$/.test(v) && v < MIN_SCHEMA) throw fail('Database belum diperbarui ke versi yang dibutuhkan aplikasi ini (' + v + ' < ' + MIN_SCHEMA + '). Hubungi admin sebelum memakai aplikasi.', {schema: true});
  if (r && r.min_client && C.VERSION && semverLt(C.VERSION, r.min_client)) throw fail('Aplikasi di perangkat ini terlalu lama untuk database (butuh ' + r.min_client + '). Tutup lalu buka ulang aplikasi untuk memperbarui.', {schema: true});
  schemaOkAt = Date.now();
}

function toLegacyBoot(b) {
  const role = b.role || (b.outlets[0] && b.outlets[0].role) || 'kasir';
  b.user.role = role; myUid = b.user.uid;
  if (Array.isArray(b.prices)) b.prices.forEach(x => { if (x.id === undefined) x.id = x.variant_id + ':' + x.channel_id; });   // id majemuk: baris harga dapat diubah/dihapus dari UI
  if (!b.channels) b.channels = []; b.cat_ver = b.cat_ver || ''; b.stock_ver = b.stock_ver || '';
  if (b.outlet) outletId = b.outlet.id, ls.set(LSK.outlet, outletId);
  ['materials', 'suppliers', 'recipes', 'recipe_items'].forEach(k => { if (b.role && MANAGE_ROLES.indexOf(role) >= 0 && !b[k]) b[k] = []; });
  return b;
}

/* ---- Pemetaan master data legacy <-> tabel Supabase (hanya kolom yang dipakai UI) ---- */
const MASTER = {
  channels: {t: 'channels', m: {nama: 'name', fee_persen: 'fee_percent', fee_tetap: 'fee_fixed', basis_fee: 'fee_basis', aktif: 'active'}},
  products: {t: 'products', m: {nama: 'name', kategori: 'category', aktif: 'active', foto_url: 'photo_url'}},
  product_variants: {t: 'product_variants', m: {product_id: 'product_id', sku: 'sku', ukuran: 'size', level_pedas: 'spice_level', aktif: 'active'}},
  suppliers: {t: 'suppliers', m: {nama: 'name', kontak: 'contact', catatan: 'notes', aktif: 'active'}},
  materials: {t: 'materials', m: {nama: 'name', tipe: 'type', satuan: 'unit', stok_minimum: 'min_stock', satuan_kecil: 'small_unit', faktor_kecil: 'small_factor', aktif: 'active'}},
  channel_prices: {t: 'channel_prices', m: {variant_id: 'variant_id', channel_id: 'channel_id', harga_jual: 'price'}, key: ['variant_id', 'channel_id']}
};
const bool = v => v === true || String(v).toUpperCase() === 'TRUE';
function toDb(cfg, d) { const o = {}; Object.keys(cfg.m).forEach(k => { if (d[k] !== undefined) { let v = d[k]; if (cfg.m[k] === 'active') v = bool(v); if (v === '') v = null; o[cfg.m[k]] = v; } }); return o; }
function toLegacy(cfg, r) { const o = {id: cfg.key ? cfg.key.map(k => r[cfg.m[k]]).join(':') : r.id}; Object.keys(cfg.m).forEach(k => { o[k] = r[cfg.m[k]]; }); return o; }

async function masterSave(p, token) {
  if (p.table === 'expenses') {
    const r = await rpc('expense_create', {outlet_id: p.data.lingkup === 'pusat' ? null : outletId, request_id: uuid(), kategori: p.data.kategori, nominal: Number(p.data.nominal), catatan: p.data.catatan, tanggal: p.data.tanggal || undefined}, token);
    return Object.assign({id: r.id}, p.data);
  }
  const cfg = MASTER[p.table]; if (!cfg) throw fail('Tabel ini belum didukung di backend Supabase: ' + p.table);
  const d = p.data || {}, body = toDb(cfg, d);
  if (cfg.key) { // channel_prices: upsert pada pasangan kunci
    const r = await rest(cfg.t + '?on_conflict=' + cfg.key.map(k => cfg.m[k]).join(','), token, {method: 'POST', headers: {Prefer: 'resolution=merge-duplicates,return=representation'}, body: JSON.stringify(body)});
    return toLegacy(cfg, r[0]);
  }
  const r = d.id ? await rest(cfg.t + '?id=eq.' + encodeURIComponent(d.id), token, {method: 'PATCH', headers: {Prefer: 'return=representation'}, body: JSON.stringify(body)})
                 : await rest(cfg.t, token, {method: 'POST', headers: {Prefer: 'return=representation'}, body: JSON.stringify(body)});
  if (!r || !r[0]) throw fail('Data tidak tersimpan (tidak ada izin atau tidak ditemukan).');
  return toLegacy(cfg, r[0]);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// P1-3: tidak pernah melaporkan sukses bila tidak ada baris yang terkena. Tabel dengan kolom 'active' dinonaktifkan (hapus lunak);
// channel_prices (tanpa kolom active, kunci majemuk 'variant_id:channel_id') dihapus sungguhan; selain itu galat eksplisit.
async function masterRemove(p, token) {
  const cfg = MASTER[p.table]; if (!cfg) throw fail('Tabel ini belum didukung: ' + p.table);
  const rep = {Prefer: 'return=representation'};
  let r;
  if (cfg.key) {
    const [v, c] = String(p.id || '').split(':');
    if (!UUID_RE.test(v || '') || !UUID_RE.test(c || '')) throw fail('ID harga tidak valid.');
    r = await rest(cfg.t + '?variant_id=eq.' + v + '&channel_id=eq.' + c, token, {method: 'DELETE', headers: rep});
  } else if (cfg.m.aktif) {
    if (!UUID_RE.test(String(p.id || ''))) throw fail('ID tidak valid.');
    r = await rest(cfg.t + '?id=eq.' + encodeURIComponent(p.id), token, {method: 'PATCH', headers: rep, body: JSON.stringify({active: false})});
  } else throw fail('Tabel ini tidak mendukung penghapusan: ' + p.table);
  if (!Array.isArray(r) || !r.length) throw fail('Data tidak terhapus (tidak ada izin, atau sudah tidak ada).');
  return {id: p.id};
}

/* ---- Persetujuan supervisor/owner (token persetujuan): PIN approver diverifikasi oleh Supabase Auth ---- */
async function overrideGrant(p) {
  const r = await raw('/auth/v1/token?grant_type=password', {method: 'POST', body: JSON.stringify({email: String(p.username || '').trim().toLowerCase() + EMAIL_DOMAIN, password: p.pin})});
  if (!r.ok) throw fail('Username atau PIN approver salah.');
  const t = r.body.access_token;
  const boot = await rpc('bootstrap', {outlet_id: outletId}, t);
  if (['owner', 'admin', 'supervisor'].indexOf(boot.role) < 0) throw fail('Akun ini tidak berwenang menyetujui di outlet ini.');
  // P1-5: persetujuan DISKON diterbitkan server dengan token penyetuju lalu token itu dibuang. Yang dibawa pulang hanya id persetujuan
  // (sekali pakai, terikat request_id dan nominal, berlaku 72 jam), aman disimpan di antrean offline. JWT penyetuju tidak pernah masuk antrean.
  // P0 (F-03): retur dan hapus-antrean juga memakai persetujuan terbitan server (sekali pakai). Retur terikat ke transaksi asal (ref_id) dan nilai maksimum;
  // kasir memanggil RPC dengan TOKEN SENDIRI sehingga retur tercatat di sesi/laci kasir, bukan di sesi penyetuju.
  if (['diskon', 'retur', 'hapus'].indexOf(p.kind) >= 0) {
    const a = await rpc('approval_issue', {outlet_id: outletId, kind: p.kind, request_id: p.request_id, amount: p.nilai, ref_id: p.ref_id}, t);
    return {token: 'sbap:' + a.approval_id};
  }
  throw fail('Jenis persetujuan tidak dikenal.');
}
const approver = tok => (typeof tok === 'string' && tok.indexOf('sbov:') === 0) ? tok.slice(5) : null;
const approvalId = tok => (typeof tok === 'string' && tok.indexOf('sbap:') === 0) ? tok.slice(5) : null;
// Ubah override.diskon 'sbap:<id>' menjadi approval_id untuk server; sisanya (termasuk 'sbov:' lama) dibuang dari payload.
function withApproval(x) { const q = Object.assign(withOutlet(), x), id = q.override && approvalId(q.override.diskon); delete q.override; if (id) q.approval_id = id; return q; }

/* ---- Aksi yang dilayani fungsi database dengan bentuk keluaran yang sama seperti UI v2.0.0 ---- */
// recipe_save di database hanya mengembalikan header resep, sedangkan patchRecipe() di UI memerlukan daftar bahannya.
// Bahan dibaca ulang; bila gagal dibaca, kembalikan {} supaya UI memuat ulang seluruh data (resep sudah tersimpan).
async function recipeSave(p, token) {
  const r = await rpc('recipe_save', p, token);
  if (Array.isArray(r.items)) return {recipe: r.recipe, items: r.items};   // 0011: fungsi mengembalikan header + bahan dalam satu transaksi
  try { return {recipe: r.recipe, items: await rest('recipe_items?select=id,recipe_id,material_id,qty&recipe_id=eq.' + encodeURIComponent(r.recipe.id), token)}; }
  catch (e) { return {}; }
}
async function masterList(p, token) {
  if (p.table !== 'expenses') throw fail('Daftar untuk tabel ini belum didukung di backend Supabase: ' + p.table);
  const rows = await rest('expenses?select=id,expense_date,category,amount,note,outlet_id,void_of,cash_session_id&or=(outlet_id.eq.' + outletId + ',outlet_id.is.null)&order=expense_date.desc,created_at.desc&limit=200', token);
  const voided = {}; rows.forEach(x => { if (x.void_of) voided[x.void_of] = true; });   // F-16: biaya yang sudah punya baris pembalik
  return rows.map(x => ({id: x.id, tanggal: x.expense_date, kategori: x.outlet_id ? x.category : x.category + ' (Pusat)', nominal: Number(x.amount), catatan: x.note || '',
    pembalik: !!x.void_of, dibatalkan: !!voided[x.id], dari_laci: !!x.cash_session_id}));
}
// Pemeriksaan kesesuaian stok: saldo dibandingkan dengan jumlah riwayat mutasinya (rpc_stock_reconcile). Nama item diambil dari bootstrap.
async function stockAudit(token) {
  const [rec, b] = await Promise.all([rpc('stock_reconcile', withOutlet(), token), rpc('bootstrap', {outlet_id: outletId}, token)]);
  const prod = {}, nm = {}, n = x => Number(x) || 0;
  (b.products || []).forEach(x => { prod[x.id] = x.nama; });
  (b.variants || []).forEach(v => { nm['variant:' + v.id] = ((prod[v.product_id] || '?') + ' ' + [v.ukuran, v.level_pedas].filter(Boolean).join(' · ')).trim(); });
  (b.materials || []).forEach(m => { nm['material:' + m.id] = m.nama; });
  return {
    diperiksa: (b.variants || []).length + (b.materials || []).length,
    selisih: (rec.selisih || []).map(x => ({tipe: x.item_type === 'variant' ? 'varian' : 'bahan', id: x.item_id, nama: nm[x.item_type + ':' + x.item_id] || '(item tidak aktif)', stok: n(x.saldo), riwayat: n(x.ledger), selisih: n(x.selisih)})),
    penjualan_proses: [], selisih_total: [], penjualan_tanpa_item: []   // di server penjualan selalu atomik: kondisi ini tidak bisa terjadi
  };
}

/* ---- Logo struk: disimpan sebagai pengaturan global logo_data/logo_aktif lewat rpc_settings_set (hanya owner/admin) ---- */
function logoSave(p, token) {
  const values = {logo_data: p.data || ''};
  if (!p.data) values.logo_aktif = false; else if (p.aktif) values.logo_aktif = true;
  return rpc('settings_set', {values: values}, token);
}

/* ---- Foto produk: berkas ke Supabase Storage (bucket publik product-photos, tulis hanya owner/admin), alamat disimpan di products.photo_url ---- */
const PHOTO_BUCKET = 'product-photos', PHOTO_MAX = 262144;
const photoBase = () => C.SUPABASE_URL + '/storage/v1/object/public/' + PHOTO_BUCKET + '/';
const photoPathOf = u => (typeof u === 'string' && u.indexOf(photoBase()) === 0) ? u.slice(photoBase().length).split('?')[0] : null;
function photoKind(b64) { return b64.indexOf('/9j/') === 0 ? ['jpg', 'image/jpeg'] : b64.indexOf('UklGR') === 0 ? ['webp', 'image/webp'] : b64.indexOf('iVBOR') === 0 ? ['png', 'image/png'] : null; }
async function productPhoto(p, token) {
  const pid = String(p.product_id || ''); if (!/^[0-9a-f-]{36}$/i.test(pid)) throw fail('Produk tidak valid.');
  const cur = await rest('products?select=photo_url&id=eq.' + pid, token), old = cur && cur[0] ? photoPathOf(cur[0].photo_url) : null;
  let path = null, url = '';
  if (p.data) {
    const b64 = String(p.data), kind = photoKind(b64); if (!kind) throw fail('Format foto tidak didukung (gunakan JPG, PNG, atau WebP).');
    let bytes; try { const bin = atob(b64); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); } catch (e) { throw fail('Data foto tidak terbaca.'); }
    if (bytes.length > PHOTO_MAX) throw fail('Foto terlalu besar (maks. 256 KB setelah dikecilkan).');
    path = pid + '/' + Date.now().toString(36) + '.' + kind[0];
    try { await authed('/storage/v1/object/' + PHOTO_BUCKET + '/' + path, {method: 'POST', headers: {'Content-Type': kind[1], 'cache-control': 'max-age=31536000'}, body: bytes}, token); }
    catch (e) { throw (e.server && /row-level security|unauthorized|not allowed/i.test(e.message)) ? fail('Hanya Owner atau Admin yang boleh mengubah foto produk.') : e; }
    url = photoBase() + path;
  }
  let r; try { r = await rest('products?id=eq.' + pid, token, {method: 'PATCH', headers: {Prefer: 'return=representation'}, body: JSON.stringify({photo_url: url || null})}); }
  catch (e) { if (path) { try { await authed('/storage/v1/object/' + PHOTO_BUCKET + '/' + path, {method: 'DELETE'}, token); } catch (e2) {} } throw e; }
  if (!r || !r[0]) { if (path) { try { await authed('/storage/v1/object/' + PHOTO_BUCKET + '/' + path, {method: 'DELETE'}, token); } catch (e) {} } throw fail('Foto tidak tersimpan (tidak ada izin atau produk tidak ditemukan).'); }
  if (old && old !== path) { try { await authed('/storage/v1/object/' + PHOTO_BUCKET + '/' + old, {method: 'DELETE'}, token); } catch (e) {} }   // berkas lama dibuang; gagal pun tidak masalah
  return {foto_url: url};
}

/* F2: daftar transfer yang menyangkut outlet aktif (asal atau tujuan), beserta itemnya. RLS membatasi baris; kolom biaya item tidak dapat dibaca klien. */
async function transferList(token) {
  const o = encodeURIComponent(outletId);
  const rows = await rest('stock_transfers?select=id,number,status,from_outlet_id,to_outlet_id,requested_by,approved_by,sent_by,received_by,sent_at,received_at,note,created_at&or=(from_outlet_id.eq.' + o + ',to_outlet_id.eq.' + o + ')&order=created_at.desc&limit=60', token);
  if (!rows.length) return [];
  const its = await rest('stock_transfer_items?select=id,transfer_id,item_type,item_id,qty_requested,qty_sent,qty_received,variance&transfer_id=in.(' + rows.map(x => x.id).join(',') + ')', token), by = {};
  its.forEach(i => { (by[i.transfer_id] = by[i.transfer_id] || []).push({tipe: i.item_type, item_id: i.item_id, diminta: Number(i.qty_requested), dikirim: i.qty_sent == null ? null : Number(i.qty_sent), diterima: i.qty_received == null ? null : Number(i.qty_received), selisih: i.variance == null ? null : Number(i.variance)}); });
  return rows.map(x => ({id: x.id, nomor: x.number, status: x.status, dari_id: x.from_outlet_id, ke_id: x.to_outlet_id, pembuat: x.requested_by, penyetuju: x.approved_by, catatan: x.note || '', dibuat: x.created_at, dikirim_pada: x.sent_at, diterima_pada: x.received_at, items: by[x.id] || []}));
}

async function call(action, p, token, tokCb) {
  onToken = tokCb || onToken; p = p || {};
  switch (action) {
    case 'login': {
      const u = String(p.username || '').trim().toLowerCase();
      const r = await raw('/auth/v1/token?grant_type=password', {method: 'POST', body: JSON.stringify({email: u + EMAIL_DOMAIN, password: p.pin})});
      if (!r.ok) throw fail(r.status === 429 ? 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.' : 'Username atau PIN salah.');
      ls.set(LSK.rt, r.body.refresh_token);
      schemaOkAt = 0; try { await checkSchema(r.body.access_token); } catch (e) { ls.set(LSK.rt, null); throw e; }
      let b; try { b = toLegacyBoot(await rpc('bootstrap', {outlet_id: outletId}, r.body.access_token)); } catch (e) { throw fail('Akun belum diaktifkan di outlet mana pun. Hubungi Owner.'); }
      lastBoot = b; return {token: r.body.access_token, role: b.user.role, nama: b.user.nama, uid: b.user.uid, pin_lemah: false};
    }
    case 'logout': { schemaOkAt = 0; try { await raw('/auth/v1/logout?scope=local', {method: 'POST'}, token); } catch (e) {} ls.set(LSK.rt, null); ls.set(LSK.outlet, null); outletId = null; myUid = null; lastBoot = null; return {ok: true}; }
    case 'bootstrap': { await checkSchema(token); const b = toLegacyBoot(await rpc('bootstrap', {outlet_id: outletId}, token)); lastBoot = null; return b; }
    case 'ping': { const r = await rpc('ping', withOutlet(), token); return r; }
    case 'stock.get': return rpc('stock_get', withOutlet(), token);
    case 'override.grant': return overrideGrant(p);
    case 'sale.create': { const ap = p.override && approver(p.override.diskon), q = withApproval(p);
      if (ap) { if (myUid) q.kasir_id = myUid; return rpc('sale_create', q, ap); }   // jalur lama (antrean versi sebelumnya): token approver langsung
      return rpc('sale_create', q, token); }
    case 'sale.batch': return rpc('sale_batch', {sales: (p.sales || []).map(withApproval)}, token);
    case 'sale.lookup': { // P1-2: apakah transaksi dengan request_id ini sudah tercatat? (untuk memulihkan galat 23505 pada antrean)
      if (!p.request_id || !/^[A-Za-z0-9_-]{8,80}$/.test(String(p.request_id))) throw fail('request_id tidak valid.');
      const r = await rest('sales?select=id,receipt_no,outlet_id,total&request_id=eq.' + encodeURIComponent(p.request_id) + '&limit=1', token);
      return r && r[0] ? {sale: {id: r[0].id, nomor: r[0].receipt_no, outlet_id: r[0].outlet_id, total: Number(r[0].total)}} : {sale: null};
    }
    case 'sale.return': { const id = approvalId(p.override_token), q = Object.assign({}, p); delete q.override_token; if (id) q.approval_id = id; return rpc('sale_return', q, token); }
    case 'sale.review': return rpc('sale_review', p, token);   // Owner/Supervisor menandai transaksi bertanda 'perlu ditinjau' sudah ditinjau
    case 'sale.detail': return rpc('sale_detail', p, token);
    case 'sales.list': return rpc('sales_list', withOutlet(p), token);
    case 'sale.reject_log': { const q = withOutlet(p), id = approvalId(q.override_token); delete q.override_token; if (id) q.approval_id = id; return rpc('sale_reject_log', q, token); }   // F3: dicatat di audit_logs (pelaku, outlet, alasan)
    case 'sale.recover': throw fail('Tidak diperlukan: transaksi di server selalu atomik (selesai atau tidak tercatat).');
    case 'shift.summary': return rpc('cash_summary', withOutlet(), token);
    case 'shift.open': return rpc('cash_open', withOutlet(p), token);                 // F4: modal awal ditetapkan saat buka
    case 'cash.move': return rpc('cash_movement_add', p, token);                      // F4: kas masuk/keluar dengan alasan wajib
    case 'shift.close': return rpc('cash_close', p, token);
    case 'shift.list': {
      return rpc('shift_list', withOutlet(), token);   // F-17: nama kasir, fisik_sebelumnya, status tinjauan; waktu dalam zona outlet (F-14)
    }
    case 'shift.approve': return rpc('cash_approve', {id: p.id, catatan: p.catatan}, token);                          // F-17
    case 'expense.void': return rpc('expense_void', {id: p.id, alasan: p.alasan, request_id: p.request_id || uuid()}, token);   // F-16
    case 'purchase.list': {                                                                                           // F-16: pembelian terakhir outlet aktif
      const rows = await rest('purchases?select=id,purchased_at,doc_ref,total,status,note,cancel_reason,supplier_id&outlet_id=eq.' + encodeURIComponent(outletId) + '&order=purchased_at.desc&limit=30', token);
      return rows.map(x => ({id: x.id, waktu: x.purchased_at, ref: x.doc_ref || '', total: Number(x.total), status: x.status, catatan: x.note || '', alasan_batal: x.cancel_reason || '', supplier_id: x.supplier_id}));
    }
    case 'purchase.cancel': return rpc('purchase_cancel', {id: p.id, alasan: p.alasan, request_id: p.request_id || uuid()}, token);
    case 'period.lock': return rpc('period_lock_set', {sampai: p.sampai, alasan: p.alasan}, token);                    // F-15 (Owner)
    case 'hpp.backfill': return rpc('hpp_backfill', withOutlet({from: p.from, to: p.to, terapkan: !!p.terapkan}), token);   // F-08
    case 'stock.adjust': return rpc('stock_adjust', withOutlet(p), token);
    case 'purchase.create': return rpc('purchase_create', withOutlet(Object.assign({request_id: uuid()}, p)), token);
    case 'production.create': return rpc('production_create', Object.assign({kitchen_outlet_id: outletId, output_outlet_id: outletId}, p), token);
    case 'production.complete': return rpc('production_complete', p, token);
    case 'production.cancel': return rpc('production_cancel', p, token);
    case 'production.list': return rpc('production_list', withOutlet(p), token);
    case 'dashboard.get': return rpc('dashboard', withOutlet(p), token);
    case 'report.get': return (p.type === 'konsolidasi' || p.type === 'konsolidasi_stok') ? rpc('report_konsolidasi', {type: p.type, from: p.from, to: p.to}, token) : rpc('report_legacy', withOutlet(p), token);   // F-07: semua outlet
    case 'recipe.save': return recipeSave(p, token);
    case 'recipe.copy': return rpc('recipe_copy', p, token);
    case 'master.list': return masterList(p, token);
    case 'stock.audit': return stockAudit(token);
    case 'stock.reconcile': throw fail('Di Supabase saldo stok selalu ditulis bersama riwayatnya, jadi selisih tidak dirapikan dengan menerima saldo. Gunakan "Hitung ulang (opname)" agar koreksinya tercatat di riwayat.');
    case 'setting.setMany': return rpc('settings_set', {values: p.values}, token);
    case 'master.save': return masterSave(p, token);
    case 'master.remove': return masterRemove(p, token);
    case 'sistem.refresh': return {ok: true};
    /* ---- Administrasi outlet (baru) ---- */
    case 'outlet.create': return rpc('outlet_create', Object.assign({request_id: uuid()}, p), token);
    case 'outlet.update': return rpc('outlet_update', p, token);
    case 'outlet.use': outletId = p.id; ls.set(LSK.outlet, outletId); return {id: outletId};
    case 'member.list': {
      const m = await rest('memberships?select=user_id,role,status,outlet_id&or=(outlet_id.eq.' + encodeURIComponent(p.outlet_id) + ',outlet_id.is.null)', token);
      const ids = m.map(x => x.user_id); if (!ids.length) return [];
      const pr = await rest('profiles?select=id,username,full_name&id=in.(' + ids.join(',') + ')', token), by = {}; pr.forEach(x => by[x.id] = x);
      return m.map(x => ({nama: (by[x.user_id] || {}).full_name || '?', username: (by[x.user_id] || {}).username || '?', role: x.outlet_id ? x.role : x.role + ' (semua outlet)', status: x.status}));
    }
    case 'user.list': {
      const pr = await rest('profiles?select=id,username,full_name,status&order=full_name', token);
      const m = await rest('memberships?select=user_id,role,outlet_id,status&status=eq.active', token), by = {};
      m.forEach(x => { if (!x.outlet_id || x.outlet_id === outletId) (by[x.user_id] = by[x.user_id] || []).push(x.role); });
      const top = rs => (rs || []).slice().sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b))[0] || '-';   // peran tertinggi, bukan urutan acak
      let locked = {}; try { (await rpc('user_locks', {}, token)).forEach(l => { locked[l.user_id] = l.sampai; }); } catch (e) { /* hanya owner/admin yang boleh membaca; peran lain tidak membuka layar ini */ }
      return pr.map(x => ({id: x.id, nama: x.full_name, username: x.username, role: top(by[x.id]), aktif: x.status === 'active', terkunci: !!locked[x.id]}));
    }
    case 'user.save': { // pembuatan akun Auth membutuhkan kunci rahasia: dilakukan Edge Function admin-users (verifikasi owner/admin di sisi server)
      // P0-1: 'role' hanya dikirim UI bila pengguna benar-benar mengubahnya. Tanpa 'role', membership tidak disentuh.
      // Nilai tak dikenal ditolak; tidak pernah diam-diam dijadikan 'kasir'.
      const role = p.role || null;
      if (role && ROLE_ORDER.indexOf(role) < 0) throw fail('Peran tidak dikenal: ' + role);
      if (!p.id) {
        if (!role) throw fail('Peran wajib dipilih.');
        return authed('/functions/v1/admin-users', {method: 'POST', body: JSON.stringify({action: 'create', username: p.username, full_name: p.nama, pin: p.pin, role, outlet_ids: role === 'owner' ? [] : [outletId]})}, token);
      }
      // P1-6: satu permintaan ke Edge Function (peran + PIN + status + nama). Edge Function mengubah peran lewat rpc_membership_set dengan JWT pemanggil,
      // jadi aturan database tetap berlaku dan tidak ada lagi dua panggilan terpisah dari klien yang bisa berhenti di tengah.
      return authed('/functions/v1/admin-users', {method: 'POST', body: JSON.stringify({action: 'update', user_id: p.id, full_name: p.nama, pin: p.pin || undefined, status: bool(p.aktif) ? 'active' : 'inactive',
        role: role || undefined, outlet_id: role && role !== 'owner' ? outletId : undefined})}, token);
    }
    case 'setting.logo': return logoSave(p, token);
    case 'produk.foto': return productPhoto(p, token);
    case 'addon.create': return rpc('addon_create', withOutlet(p), token);
    case 'overhead.saran': return rpc('overhead_saran', withOutlet(), token);
    case 'shopee.import': return rpc('shopee_import', withOutlet({orders: p.orders, abaikan_stok: p.abaikan_stok !== false}), token);
    case 'transfer.create': return rpc('transfer_create', Object.assign({request_id: uuid()}, p), token);
    case 'transfer.action': return rpc('transfer_action', Object.assign({request_id: uuid()}, p), token);
    case 'transfer.list': return transferList(token);
    case 'user.unlock': return rpc('user_unlock', {user_id: p.id}, token);
    default: throw fail('Fitur "' + action + '" belum dipindahkan ke backend Supabase (belum tersedia).');
  }
}
window.SBAPI = {enabled: enabled, call: call, outlet: () => outletId, setOutlet: id => { outletId = id; ls.set(LSK.outlet, id); }};
})();
