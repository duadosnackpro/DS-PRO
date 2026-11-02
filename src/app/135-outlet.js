/* ---------- Multi-outlet (v2.1.0): pilih outlet aktif dan administrasi outlet. Aktif hanya pada backend Supabase (S.data.outlets ada). ---------- */
const multiOutlet = () => !!(S.data && S.data.outlets);
const outletName = () => S.data && S.data.outlet ? S.data.outlet.code + ' · ' + S.data.outlet.name : '';
const pickable = () => (S.data.outlets || []).filter(o => o.status === 'active');
function outletLabel() {
  if (!multiOutlet() || !S.data.outlet) return '<small>Jajanan Cemilan Pedas</small>';
  const many = pickable().length > 1;
  return '<small>' + esc(outletName()) + '</small>' + (many ? '<button class="linkbtn" data-act="outlet" aria-label="Ganti outlet aktif">Ganti outlet</button>' : '');
}
function outletSheet() {
  sheet('<h2>Pilih outlet</h2><p class="muted">Data stok, penjualan, dan kas mengikuti outlet yang dipilih.</p>' + pickable().map(o => '<button class="li" style="width:100%;border:0;font:inherit;text-align:left;margin-top:8px" data-act="outpick" data-id="' + esc(o.id) + '"><span><b>' + esc(o.code) + '</b> ' + esc(o.name) + ' <span class="muted">' + (o.kind === 'kitchen' ? 'Dapur' : 'Toko') + '</span></span>' + (S.data.outlet && o.id === S.data.outlet.id ? '<span class="badge ok">Aktif</span>' : '<span class="muted">Pilih</span>') + '</button>').join('') + '<button class="btn sec" data-act="close">Tutup</button>');
}
async function outletPick(id) {
  if (S.data.outlet && id === S.data.outlet.id) return closeSheet();
  if (S.cart.length && !confirm('Keranjang berisi ' + S.cart.length + ' item dan akan dikosongkan karena pindah outlet. Lanjutkan?')) return;
  await busy('Memuat outlet…', async () => {
    try {
      await api('outlet.use', {id: id}); S.cart = []; LS.set('cart', []); S.rhist = null; VC = {}; S.users = null; S.expLoaded = false;
      await loadData(); closeSheet(); S.tab = homeTab(); render(); toast('Outlet aktif: ' + outletName());
    } catch (e) { toast(e.message); }
  });
}
function vOutlets() {
  const rows = S.data.outlets || [], st = {active: 'Aktif', inactive: 'Nonaktif', closed: 'Ditutup'};
  $('#main').innerHTML = '<button class="chip" data-act="tab" data-t="menu">← Menu</button><p class="muted">' + rows.filter(o => o.status === 'active').length + ' outlet aktif</p><button class="btn pri" data-act="oedit" data-id="">+ Tambah outlet</button>' +
    rows.map(o => '<button class="li" style="width:100%;border:0;font:inherit;text-align:left;margin-top:8px" data-act="oedit" data-id="' + esc(o.id) + '"><span><b>' + esc(o.code) + '</b> ' + esc(o.name) + '<br><span class="muted">' + (o.kind === 'kitchen' ? 'Dapur/gudang produksi' : 'Toko') + (o.address ? ' · ' + esc(o.address) : '') + '</span></span><span class="badge ' + (o.status === 'active' ? 'ok' : 'off') + '">' + st[o.status] + '</span></button>').join('');
}
async function oeditSheet(id) {
  const o = id ? S.data.outlets.find(x => x.id === id) : {kind: 'store', status: 'active'};
  sheet('<h2>' + (id ? 'Ubah' : 'Tambah') + ' outlet</h2>' + (id ? '<p class="muted">Kode ' + esc(o.code) + ' tidak dapat diubah.</p>' : field(['code', 'Kode outlet (contoh OUT-002)'], '') + selF('kind', 'Jenis', [['store', 'Toko (menjual)'], ['kitchen', 'Dapur/gudang produksi']], o.kind)) +
    field(['name', 'Nama outlet'], o.name) + field(['address', 'Alamat'], o.address) + selF('status', 'Status', [['active', 'Aktif'], ['inactive', 'Nonaktif'], ['closed', 'Ditutup']], o.status) +
    (id ? '<div id="omem"><p class="muted">Memuat pengguna…</p></div>' : '<p class="muted">Setelah dibuat: tetapkan pengguna dan isi stok awal lewat Stok → Penyesuaian (saldo pembukaan).</p>') +
    '<button class="btn pri" data-act="osave" data-id="' + esc(id) + '">Simpan</button>');
  if (id) try {
    const m = await api('member.list', {outlet_id: id}, {silent: true}); const el = $('#omem'); if (!el) return;
    el.innerHTML = '<h3>Pengguna di outlet ini</h3>' + (m.length ? m.map(x => '<div class="li"><span>' + esc(x.nama) + ' <span class="muted">@' + esc(x.username) + ' · ' + esc(x.role) + (x.status !== 'active' ? ' · nonaktif' : '') + '</span></span></div>').join('') : '<p class="muted">Belum ada.</p>') +
      '<p class="muted">Tambah/ubah akses pengguna di Menu → Pengguna (role kasir mengikuti outlet aktif).</p>';
  } catch (e) { const el = $('#omem'); if (el) el.innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; }
}
async function oSave(id) {
  return busy('Menyimpan outlet…', async () => {
    const d = readForm(); if (id) d.id = id;
    try { await api(id ? 'outlet.update' : 'outlet.create', d); await loadData(); closeSheet(); render(); toast(id ? 'Outlet diperbarui' : 'Outlet dibuat'); } catch (e) { toast(e.message); }
  });
}
MENU_TABS.push('outlets'); APP.views.outlets = vOutlets;
Object.assign(ACT, {outlet: outletSheet, outpick: el => outletPick(el.dataset.id), go_outlets: () => { S.tab = 'outlets'; render(); }, oedit: el => oeditSheet(el.dataset.id), osave: el => oSave(el.dataset.id)});
