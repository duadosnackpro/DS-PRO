/* ---------- Menu, data master, pengguna, pengaturan ---------- */
const standalone = () => !!((window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true);
function confirmLogout() {
  const p = S.queue.length; if (!confirm(p ? 'Masih ada ' + p + ' transaksi yang belum terkirim ke server. Transaksi itu tetap tersimpan di perangkat dan dikirim saat Anda masuk lagi. Tetap keluar?' : 'Keluar dari akun ini?')) return;
  S.dirty = false; logout();
}
function vMenu() {
  const u = S.data.user, o = own(), nIssue = o && APP.issueCount ? APP.issueCount() : 0;
  const mi = (a, ic, t, sub, cl, bd) => '<button class="mi ' + (cl || '') + '" data-act="' + a + '"><span class="mi-i">' + svg(ic, 20) + '</span><span class="mi-t"><b>' + t + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</span>' + (bd ? '<span class="mi-b" aria-label="' + bd + ' masalah">' + bd + '</span>' : '') + svg('chev', 18) + '</button>';
  const inst = S.installEv && !standalone() ? '<div class="grp">' + mi('install', 'install', 'Pasang di layar utama', 'Buka lebih cepat, tanpa lewat browser') + '</div>' :
    (isIOS() && !standalone() ? '<div class="li" style="display:block"><b>Pasang di layar utama</b><div class="muted">Di Safari, ketuk Bagikan, lalu pilih "Tambah ke Layar Utama".</div></div>' : '');
  $('#main').innerHTML = '<div class="profile"><div class="av">' + esc(String(u.nama || '?').charAt(0).toUpperCase()) + '</div><div class="pi"><b>' + esc(u.nama) + '</b><div class="muted">' + esc(roleName(u.role)) + ' · versi ' + esc(C.VERSION || '') + '</div></div><span class="badge ' + (navigator.onLine ? 'ok' : 'off') + '">' + (navigator.onLine ? 'Online' : 'Offline') + '</span></div>' +
    '<p class="muted note">' + (S.lastSync ? 'Data diperbarui terakhir pukul ' + fmtDT(S.lastSync).slice(11) + '.' : 'Data masih dari penyimpanan perangkat.') + '</p>' + inst +
    ((o || can('report') || can('transfer') || can('sell') || can('history')) ? '<div class="grp"><h3>Operasional</h3>' + (o || (can('history') && !can('sell')) ? mi('go_riwayat', 'riwayat', 'Riwayat penjualan', 'Daftar transaksi per tanggal') : '') + (can('report') ? mi('go_laporan', 'laporan', 'Laporan', can('cost') ? 'Laba rugi, penjualan, HPP, stok' : 'Penjualan, stok, produksi, pembelian') : '') + (can('transfer') ? mi('go_transfer', 'master', 'Transfer stok', 'Kirim dan terima stok antar outlet') : '') + (can('sell') ? mi('go_tutup', 'riwayat', 'Buka dan tutup kasir', 'Modal awal, kas masuk dan keluar, hitung uang di laci') : '') + (o ? mi('go_cek', 'cek', 'Pemeriksaan data', nIssue ? nIssue + ' hal perlu dibereskan' : 'Tidak ada yang perlu dibereskan', '', nIssue) : '') + '</div>' : '') + (o ?
      '<div class="grp"><h3>Data</h3>' + mi('go_master', 'master', 'Data Master', 'Produk, varian, harga, bahan, resep, biaya') + mi('go_shopee', 'shopee', 'Impor pesanan Shopee', 'Unggah file CSV dari Shopee') + mi('go_users', 'users', 'Pengguna', 'Akun dan hak akses') + (S.data.outlets ? mi('go_outlets', 'master', 'Outlet', 'Tambah outlet dan atur statusnya') : '') + mi('go_settings', 'settings', 'Pengaturan', 'Usaha, PPN, stok, printer, HPP') + '</div>' : '') +
    '<div class="grp"><h3>Sistem</h3>' + mi('sync', 'sync', 'Perbarui data', own() ? 'Ambil data terbaru dan kirim transaksi yang menunggu' : 'Cek data baru dan kirim transaksi yang menunggu') + mi('go_diag', 'diag', 'Diagnostik dan tes cetak', 'Tes koneksi, printer, dan WhatsApp') + '</div>' +
    (can('takeover') ? '<div class="grp"><h3>Hati-hati</h3>' + mi('go_reset', 'trash', 'Reset data transaksi', 'Hapus penjualan, kas, dan riwayat stok outlet ' + esc(S.data.outlet ? S.data.outlet.code : 'ini'), 'danger') + '</div>' : '') +
    '<div class="grp grp-out">' + mi('logout', 'out', 'Keluar', esc(u.nama), 'danger') + '</div>';
}
function vDiag() {
  setTimeout(() => { // bandingkan versi config.js dengan versi cache sw.js: beda = unggahan web/ tidak lengkap, sehingga banner pembaruan tidak akan muncul
    const el = $('#dver'); if (!el || !window.caches) return;
    caches.keys().then(ks => {
      const sw = ks.filter(k => /^duado-v/.test(k)).map(k => k.slice(7)), me = String(C.VERSION || ''), kv = (a, b) => '<div class="kv"><span>' + a + '</span><span>' + b + '</span></div>'; if (!$('#dver')) return;
      $('#dver').innerHTML = kv('Versi cache (sw.js)', esc(sw.join(', ') || '-')) +
        (sw.length > 1 ? '<p class="muted">Pembaruan sudah diunduh dan menunggu. Tutup lalu buka ulang aplikasi, atau tekan Muat ulang pada banner.</p>' : sw.length === 1 && sw[0] !== me ? '<p class="err">Versi config.js (' + esc(me) + ') dan sw.js (' + esc(sw[0]) + ') tidak sama. Unggah ulang SELURUH isi folder web/ (isi API_URL di config.js tetap milik Anda), lalu buka ulang aplikasi.</p>' : '');
    }).catch(() => {});
  }, 0);
  const q = S.queue, errs = LS.get('errlog', []), kv = (a, b) => '<div class="kv"><span>' + a + '</span><span>' + b + '</span></div>', standalone = window.matchMedia && matchMedia('(display-mode: standalone)').matches;
  $('#main').innerHTML = '<button class="chip" data-act="tab" data-t="menu">← Menu</button><div class="card-s"><h3>Info perangkat</h3>' + kv('Versi aplikasi', esc(C.VERSION || '-')) + '<div id="dver"></div>' + kv('Versi data', esc(dverKey() || '-')) + kv('Layar tersimpan (cache)', Object.keys(VC).length + ' hasil') + kv('Mode', standalone ? 'Terpasang (layar utama)' : 'Browser') + kv('Koneksi', navigator.onLine ? 'Online' : 'Offline') +
    kv('Android (untuk RawBT)', isAndroid() ? 'Ya' : 'Tidak') + kv('Fitur Bagikan', navigator.share ? 'Tersedia' : 'Tidak tersedia') + kv('Antrean transaksi', q.filter(x => x.status === 'pending').length + ' menunggu, ' + q.filter(x => x.status === 'review').length + ' perlu ditinjau') + kv('Lebar struk', rcWidth() + ' karakter') + '</div>' +
    '<div class="card-s"><h3>Uji koneksi dan kecepatan server</h3><button class="btn sec" data-act="dping">Uji koneksi</button><div id="dres" class="muted" style="margin-top:6px"></div></div>' +
    btDiagCard() +
    '<div class="card-s"><h3>Uji struk</h3><p class="muted">Memeriksa WhatsApp dan printer tanpa membuat transaksi.</p><div class="row2"><button class="btn wa" data-act="dtwa">Uji WhatsApp</button><button class="btn dark" data-act="dtbt">Uji cetak Bluetooth</button></div><button class="btn sec" data-act="dtshare">Uji Bagikan</button>' +
    '<p class="muted">Jalur RawBT (Android): pasang RawBT dari Play Store, pasangkan printer di dalam RawBT, lalu coba cetak dari RawBT dulu. Jalur BLE langsung: pilih printer BLE sekali di kartu Printer Bluetooth di atas.</p></div>' +
    '<div class="card-s"><h3>Catatan kesalahan</h3>' + (errs.length ? errs.slice(0, 8).map(e => '<div class="muted" style="margin-bottom:6px">' + esc(fmtDT(e.t).slice(5)) + ' · ' + esc(e.c) + ': ' + esc(e.m) + '</div>').join('') : '<p class="muted">Belum ada.</p>') + '<div class="row2"><button class="btn sec" data-act="dcopy">Salin log</button><button class="btn sec" data-act="dclear">Hapus catatan</button></div><p class="muted">Galat dari ekstensi browser tidak ikut dicatat.</p></div>';
}
const RT = {};
const MT = {
  products: {l: 'Produk', k: 'products', f: [['nama', 'Nama produk'], ['kategori', 'Kategori (mis. Basreng)']], t: r => r.nama + (r.kategori ? ' · ' + r.kategori : '')},
  product_variants: {l: 'Varian', k: 'variants', f: [['product_id', 'Produk', 'ref:products'], ['sku', 'SKU (kosongkan untuk otomatis)'], ['ukuran', 'Ukuran kemasan (mis. 100 g)'], ['level_pedas', 'Level pedas (mis. Level 3)']], t: r => vName(r) + ' · ' + vSub(r)},
  channel_prices: {l: 'Harga jual', k: 'prices', f: [['variant_id', 'Varian', 'ref:variants'], ['channel_id', 'Channel', 'ref:channels'], ['harga_jual', 'Harga jual (Rp)', 'number']], t: r => { const v = vById(r.variant_id); return (v ? vName(v) + ' ' + vSub(v) : '?') + ' · ' + chName(r.channel_id) + ' · ' + rp(r.harga_jual); }},
  materials: {l: 'Bahan dan kemasan', k: 'materials', f: [['nama', 'Nama'], ['tipe', 'Tipe', 'sel:bahan,kemasan,barang jadi beli'], ['satuan', 'Satuan (kg, gram, pcs)'], ['stok_minimum', 'Stok minimum', 'number'], ['satuan_kecil', 'Satuan kecil untuk resep (opsional, mis. ml)'], ['faktor_kecil', 'Isi satuan kecil per 1 satuan (mis. 1000)', 'number']], t: r => r.nama + ' (' + r.satuan + ')'},
  suppliers: {l: 'Supplier', k: 'suppliers', f: [['nama', 'Nama'], ['kontak', 'Kontak'], ['catatan', 'Catatan']], t: r => r.nama},
  expenses: {l: 'Biaya operasional', k: 'expenses', f: [['tanggal', 'Tanggal', 'date'], ['kategori', 'Kategori', 'sel:Gas,Listrik,Air,Sewa,Gaji/Tenaga kerja,Transport,Pemasaran,Lain-lain'], ['nominal', 'Nominal (Rp)', 'number'], ['lingkup', 'Dicatat pada', 'sel2:outlet|Outlet aktif,pusat|Pusat (semua outlet; tidak dibagi otomatis)'], ['catatan', 'Catatan']], t: r => String(r.tanggal).slice(0, 10) + ' · ' + r.kategori + ' · ' + rp(r.nominal)},
  channels: {l: 'Channel', k: 'channels', f: [['nama', 'Nama'], ['fee_persen', 'Fee (%)', 'number'], ['fee_tetap', 'Fee tetap (Rp)', 'number'], ['basis_fee', 'Fee dihitung dari', 'sel2:total|Total bayar (termasuk PPN),subtotal|Subtotal (sebelum diskon),omzet|Omzet bersih (tanpa PPN)']], t: r => r.nama + ' · fee ' + (r.fee_persen || 0) + '%'}
};
Object.keys(MT).forEach(k => RT[MT[k].k] = MT[k].t);
function field(f, val) {
  const k = f[0], l = f[1], t = f[2] || '', v = val == null ? '' : val;
  if (t.indexOf('ref:') === 0) { const key = t.slice(4); return '<label>' + l + '<select class="inp" data-f="' + k + '"><option value="">- pilih -</option>' + S.data[key].map(r => '<option value="' + esc(r.id) + '"' + (r.id === v ? ' selected' : '') + '>' + esc(RT[key](r)) + '</option>').join('') + '</select></label>'; }
  if (t.indexOf('sel:') === 0) return '<label>' + l + '<select class="inp" data-f="' + k + '">' + t.slice(4).split(',').map(o => '<option' + (o === v ? ' selected' : '') + '>' + o + '</option>').join('') + '</select></label>';
  if (t.indexOf('sel2:') === 0) return '<label>' + l + '<select class="inp" data-f="' + k + '">' + t.slice(5).split(',').map(o => { const p = o.split('|'); return '<option value="' + p[0] + '"' + (p[0] === v ? ' selected' : '') + '>' + p[1] + '</option>'; }).join('') + '</select></label>';
  if (t.indexOf('area') === 0) return '<label>' + l + '<textarea class="inp ta" rows="3" maxlength="' + (Number(t.slice(5)) || 300) + '" data-f="' + k + '">' + esc(v) + '</textarea></label>';
  if (t === 'date') return '<label>' + l + '<input type="date" class="inp" data-f="' + k + '" value="' + esc(String(v).slice(0, 10)) + '"></label>';
  const uq = a => Array.from(new Set(a.filter(Boolean))), D = S.data || {products: [], variants: []};
  const sug = k === 'kategori' ? uq((D.products || []).map(p => p.kategori)) : k === 'ukuran' ? uq((D.variants || []).map(x => x.ukuran).concat(['50 g', '100 g', '250 g', '500 g'])) :
    k === 'level_pedas' ? uq((D.variants || []).map(x => x.level_pedas).concat(['Original', 'Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5'])) : null;
  return '<label>' + l + '<input class="inp" data-f="' + k + '"' + (sug ? ' list="dl_' + k + '"' : '') + (t === 'number' ? ' inputmode="decimal"' : '') + ' value="' + esc(v) + '">' +
    (sug ? '<datalist id="dl_' + k + '">' + sug.map(x => '<option value="' + esc(x) + '">').join('') + '</datalist>' : '') + '</label>';
}
function readForm() { const o = {}; document.querySelectorAll('#sheet [data-f]').forEach(e => o[e.dataset.f] = e.type === 'checkbox' ? e.checked : e.value); return o; }
function vMaster(noLoad) {
  const cfg = MT[S.mt], rows = S.mt === 'expenses' ? (S.exp || []) : (S.data[cfg.k] || []);
  $('#main').innerHTML = '<button class="chip" data-act="tab" data-t="menu">← Menu</button><div class="chips" style="margin-top:8px">' + Object.keys(MT).map(k => '<button class="chip ' + (k === S.mt ? 'on' : '') + '" data-act="mt" data-k="' + k + '">' + MT[k].l + '</button>').join('') + '<button class="chip" data-act="go_resep">Resep</button></div>' +
    '<button class="btn pri" data-act="medit" data-id="">+ Tambah ' + cfg.l.toLowerCase() + '</button><div style="height:8px"></div>' +
    rows.map(r => '<button class="li" style="width:100%;border:0;font:inherit;text-align:left" data-act="medit" data-id="' + esc(r.id) + '"><span' + (r.dibatalkan || r.pembalik ? ' style="text-decoration:' + (r.dibatalkan ? 'line-through' : 'none') + ';opacity:.7"' : '') + '>' + esc(cfg.t(r)) + (r.dibatalkan ? ' (dibatalkan)' : r.pembalik ? ' (pembatalan)' : '') + '</span><span class="muted">' + (S.mt === 'expenses' ? 'Rincian' : 'Ubah') + '</span></button>').join('') + (S.mt === 'expenses' && !S.expLoaded ? skel(3) : '');
  if (S.mt === 'expenses' && !noLoad) loadExp();
}
async function loadExp() { await vload('master.list', {table: 'expenses'}, r => { S.exp = r; S.expLoaded = true; if (S.tab === 'master' && S.mt === 'expenses') vMaster(true); }, {fail: e => toast(e.message)}); }
function meditSheet(id) {
  const cfg = MT[S.mt], r = id ? (S.mt === 'expenses' ? S.exp : S.data[cfg.k]).find(x => x.id === id) : {tanggal: today()};
  S.fotoFor = S.mt === 'products' ? id : null;
  if (S.mt === 'expenses' && id) { // F-16: biaya tidak diubah; salah catat dibatalkan (baris pembalik + alasan), lalu dicatat ulang dengan benar
    const st = r.dibatalkan ? '<p class="muted">Biaya ini sudah dibatalkan.</p>' : r.pembalik ? '<p class="muted">Ini baris pembatalan; tidak dapat dibatalkan lagi.</p>' : r.dari_laci ? '<p class="muted">Berasal dari kas keluar laci (uang sudah keluar dari laci), tidak bisa dibatalkan di sini.</p>' :
      '<label>Alasan pembatalan<input class="inp" id="xv_r" placeholder="Min. 3 huruf"></label><button class="btn dan" data-act="expvoid" data-id="' + esc(id) + '">Batalkan biaya</button>';
    sheet('<h2>Rincian biaya</h2><div class="li" style="display:block"><div class="kv"><span>Tanggal</span><span>' + esc(r.tanggal) + '</span></div><div class="kv"><span>Kategori</span><span>' + esc(r.kategori) + '</span></div><div class="kv"><span>Nominal</span><span>' + rp(r.nominal) + '</span></div><div class="muted">' + esc(r.catatan) + '</div></div>' + st); return;
  }
  sheet('<h2>' + (id ? 'Ubah ' : 'Tambah ') + cfg.l.toLowerCase() + '</h2>' + (S.mt === 'products' ? fotoBox(id) : '') + cfg.f.map(f => field(f, r[f[0]])).join('') + (S.mt === 'product_variants' ? '<button class="btn sec sm" data-act="skugen" data-id="' + esc(id) + '">Buat SKU otomatis</button>' : '') + '<button class="btn pri" data-act="msave" data-id="' + esc(id) + '">Simpan</button>' + (id ? '<button class="btn dan" data-act="mdel" data-id="' + esc(id) + '">Hapus</button>' : ''));
}
async function mSave(id) {
  return busy('Menyimpan data…', async () => {
  const data = readForm(); if (id) data.id = id;
  ['harga_jual', 'fee_persen', 'fee_tetap', 'stok_minimum', 'nominal', 'faktor_kecil'].forEach(k => { if (k in data) data[k] = dnum(data[k]) || 0; });
  try { const rec = await api('master.save', {table: S.mt, data: data}); S.expLoaded = false; if (!patchMaster(S.mt, rec)) await loadData(); closeSheet(); render(); toast('Tersimpan'); } catch (e) { toast(e.message); }
  });
}
/* Setelah simpan, server mengembalikan rekaman terbaru: perangkat cukup memperbarui satu baris, tanpa mengunduh ulang seluruh data (dulu: dua permintaan berurutan). */
const PATCH_KEY = {products: 'products', product_variants: 'variants', channel_prices: 'prices', channels: 'channels', materials: 'materials', suppliers: 'suppliers'};
function patchMaster(t, rec) {
  const k = PATCH_KEY[t]; if (!k || !rec || !rec.id || !S.data[k] || String(rec.aktif) === 'false') return false;
  if (t === 'product_variants' && !S.data.products.some(p => p.id === rec.product_id)) return false;
  rec = Object.assign({}, rec); delete rec.created_at; delete rec.updated_at;
  if (t === 'product_variants' || t === 'materials') { const old = S.data[k].find(x => x.id === rec.id); if (old) { rec.stok = old.stok; rec.hpp_rata2 = own() ? rec.hpp_rata2 : old.hpp_rata2; } } // stok hanya berubah lewat transaksi
  const i = S.data[k].findIndex(x => x.id === rec.id); if (i >= 0) S.data[k][i] = Object.assign({}, S.data[k][i], rec); else S.data[k].push(rec);
  idxReset(); LS.set('data', S.data); return true;
}
function patchRecipe(r) {
  if (!r || !r.recipe || !S.data.recipes) return false; const rec = Object.assign({}, r.recipe); delete rec.created_at; delete rec.updated_at;
  const i = S.data.recipes.findIndex(x => x.id === rec.id); if (i >= 0) S.data.recipes[i] = rec; else S.data.recipes.push(rec);
  S.data.recipe_items = (S.data.recipe_items || []).filter(x => x.recipe_id !== rec.id).concat(r.items); LS.set('data', S.data); return true;
}
async function mDel(id) {
  return busy('Menghapus…', async () => {
  if (!confirm('Hapus data ini?')) return;
  try { await api('master.remove', {table: S.mt, id: id}); S.expLoaded = false; await loadData(); closeSheet(); render(); toast('Dihapus'); } catch (e) { toast(e.message); }
  });
}
async function vUsers() {
  $('#main').innerHTML = '<button class="chip" data-act="tab" data-t="menu">← Menu</button><button class="btn pri" data-act="uedit" data-id="">+ Tambah pengguna</button><div id="ul">' + skel(3) + '</div>';
  await vload('user.list', undefined, users => { S.users = users; if (!$('#ul')) return; $('#ul').innerHTML = S.users.map(u => '<button class="li" style="width:100%;border:0;font:inherit;text-align:left;margin-top:8px" data-act="uedit" data-id="' + esc(u.id) + '"><span><b>' + esc(u.nama) + '</b> <span class="muted">@' + esc(u.username) + '</span></span><span class="urow-b"><span class="badge role">' + esc(roleName(u.role)) + '</span>' + (String(u.aktif) === 'false' ? '<span class="tag red">Nonaktif</span>' : '') + (u.terkunci ? '<span class="tag red">Terkunci</span>' : '') + '</span></button>').join(''); },
    {fail: e => { if ($('#ul')) $('#ul').innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; }});
}
/* F8: Owner/Admin/Auditor memakai kata sandi (min. 10 karakter, huruf+angka); peran operasional memakai PIN 6-10 angka. Aturan yang sama ditegakkan Edge Function admin-users. */
const PRIV_ROLES = ['owner', 'admin', 'auditor'];
function credLabel(role, id) { return (PRIV_ROLES.indexOf(role) >= 0 ? 'Kata sandi (min. 10 karakter, huruf dan angka)' : 'PIN (6-10 angka, tidak berurutan/berulang)') + (id ? ', kosongkan jika tidak diganti' : ''); }
function credProblem(secret, role) {
  if (PRIV_ROLES.indexOf(role) >= 0) return secret.length < 10 ? 'Kata sandi Owner/Admin/Auditor minimal 10 karakter.' : (!/[A-Za-z]/.test(secret) || !/\d/.test(secret)) ? 'Kata sandi harus memuat huruf dan angka.' : null;
  return /^\d{6,10}$/.test(secret) ? null : 'PIN harus 6-10 angka.';
}
/* P0-1: pilihan peran = peran yang boleh diberikan pemanggil + peran pengguna saat ini (supaya tidak berpindah diam-diam saat form dibuka). */
function roleOptions(cur) {
  const allow = ASSIGNABLE[S.data.user.role] || [];
  return ROLES.filter(r => allow.indexOf(r[0]) >= 0 || r[0] === cur);
}
function ueditSheet(id) {
  const u = id ? S.users.find(x => x.id === id) : {role: 'kasir', aktif: true};
  const opts = roleOptions(u.role), known = ROLES.some(r => r[0] === u.role);
  sheet('<h2>' + (id ? 'Ubah' : 'Tambah') + ' pengguna</h2>' + field(['nama', 'Nama'], u.nama) + field(['username', 'Username'], u.username) +
    selF('role', 'Peran', (known ? [] : [['', '- pilih peran -']]).concat(opts), u.role) + '<p class="muted role-info" id="role-info" aria-live="polite">' + esc(ROLE_INFO[u.role] || 'Pilih peran untuk melihat hak aksesnya.') + '</p>' +
    '<label id="pin-lbl">' + credLabel(u.role, id) + '<input class="inp" data-f="pin" type="password" autocomplete="new-password"></label><label class="sw"><input type="checkbox" data-f="aktif"' + (String(u.aktif) !== 'false' ? ' checked' : '') + '><span class="sw-t" aria-hidden="true"></span><span class="sw-l"><b>Aktif</b><small>Nonaktif: tidak bisa masuk</small></span></label>' + (id && u.terkunci ? '<div class="notice"><span>Akun ini terkunci sementara karena terlalu banyak percobaan masuk yang salah.</span><button class="chip" data-act="uunlock" data-id="' + esc(id) + '">Buka kunci</button></div>' : '') + '<button class="btn pri" data-act="usave" data-id="' + esc(id) + '">Simpan</button>');
}
async function uSave(id) {
  return busy('Menyimpan pengguna…', async () => {
  const d = readForm(); if (id) { d.id = id; const cur = (S.users.find(x => x.id === id) || {}).role; if (!d.role || d.role === cur) delete d.role; }   // P0-1: kirim peran hanya bila benar-benar diubah
  if (!id && !d.role) { toast('Pilih peran.'); return; }
  { const role = d.role || (S.users.find(x => x.id === id) || {}).role, cp = d.pin ? credProblem(String(d.pin), role) : null; if (cp) { toast(cp); return; } }   // server tetap memeriksa ulang
  try { await api('user.save', d); closeSheet(); vUsers(); toast('Tersimpan'); } catch (e) { toast(e.message); }
  });
}
const selF = (k, l, pairs, cur) => '<label>' + l + '<select class="inp" data-f="' + k + '">' + pairs.map(p => '<option value="' + p[0] + '"' + (String(cur) === p[0] ? ' selected' : '') + '>' + p[1] + '</option>').join('') + '</select></label>';
const setSnap = () => JSON.stringify(Array.from(document.querySelectorAll('#sf [data-f]')).map(e => e.type === 'checkbox' ? e.checked : e.value));
function sDepUpd() { // field yang bergantung: tarif PPN hanya saat PPN aktif; overhead sesuai cara hitung yang dipilih
  const on = k => { const e = document.querySelector('#sf [data-f=' + k + ']'); return e && e.checked; }, m = (document.querySelector('#sf [data-f=metode_overhead]') || {}).value || 'per_unit';
  const set = (id, show) => { const e = $('#' + id); if (e) e.hidden = !show; };
  set('ppn-x', on('ppn_aktif')); set('hdr-x', on('header_aktif')); set('ftr-x', on('footer_aktif')); set('oh-unit', m === 'per_unit'); set('oh-batch', m === 'per_batch');
  const h = $('#oh-hint'); if (h) h.textContent = m === 'per_batch' ? 'Biaya overhead (gas, listrik, dll.) dihitung tetap setiap sekali produksi, berapa pun hasilnya.' : 'Biaya overhead (gas, listrik, dll.) dihitung per bungkus yang dihasilkan. Contoh: Rp300 × 118 bungkus.';
}
function sDirty() { S.dirty = setSnap() !== S.sSnap; const b = $('#ssavebtn'); if (b) b.disabled = !S.dirty; sDepUpd(); }
function addonSheet() {
  sheet('<div class="grab"></div><h2>Buat produk tambahan</h2><p class="muted">Contoh: kantong kresek. Muncul di menu pembayaran kasir sebagai "Tambahan". Harga berlaku untuk semua channel; stok berkurang otomatis setiap terjual.</p>' +
    '<label>Nama<input class="inp" id="ad_n" value="Kantong Kresek"></label><div class="row2"><div style="flex:1"><label>Harga jual (Rp)<input class="inp" id="ad_h" inputmode="decimal" value="500"></label></div><div style="flex:1"><label>Biaya/HPP per buah (Rp)<input class="inp" id="ad_c" inputmode="decimal" value="0"></label></div></div>' +
    '<label>Stok awal (jumlah)<input class="inp" id="ad_s" inputmode="decimal" value="100"></label><button class="btn pri" data-act="addonsave">Simpan</button><button class="btn sec" data-act="close">Batal</button>');
}
function vSettings() {
  const s = S.data.settings, g = (k, d) => (s[k] == null || s[k] === '' ? d : s[k]), card = (t, h) => '<section class="set-card"><h3>' + t + '</h3>' + h + '</section>';
  const sw = (k, l, sub, def) => '<label class="sw"><input type="checkbox" data-f="' + k + '"' + (T(s[k] == null || s[k] === '' ? def : s[k]) ? ' checked' : '') + '><span class="sw-t" aria-hidden="true"></span><span class="sw-l"><b>' + l + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</span></label>';
  const m = $('#main'); m.className = 'col';
  m.innerHTML = '<button class="chip" data-act="tab" data-t="menu" style="align-self:flex-start">← Menu</button><div id="sf" style="margin-top:8px">' +
    card('Usaha & Struk', field(['nama_usaha', 'Nama usaha'], s.nama_usaha) + '<p class="muted" style="margin:-4px 0 8px">Dicetak sebagai judul struk hanya bila logo tidak dipakai.</p>' + selF('lebar_struk', 'Lebar kertas struk', [['32', '58 mm (area cetak 48 mm)'], ['48', '80 mm (area cetak 72 mm)']], g('lebar_struk', '32'))) +
    card('Logo struk', logoCard() + sw('logo_aktif', 'Cetak logo di struk', 'Untuk printer thermal. Nama usaha tidak dicetak lagi bila logo aktif. Struk WhatsApp tetap berupa teks.') +
      (logoGet() ? '<button class="btn sec sm" data-act="logotest">Uji cetak logo</button>' : '') + '<p class="muted">Ukuran kertas diganti (58 atau 80 mm)? Pilih ulang logo agar ukurannya pas.</p>') +
    card('Header & footer struk', sw('header_aktif', 'Header: catatan di bawah logo', 'Mis. slogan, alamat, nomor telepon, Instagram. Matikan bila tidak perlu.', true) +
      '<div id="hdr-x">' + field(['header_struk', 'Isi header', 'area:300'], s.header_struk) + '</div>' +
      sw('footer_aktif', 'Footer: catatan di bawah struk', 'Mis. ucapan terima kasih. Matikan bila tidak perlu.', true) +
      '<div id="ftr-x">' + field(['footer_struk', 'Isi footer', 'area:300'], s.footer_struk) + '</div>' +
      '<p class="muted">Satu baris di sini = satu baris di struk (teks panjang turun baris otomatis). Bungkus baris dengan *bintang* agar tercetak tebal, mis. *TERIMA KASIH*.</p>' +
      field(['qr_struk', 'Isi QR di bawah struk (opsional)', 'text'], s.qr_struk) + '<p class="muted">Mis. tautan Instagram atau WhatsApp toko. Kosongkan bila tanpa QR. Maks. 120 karakter. QR dicetak sebagai gambar, sama seperti logo.</p>' +
      '<button class="btn sec sm" data-act="rcpreview">Pratinjau &amp; uji cetak struk</button><p class="muted">Pratinjau memakai pengaturan yang sudah disimpan.</p>') +
    card('Pajak (PPN)', sw('ppn_aktif', 'Aktifkan PPN', 'Hitung PPN pada setiap transaksi') + '<div id="ppn-x">' + field(['ppn_persen', 'Tarif PPN (%)', 'number'], s.ppn_persen) + sw('ppn_inklusif', 'Harga jual sudah termasuk PPN') + '</div>') +
    card('Stok', sw('blokir_stok_minus', 'Blokir penjualan jika stok kurang', 'Kasir tidak bisa menjual produk yang stoknya habis') + field(['stok_menipis', 'Batas "Menipis" produk jadi (jumlah)', 'number'], g('stok_menipis', '5'))) +
    card('Kantong & Tambahan', '<p class="muted">Produk berkategori "Tambahan" (mis. kantong kresek) muncul di menu pembayaran kasir sebagai pilihan tambahan, bukan di daftar produk.</p>' +
      (S.data.variants.filter(isAddon).map(v => '<div class="kv"><span>' + esc(vName(v)) + '</span><span>' + rp(priceOf(v.id, S.ch) || 0) + ' · stok ' + num(v.stok) + '</span></div>').join('') || '<p class="muted">Belum ada produk tambahan.</p>') +
      '<button class="btn sec sm" data-act="addonnew">+ Buat produk tambahan (kresek)</button>') +
    card('Kontrol kasir', field(['diskon_maks_persen', 'Batas diskon kasir (% dari subtotal)', 'number'], g('diskon_maks_persen', '10')) + '<p class="muted">Di atas batas ini, kasir butuh PIN Owner. Owner tidak dibatasi.</p>' + sw('bayar_tunai', 'Metode: Tunai') + sw('bayar_transfer', 'Metode: Transfer') + sw('bayar_qris', 'Metode: QRIS') + sw('tolak_selisih_total', 'Tolak transaksi bila total struk berbeda dari server', 'Disarankan aktif. Owner dapat menyetujui kasus tertentu dengan PIN.')) +
    card('Kontrol data', field(['opname_ambang_nilai', 'Ambang nilai opname untuk peran Stok (Rp; kosongkan = tanpa batas)', 'number'], s.opname_ambang_nilai == null ? '500000' : s.opname_ambang_nilai) + '<p class="muted">Penyesuaian stok di atas nilai ini perlu supervisor/owner. Mengubah HPP yang sudah ada selalu perlu supervisor/owner.</p>' +
      field(['transfer_ambang_nilai', 'Transfer di atas nilai ini tidak boleh disetujui pemohonnya sendiri (Rp; kosong = nonaktif)', 'number'], s.transfer_ambang_nilai) +
      field(['bayar_referensi_min', 'Nomor referensi wajib untuk Transfer/QRIS mulai Rp (kosong = opsional)', 'number'], s.bayar_referensi_min) + '<p class="muted">Referensi dipakai mencocokkan penjualan dengan mutasi QRIS/bank (Laporan → Pembayaran per metode).</p>') +
    (can('takeover') ? card('Kunci periode (Owner)', '<p class="muted">Tanggal sampai ' + esc(s.kunci_periode_sampai || '(belum dikunci)') + '. Biaya dan impor bertanggal pada/sebelum tanggal kunci ditolak; transaksi kasir tertunda dicatat dengan waktu server.</p><label>Kunci sampai tanggal (kosong = buka semua)<input class="inp" type="date" id="pl_d" value="' + esc(s.kunci_periode_sampai || '') + '"></label><label>Alasan<input class="inp" id="pl_r" placeholder="Mis. tutup buku Oktober"></label><button class="btn sec sm" data-act="plock">Terapkan kunci</button>') : '') +
    card('Printer', sw('auto_cetak', 'Langsung cetak setelah bayar', 'Lewat jalur utama di bawah (RawBT atau BLE langsung)') + '<p class="muted" style="margin-bottom:4px"><b>Jalur cetak utama (perangkat ini)</b></p>' + btBox('sw') + '<button class="btn sec sm" data-act="go_diag">Atur dan uji printer</button>') +
    card('HPP & Overhead', selF('metode_overhead', 'Cara menghitung overhead', [['per_unit', 'Per bungkus'], ['per_batch', 'Per sekali produksi']], g('metode_overhead', 'per_unit')) + '<p class="muted" id="oh-hint"></p><div id="oh-unit">' + field(['overhead_per_unit', 'Overhead per bungkus (Rp)', 'number'], s.overhead_per_unit) + '</div><div id="oh-batch">' + field(['overhead_per_batch', 'Overhead per sekali produksi (Rp)', 'number'], s.overhead_per_batch) + '</div>' + field(['target_margin', 'Target margin minimum (%)', 'number'], g('target_margin', 30)) + field(['kelipatan_harga', 'Pembulatan harga rekomendasi ke atas (Rp)', 'number'], g('kelipatan_harga', '500')) + field(['kategori_masuk_hpp', 'Kategori biaya yang SUDAH masuk HPP (pisahkan koma, mis. Listrik, Gas)'], s.kategori_masuk_hpp) + '<p class="muted">Biaya pada kategori ini tidak dipotong lagi dari laba bersih, supaya tidak terhitung dua kali.</p><button class="btn sec sm" data-act="ohsaran">Hitung saran overhead dari biaya bulan lalu</button><p class="muted" id="oh-saran"></p>') +
    '</div><div class="savebar"><button class="btn pri big" id="ssavebtn" data-act="ssave" disabled>Simpan pengaturan</button></div>';
  S.sSnap = setSnap(); S.dirty = false; sDepUpd();
}
async function sSave() {
  return busy('Menyimpan pengaturan…', async () => {
  const v = {}; document.querySelectorAll('#sf [data-f]').forEach(e => v[e.dataset.f] = e.type === 'checkbox' ? e.checked : e.value);
  ['opname_ambang_nilai', 'transfer_ambang_nilai', 'bayar_referensi_min'].forEach(k => { if (k in v) v[k] = String(v[k]).replace(/\D/g, ''); });   // angka bulat atau kosong (kosong = nonaktif)
  ['ppn_persen', 'overhead_per_unit', 'overhead_per_batch', 'target_margin', 'stok_menipis', 'diskon_maks_persen', 'kelipatan_harga'].forEach(k => { if (k in v) { const n = dnum(v[k]); v[k] = isNaN(n) ? 0 : n; } });
  try { await api('setting.setMany', {values: v}); S.dirty = false; await loadData(); render(); toast('Pengaturan tersimpan'); } catch (e) { toast(e.message); }
  });
}

