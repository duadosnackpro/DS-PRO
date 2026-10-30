/* ---------- Reset data transaksi (v2.5.1): khusus Owner, hanya untuk outlet yang sedang aktif. Aksi sebenarnya dijaga di server (rpc_data_reset). ---------- */
const RS = {pre: null, err: ''};   // pre = hasil pratinjau dari server; err = alasan pratinjau gagal
const rsBack = '<button class="chip" data-act="tab" data-t="menu" style="align-self:flex-start;margin-bottom:var(--s3)">← Menu</button>';
function rsRows(n) {
  const row = (l, v) => '<div class="kv rs-r' + (v ? '' : ' rs-0') + '"><span>' + l + '</span><span>' + (v || 'Tidak ada') + '</span></div>';
  const c = k => Number(n[k]) || 0;
  return row('Penjualan', c('penjualan') ? num(c('penjualan')) + ' transaksi, ' + rp(n.total_rp) : '') +
    row('Sesi kasir dan kas masuk/keluar', c('sesi_kas') || c('mutasi_kas') ? num(c('sesi_kas')) + ' sesi, ' + num(c('mutasi_kas')) + ' catatan kas' : '') +
    row('Biaya outlet', c('biaya') ? num(c('biaya')) + ' catatan' : '') +
    row('Pembelian bahan', c('pembelian') ? num(c('pembelian')) + ' nota' : '') +
    row('Produksi', c('produksi') ? num(c('produksi')) + ' batch' : '') +
    row('Transfer stok', c('transfer') ? num(c('transfer')) + ' dokumen' : '') +
    row('Impor Shopee', c('impor') ? num(c('impor')) + ' pesanan' : '') +
    row('Riwayat stok dan kerugian', c('mutasi_stok') || c('kerugian') ? num(c('mutasi_stok') + c('kerugian')) + ' catatan' : '');
}
function rsCheck() {   // tombol hapus hanya aktif bila semua syarat terpenuhi
  const go = /** @type {HTMLButtonElement|null} */ (document.getElementById('rs_go')), o = S.data && S.data.outlet; if (!go || !o) return;
  const ok = !!RS.pre && !RS.pre.blokir && !S.queue.length && vOf('rs_why').trim().length >= 3 && vOf('rs_code').trim().toUpperCase() === String(o.code).toUpperCase();
  go.disabled = !ok;
}
function vReset() {
  const o = S.data.outlet; RS.pre = null; RS.err = '';
  if (!o) { $('#main').innerHTML = rsBack + emptyState('cek', 'Belum ada outlet aktif', 'Pilih outlet dulu, lalu buka layar ini lagi.'); return; }
  const q = S.queue.length;
  $('#main').innerHTML = rsBack +
    '<div class="qwarn" role="alert"><b>Data transaksi ' + esc(o.name) + ' (' + esc(o.code) + ') akan dihapus permanen.</b><br>Tidak bisa dikembalikan. Outlet lain tidak ikut terhapus.</div>' +
    (q ? '<div class="notice"><span>Masih ada ' + q + ' transaksi di perangkat ini yang belum terkirim. Kirim dulu lewat Menu, Perbarui data, supaya tidak masuk lagi setelah reset.</span></div>' : '') +
    '<section class="set-card"><h3>Yang dihapus</h3><div id="rs_sum" class="muted">Menghitung…</div></section>' +
    '<section class="set-card"><h3>Yang tetap ada</h3><p class="muted" style="margin:0">Produk, harga, bahan, resep, supplier, pengguna, dan pengaturan. Catatan audit juga tetap, dan reset ini dicatat di sana.</p></section>' +
    '<section class="set-card"><h3>Stok setelah reset</h3>' +
      '<label class="rs-opt"><input type="radio" name="rs_stok" value="nol" checked><span><b>Kosongkan stok</b><small>Semua stok dan HPP kembali ke 0. Isi stok awal lewat Stok, Penyesuaian.</small></span></label>' +
      '<label class="rs-opt"><input type="radio" name="rs_stok" value="pertahankan"><span><b>Pertahankan stok sekarang</b><small>Jumlah dan HPP tidak berubah, dicatat sebagai stok awal. Pilih ini bila stok sudah dihitung benar.</small></span></label>' +
    '</section>' +
    '<section class="set-card"><h3>Konfirmasi</h3>' +
      '<label>Alasan reset<input class="inp" id="rs_why" maxlength="300" autocomplete="off" placeholder="Mis. membersihkan data uji sebelum buka"></label>' +
      '<label>Ketik <b>' + esc(o.code) + '</b> untuk melanjutkan<input class="inp" id="rs_code" autocomplete="off" autocapitalize="characters" spellcheck="false"></label>' +
      '<button class="btn dan big" id="rs_go" data-act="rs_go" disabled>Hapus data transaksi</button>' +
      '<p class="muted" id="rs_hint" style="margin:var(--s3) 0 0">Pastikan tidak ada kasir yang sedang berjualan di outlet ini.</p>' +
    '</section>';
  api('data.reset', {terapkan: false}, {silent: true}).then(r => {
    if (S.tab !== 'reset' || !$('#rs_sum')) return;
    RS.pre = r; $('#rs_sum').className = ''; $('#rs_sum').innerHTML = rsRows(r.jumlah || {});
    if (r.blokir) { const h = $('#rs_hint'); if (h) { h.className = 'err'; h.textContent = r.blokir; } }
    rsCheck();
  }).catch(e => {
    if (S.tab !== 'reset' || !$('#rs_sum')) return;
    RS.err = e.auth ? 'Sesi berakhir, silakan masuk lagi.' : /Hanya Owner/.test(e.message) ? e.message : navigator.onLine ? e.message : 'Perlu koneksi internet untuk menghitung data yang akan dihapus.';
    $('#rs_sum').className = 'err'; $('#rs_sum').textContent = RS.err;
  });
}
function rsDone(r, stok) {
  const n = r.jumlah || {}, c = k => Number(n[k]) || 0;
  sheet('<div class="grab"></div><div class="okmark">' + svg('check', 30) + '</div><h2 style="text-align:center">Data transaksi sudah direset</h2>' +
    '<p class="muted" style="text-align:center">' + esc(r.outlet ? r.outlet.kode + ' · ' + r.outlet.nama : '') + '. ' + num(c('penjualan')) + ' transaksi penjualan dan ' + num(c('mutasi_stok')) + ' catatan stok dihapus.</p>' +
    '<div class="card-s"><b>Sebelum buka:</b><ul style="margin:var(--s2) 0 0;padding-left:20px">' +
      (stok === 'nol' ? '<li>Isi stok awal lewat Stok, Penyesuaian.</li>' : '<li>Cek lagi jumlah stok bila perlu.</li>') +
      '<li>Buka kasir dan isi modal awal.</li><li>Nomor struk mulai dari 1 lagi.</li></ul></div>' +
    '<div class="row2"><button class="btn pri" data-act="rs_stok">Ke Stok</button><button class="btn sec" data-act="close">Tutup</button></div>');
}
async function rsGo() {
  const o = S.data.outlet, go = /** @type {HTMLButtonElement|null} */ (document.getElementById('rs_go')); if (!o || !go || go.disabled) return;
  const stokEl = /** @type {HTMLInputElement|null} */ (document.querySelector('input[name="rs_stok"]:checked')), stok = stokEl ? stokEl.value : 'nol';
  if (!navigator.onLine) return toast('Perlu koneksi internet untuk reset data');
  return busy('Menghapus data transaksi…', async () => {
    try {
      const rid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'rst-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      const r = await api('data.reset', {terapkan: true, konfirmasi: vOf('rs_code').trim(), alasan: vOf('rs_why').trim(), stok: stok, request_id: rid});
      S.cart = []; LS.set('cart', []); S.rhist = null; VC = {}; S.expLoaded = false;
      await loadData(); await shiftCheck(); S.tab = 'menu'; render(); rsDone(r, stok);
    } catch (e) { toast(e.auth ? 'Sesi berakhir, silakan masuk lagi' : e.message); }
  });
}
document.addEventListener('input', e => { const t = /** @type {HTMLElement} */ (e.target); if (S.tab === 'reset' && t && (t.id === 'rs_why' || t.id === 'rs_code')) rsCheck(); });
MENU_TABS.push('reset'); APP.views.reset = vReset;
Object.assign(ACT, {go_reset: () => { S.tab = 'reset'; render(); }, rs_go: rsGo, rs_stok: () => { closeSheet(); S.tab = 'stok'; render(); }});
