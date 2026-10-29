/* ---------- Transfer stok antar outlet (F2). Alur server: draft -> submitted -> approved -> sent -> received (atau rejected/cancelled). ---------- */
const TR_ST = {draft: 'Draft', submitted: 'Diajukan', approved: 'Disetujui', sent: 'Dalam perjalanan', received: 'Diterima', rejected: 'Ditolak', cancelled: 'Dibatalkan'};
const TR_TAG = {received: 'grn', rejected: 'red', cancelled: 'red'};
const trOutletName = id => { const o = (S.data.outlets || []).find(x => x.id === id); return o ? o.code + ' · ' + o.name : '(outlet)'; };
const trItemName = it => {
  if (it.tipe === 'variant') { const v = vById(it.item_id); return v ? vName(v) + ' ' + vSub(v) : '(produk)'; }
  const m = (S.data.materials || []).find(x => x.id === it.item_id); return m ? m.nama : '(bahan)';
};
const trUnit = it => it.tipe === 'variant' ? 'pcs' : ((S.data.materials || []).find(x => x.id === it.item_id) || {}).satuan || '';
async function vTransfer() {
  $('#main').innerHTML = '<button class="chip" data-act="tab" data-t="menu">← Menu</button><button class="btn pri" data-act="trnew">+ Transfer baru</button><div id="trl">' + skel(3) + '</div>';
  await vload('transfer.list', undefined, L => { S.trs = L; trDraw(); }, {fail: e => { if ($('#trl')) $('#trl').innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; }});
}
function trDraw() {
  const el = $('#trl'); if (!el) return; const me = S.data.outlet && S.data.outlet.id;
  el.innerHTML = (S.trs || []).map(t => '<button class="li" style="width:100%;border:0;font:inherit;text-align:left;margin-top:8px" data-act="trdetail" data-id="' + esc(t.id) + '"><span><b>' + esc(t.nomor) + '</b><div class="muted">' + (t.dari_id === me ? 'Ke ' + esc(trOutletName(t.ke_id)) : 'Dari ' + esc(trOutletName(t.dari_id))) + ' · ' + t.items.length + ' item</div></span><span class="tag ' + (TR_TAG[t.status] || '') + '">' + esc(TR_ST[t.status] || t.status) + '</span></button>').join('') ||
    emptyState('stok', 'Belum ada transfer', 'Kirim stok produk jadi atau bahan ke outlet lain. Stok asal berkurang saat dikirim, stok tujuan bertambah saat diterima.', '');
}
function trNewSheet() {
  const others = pickable().filter(o => o.id !== S.data.outlet.id);
  if (!others.length) return toast('Belum ada outlet aktif lain sebagai tujuan');
  S.trf = {to: others[0].id, kind: 'variant', item: '', qty: '', items: [], catatan: ''};
  trNewDraw();
}
function trNewDraw() {
  const f = S.trf, others = pickable().filter(o => o.id !== S.data.outlet.id), pool = f.kind === 'variant' ? S.data.variants.map(v => [v.id, vName(v) + ' ' + vSub(v) + ' (stok ' + qf(v.stok) + ')']) : (S.data.materials || []).map(m => [m.id, m.nama + ' (stok ' + qf(m.stok) + ' ' + m.satuan + ')']);
  if (!pool.some(x => x[0] === f.item)) f.item = pool[0] ? pool[0][0] : '';
  sheet('<h2>Transfer baru</h2><p class="muted">Dari ' + esc(outletName()) + '</p><label>Tujuan<select class="inp" data-tf="to">' + others.map(o => '<option value="' + esc(o.id) + '"' + (o.id === f.to ? ' selected' : '') + '>' + esc(o.code + ' · ' + o.name) + '</option>').join('') + '</select></label>' +
    '<div class="chips"><button class="chip ' + (f.kind === 'variant' ? 'on' : '') + '" data-act="trkind" data-k="variant">Produk jadi</button>' + (S.data.materials ? '<button class="chip ' + (f.kind === 'material' ? 'on' : '') + '" data-act="trkind" data-k="material">Bahan</button>' : '') + '</div>' +
    '<label>Item<select class="inp" data-tf="item">' + pool.map(x => '<option value="' + esc(x[0]) + '"' + (x[0] === f.item ? ' selected' : '') + '>' + esc(x[1]) + '</option>').join('') + '</select></label><div class="row2"><input class="inp" data-tf="qty" inputmode="decimal" placeholder="Jumlah" value="' + esc(f.qty) + '"><button class="btn sec" data-act="tradd">Tambah</button></div>' +
    f.items.map((x, i) => '<div class="kv"><span>' + esc(trItemName({tipe: x.item_type, item_id: x.item_id})) + '</span><span>' + qf(x.qty) + ' <button class="chip" data-act="trdel" data-i="' + i + '">Hapus</button></span></div>').join('') +
    '<label>Catatan<input class="inp" data-tf="catatan" value="' + esc(f.catatan) + '"></label><button class="btn pri" data-act="trsave" data-aj="1">Buat dan ajukan</button><button class="btn sec" data-act="trsave" data-aj="0">Simpan sebagai draft</button>');
}
function trDetail(id) {
  const t = (S.trs || []).find(x => x.id === id); if (!t) return; const me = S.data.outlet.id, mine = t.dari_id === me, dest = t.ke_id === me, st = t.status;
  const btn = (a, l, cl) => '<button class="btn ' + (cl || 'pri') + '" data-act="tract" data-id="' + esc(id) + '" data-a="' + a + '">' + l + '</button>';
  let acts = '';
  if (mine && st === 'draft' && can('transfer')) acts += btn('submit', 'Ajukan');
  if (mine && st === 'submitted' && can('approve')) acts += btn('approve', 'Setujui') + btn('reject', 'Tolak', 'dan');
  if (mine && (st === 'approved' || st === 'submitted') && can('transfer')) acts += btn('send', 'Kirim sekarang');
  if (dest && st === 'sent' && can('transfer')) acts += btn('receive', 'Terima barang');
  if ((mine || (dest && st === 'sent')) && ['draft', 'submitted', 'approved', 'sent'].indexOf(st) >= 0 && can('transfer') && (st !== 'sent' || can('approve'))) acts += btn('cancel', st === 'sent' ? 'Batalkan dan kembalikan ke asal' : 'Batalkan', 'dan');
  const recv = dest && st === 'sent';
  sheet('<h2>' + esc(t.nomor) + '</h2><p class="muted">' + esc(trOutletName(t.dari_id)) + ' → ' + esc(trOutletName(t.ke_id)) + ' · ' + esc(TR_ST[st] || st) + (t.catatan ? ' · ' + esc(t.catatan) : '') + '</p>' +
    '<div class="li" style="display:block">' + t.items.map((it, i) => '<div class="kv"><span>' + esc(trItemName(it)) + '</span><span>' + (recv ? '<input class="inp" style="width:90px" data-rc="' + i + '" inputmode="decimal" value="' + esc(it.dikirim) + '"> ' : (it.diterima != null ? qf(it.diterima) + ' / ' : '') + qf(it.dikirim != null ? it.dikirim : it.diminta) + ' ') + esc(trUnit(it)) + (it.selisih ? ' <span class="tag red">selisih ' + qf(it.selisih) + '</span>' : '') + '</span></div>').join('') + '</div>' +
    (recv ? '<p class="muted">Isi jumlah yang benar-benar diterima. Selisih dicatat di audit.</p>' : '') + acts + '<button class="btn sec" data-act="close">Tutup</button>');
}
async function trAct(id, a) {
  const t = (S.trs || []).find(x => x.id === id); if (!t) return; const p = {id: id, action: a};
  if (a === 'receive') { p.items = t.items.map((it, i) => { const el = document.querySelector('[data-rc="' + i + '"]'); return {item_type: it.tipe, item_id: it.item_id, qty_received: dnum(el ? el.value : it.dikirim)}; }); if (p.items.some(x => isNaN(x.qty_received))) return toast('Jumlah diterima tidak valid'); }
  if (['reject', 'cancel'].indexOf(a) >= 0 && !confirm(a === 'reject' ? 'Tolak transfer ini?' : 'Batalkan transfer ini?')) return;
  return busy('Memproses…', async () => { try { await api('transfer.action', p); await loadData(); closeSheet(); vTransfer(); toast('Transfer diperbarui'); } catch (e) { toast(e.message); } });
}
async function trSave(aj) {
  const f = S.trf; if (!f.items.length) return toast('Tambahkan minimal satu item');
  return busy('Menyimpan transfer…', async () => { try { await api('transfer.create', {from_outlet_id: S.data.outlet.id, to_outlet_id: f.to, items: f.items, catatan: f.catatan, ajukan: aj}); closeSheet(); vTransfer(); toast(aj ? 'Transfer diajukan' : 'Draft tersimpan'); } catch (e) { toast(e.message); } });
}
document.addEventListener('input', e => { const k = e.target && e.target.dataset && e.target.dataset.tf; if (k && S.trf) S.trf[k] = e.target.value; });
document.addEventListener('change', e => { const k = e.target && e.target.dataset && e.target.dataset.tf; if (k && S.trf) { S.trf[k] = e.target.value; } });
APP.views.transfer = vTransfer;
Object.assign(ACT, {
  go_transfer: () => { S.tab = 'transfer'; render(); }, trnew: trNewSheet, trdetail: el => trDetail(el.dataset.id), tract: el => trAct(el.dataset.id, el.dataset.a),
  trkind: el => { S.trf.kind = el.dataset.k; S.trf.item = ''; trNewDraw(); },
  tradd: () => { const f = S.trf, q = dnum(f.qty); if (!f.item || !(q > 0)) return toast('Pilih item dan isi jumlah > 0'); const ex = f.items.find(x => x.item_id === f.item && x.item_type === f.kind); if (ex) ex.qty = r6(ex.qty + q); else f.items.push({item_type: f.kind, item_id: f.item, qty: q}); f.qty = ''; trNewDraw(); },
  trdel: el => { S.trf.items.splice(Number(el.dataset.i), 1); trNewDraw(); }, trsave: el => trSave(el.dataset.aj === '1'),
  kopen: kasOpen, kmove: kasMove,
});
