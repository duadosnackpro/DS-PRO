/* ---------- Stok dan pembelian ---------- */
const stState = (st, min, thr) => st <= 0 ? 'out' : (min > 0 ? st <= min : st < thr) ? 'low' : 'ok';
const stBadge = x => x === 'out' ? '<span class="bdg out">Habis</span>' : x === 'low' ? '<span class="bdg low">Menipis</span>' : '';
function vStok() {
  const o = can('materials'), bahan = S.stab === 'bahan' && o;
  const tabs = o ? wrapChips('<button class="chip ' + (S.stab === 'varian' ? 'on' : '') + '" data-act="stab" data-s="varian">Produk jadi</button><button class="chip ' + (S.stab === 'bahan' ? 'on' : '') + '" data-act="stab" data-s="bahan">Bahan dan kemasan</button>') : '';
  const cats = bahan ? ['Semua', 'bahan', 'kemasan', 'barang jadi beli'] : ['Semua'].concat(Array.from(new Set(S.data.variants.map(v => String((pById(v.product_id) || {}).kategori || '')).filter(Boolean))));
  if (cats.indexOf(S.scat) < 0) S.scat = 'Semua';
  $('#main').innerHTML = tabs + (bahan && can('stockedit') ? '<button class="btn pri" data-act="pbopen" style="margin-top:0">+ Pembelian bahan</button>' : '') +
    '<label class="search" style="margin-top:8px">' + svg('search', 18) + '<input id="sq" class="inp" data-in="sq" placeholder="' + (bahan ? 'Cari bahan' : 'Cari produk atau SKU') + '" value="' + esc(S.sq) + '" aria-label="Cari stok"></label>' +
    wrapChips(cats.map(c => '<button class="chip ' + (c === S.scat ? 'on' : '') + '" data-act="scat" data-c="' + esc(c) + '">' + esc(c === 'Semua' || !bahan ? c : c.charAt(0).toUpperCase() + c.slice(1)) + '</button>').join('')) + '<div id="ssum" class="ssum"></div><div id="slist"></div>';
  stokList();
}
function stokList() {
  const o = can('materials'), cost = can('cost'), edit = can('stockedit'), bahan = S.stab === 'bahan' && o, q = S.sq.toLowerCase(), thr = Number(cfg('stok_menipis')) > 0 ? Number(cfg('stok_menipis')) : 5; let rows;
  if (bahan) rows = S.data.materials.filter(m => (S.scat === 'Semua' || m.tipe === S.scat) && (!q || (m.nama + ' ' + m.satuan).toLowerCase().indexOf(q) >= 0)).map(m => ({id: m.id, t: 'bahan', name: String(m.nama), lv: '', sub: cost ? 'HPP rata-rata ' + rp(m.hpp_rata2) + '/' + m.satuan : m.satuan, val: qf(m.stok) + ' ' + m.satuan, st: stState(Number(m.stok) || 0, Number(m.stok_minimum) || 0, thr)}));
  else rows = S.data.variants.filter(v => (S.scat === 'Semua' || String((pById(v.product_id) || {}).kategori) === S.scat) && (!q || (vName(v) + ' ' + vSub(v) + ' ' + v.sku).toLowerCase().indexOf(q) >= 0)).map(v => ({id: v.id, t: 'varian', name: String(vName(v)), lv: lvText(v.level_pedas), sub: [v.ukuran].filter(Boolean).join('') + (cost ? ' · HPP ' + rp(v.hpp_rata2) : ''), val: num(v.stok), st: stState(Number(v.stok) || 0, 0, thr)}));
  const rank = {out: 0, low: 1, ok: 2}; rows.sort((a, b) => rank[a.st] - rank[b.st] || a.name.localeCompare(b.name, 'id') || a.sub.localeCompare(b.sub, 'id')); // habis dan menipis di atas
  const nOut = rows.filter(r => r.st === 'out').length, nLow = rows.filter(r => r.st === 'low').length, ss = $('#ssum');
  if (ss) ss.innerHTML = nOut || nLow ? (nOut ? '<span class="bdg out">' + nOut + ' habis</span>' : '') + (nLow ? '<span class="bdg low">' + nLow + ' menipis</span>' : '') : '<span class="muted">' + rows.length + ' item · semua stok aman</span>';
  const row = r => { const body = '<div class="st-n"><b>' + esc(r.name) + (r.lv ? ' <span class="lvt">· ' + esc(r.lv) + '</span>' : '') + '</b><div class="muted">' + esc(r.sub) + '</div></div><div class="st-v"><b>' + esc(r.val) + '</b>' + stBadge(r.st) + '</div>';
    return edit ? '<button class="li st-row" data-act="adj" data-t="' + r.t + '" data-id="' + esc(r.id) + '">' + body + svg('chev', 18) + '</button>' : '<div class="li st-row">' + body + '</div>'; };
  $('#slist').innerHTML = rows.length ? rows.map(row).join('') : (S.sq || S.scat !== 'Semua' ? emptyState('stok', 'Tidak ditemukan', 'Coba kata kunci atau kategori lain.', '') :
    bahan ? emptyState('stok', 'Belum ada bahan', 'Tambahkan bahan dan kemasan yang dipakai resep di Data Master.', '<button class="btn pri" data-act="rimat">Tambah bahan</button>') :
    emptyState('stok', 'Belum ada produk', o ? 'Tambahkan produk, varian, dan stok awal di Data Master.' : 'Minta owner menambahkan produk.', o ? '<button class="btn pri" data-act="go_master">Buka Data Master</button>' : ''));
}
function adjSheet(t, id) {
  const it = t === 'bahan' ? S.data.materials.find(m => m.id === id) : vById(id); if (!it) return;
  sheet('<h2>Penyesuaian stok</h2><p class="muted">' + esc(t === 'bahan' ? it.nama : vName(it) + ' ' + vSub(it)) + ' · stok sekarang ' + qf(it.stok) + '</p><label>Stok baru<input class="inp" id="a_s" inputmode="decimal" value="' + esc(String(it.stok).replace('.', ',')) + '"></label>' +
    '<label>HPP rata-rata (kosongkan jika tidak diubah; isi untuk stok awal)<input class="inp" id="a_h" inputmode="decimal" placeholder="' + esc(it.hpp_rata2) + '"></label><label>Alasan<input class="inp" id="a_r" value="Stok opname"></label>' +
    '<button class="btn pri" data-act="adjsave" data-t="' + t + '" data-id="' + esc(id) + '">Simpan</button>');
}
async function adjSave(t, id) {
  return busy('Menyimpan stok…', async () => {
  try {
    const r = await api('stock.adjust', {tipe: t, id: id, stok_baru: dnum($('#a_s').value), hpp: $('#a_h').value.trim() === '' ? '' : dnum($('#a_h').value), alasan: $('#a_r').value});
    const it = t === 'bahan' ? S.data.materials.find(m => m.id === id) : vById(id); it.stok = r.stok; it.hpp_rata2 = r.hpp_rata2; LS.set('data', S.data); closeSheet(); render(); toast('Stok disimpan');
  } catch (e) { toast(e.message); }
  });
}
function pbSheet() {
  const m = S.data.materials, pb = S.pb, tot = pb.items.reduce((a, i) => a + i.qty * i.harga, 0);
  sheet('<h2>Pembelian bahan</h2><label>Supplier<select class="inp" data-in="pbsup"><option value="">- tanpa supplier -</option>' + S.data.suppliers.map(s => '<option value="' + esc(s.id) + '"' + (s.id === pb.sup ? ' selected' : '') + '>' + esc(s.nama) + '</option>').join('') + '</select></label>' +
    pb.items.map((i, n) => { const x = m.find(y => y.id === i.id); return '<div class="li"><div><b>' + esc(x ? x.nama : '?') + '</b><div class="muted">' + qf(i.qty) + ' ' + esc(x ? x.satuan : '') + ' @ ' + rp(i.harga) + '</div></div><button class="chip" data-act="pbdel" data-i="' + n + '">Hapus</button></div>'; }).join('') +
    '<label>Bahan<select class="inp" id="pb_m">' + m.map(x => '<option value="' + esc(x.id) + '">' + esc(x.nama) + ' (' + esc(x.satuan) + ')</option>').join('') + '</select></label><div class="row2"><div style="flex:1"><label>Jumlah<input class="inp" id="pb_q" inputmode="decimal"></label></div><div style="flex:1"><label>Harga satuan (Rp)<input class="inp" id="pb_h" inputmode="decimal"></label></div></div>' +
    '<button class="btn sec" data-act="pbadd">Tambah ke daftar</button><label>Ongkir (Rp, dialokasikan ke HPP)<input class="inp" data-in="pbongkir" inputmode="numeric" value="' + esc(pb.ongkir) + '"></label>' +
    '<div class="kv big"><span>Total</span><span>' + rp(tot + (Number(pb.ongkir) || 0)) + '</span></div><button class="btn pri" data-act="pbsave">Simpan pembelian</button><button class="btn sec sm" data-act="pbhist">Riwayat pembelian / batalkan</button>');
}
/* F-16: riwayat pembelian + pembatalan (supervisor ke atas). Stok bahan dikurangi kembali; ditolak bila bahan sudah terpakai. */
async function pbHist() {
  sheet('<h2>Riwayat pembelian</h2><div id="pbh">' + skel(3) + '</div>');
  try {
    const L = await api('purchase.list', {}), sup = id => { const s = (S.data.suppliers || []).find(x => x.id === id); return s ? s.nama : ''; };
    $('#pbh').innerHTML = L.length ? L.map(x => '<div class="li" style="display:block"><div class="kv"><b>' + esc(String(x.waktu).slice(0, 10)) + (sup(x.supplier_id) ? ' · ' + esc(sup(x.supplier_id)) : '') + '</b><span>' + rp(x.total) + '</span></div>' +
      (x.status === 'cancelled' ? '<div class="muted"><span class="tag red">Dibatalkan</span> ' + esc(x.alasan_batal) + '</div>' : (can('approve') ? '<button class="chip" data-act="pbcancel" data-id="' + esc(x.id) + '">Batalkan</button>' : '')) + '</div>').join('') : '<p class="muted">Belum ada pembelian.</p>';
  } catch (e) { $('#pbh').innerHTML = '<p class="err">' + esc(e.message) + '</p>'; }
}
async function pbCancel(id) {
  const why = prompt('Alasan membatalkan pembelian ini (min. 3 huruf):'); if (why === null) return; if (why.trim().length < 3) return toast('Alasan wajib diisi');
  return busy('Membatalkan…', async () => { try { await api('purchase.cancel', {id: id, alasan: why.trim()}); await loadData(); toast('Pembelian dibatalkan, stok bahan dikembalikan'); pbHist(); } catch (e) { toast(e.message); } });
}
async function pbSave() {
  return busy('Menyimpan pembelian…', async () => {
  const pb = S.pb; if (!pb.items.length) return toast('Daftar masih kosong');
  try {
    const r = await api('purchase.create', {supplier_id: pb.sup, ongkir: Number(pb.ongkir) || 0, items: pb.items.map(i => ({material_id: i.id, qty: i.qty, harga_satuan: i.harga}))});
    r.materials.forEach(u => { const m = S.data.materials.find(x => x.id === u.id); if (m) { m.stok = u.stok; if (u.hpp_rata2 !== undefined) m.hpp_rata2 = u.hpp_rata2; } });   // server hanya mengirim stok; jangan menghapus HPP yang ada
    LS.set('data', S.data); S.pb = {items: [], ongkir: '', sup: ''}; closeSheet(); render(); toast('Pembelian tersimpan, HPP diperbarui');
  } catch (e) { toast(e.message); }
  });
}

