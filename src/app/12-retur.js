/* ---------- Retur (transaksi selesai tidak diubah; retur dicatat sebagai transaksi negatif) ---------- */
S.retRid = {};
async function returOpen(id) {
  if (!navigator.onLine) return toast('Retur butuh koneksi internet');
  let d; try { d = await api('sale.detail', {id: id}); } catch (e) { return toast(e.server ? e.message : 'Tidak bisa memuat transaksi (periksa koneksi)'); }
  const L = d.items.filter(x => x.sisa > 0); if (!L.length) return toast('Semua item transaksi ini sudah diretur');
  S.ret = {id: id, nomor: d.sale.nomor, lines: L};
  sheet('<div class="grab"></div><h2>Retur ' + esc(d.sale.nomor) + '</h2><p class="muted">Isi jumlah yang dikembalikan pelanggan. Stok bertambah kembali. Transaksi asal tidak diubah; retur tercatat sebagai transaksi baru bernilai minus.' + (own() ? '' : ' Retur oleh kasir perlu PIN Owner.') + '</p>' +
    L.map(l => { const v = vById(l.variant_id); return '<label>' + esc(v ? (vName(v) + ' ' + vSub(v)).trim() : 'Produk dihapus') + ' <small class="muted">(bisa diretur ' + qf(l.sisa) + ')</small><input class="inp" type="number" min="0" max="' + l.sisa + '" step="any" inputmode="decimal" data-rv="' + esc(l.variant_id) + '" value="0"></label>'; }).join('') +
    '<button class="btn sec sm" data-act="retur_all">Retur semua sisa</button><label>Alasan retur (wajib)<input class="inp" id="ral" placeholder="mis. salah input, produk rusak, pelanggan batal"></label><div class="err" id="rerr"></div><button class="btn pri" data-act="retur_ok">Proses retur</button><button class="btn sec" data-act="close">Batal</button>');
}
async function returGo() {
  const R = S.ret; if (!R) return; const items = [], err = m => { const e = $('#rerr'); if (e) e.textContent = m; };
  document.querySelectorAll('#sheet [data-rv]').forEach(e => { const q = Number(e.value) || 0, l = R.lines.find(x => x.variant_id === e.dataset.rv); if (q > 0 && l) items.push({variant_id: l.variant_id, qty: q, max: l.sisa}); });
  if (!items.length) return err('Isi jumlah retur minimal satu item.'); if (items.some(x => x.qty > x.max + 1e-9)) return err('Jumlah melebihi sisa yang bisa diretur.');
  const alasan = (($('#ral') || {}).value || '').trim(); if (alasan.length < 3) return err('Alasan retur wajib diisi.');
  const key = R.id + '|' + JSON.stringify(items.map(x => [x.variant_id, x.qty])) + '|' + alasan; // permintaan yang sama memakai request_id yang sama, jadi kirim ulang tidak menggandakan retur
  const rid = S.retRid[key] || (S.retRid[key] = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
  let tok = null; if (!own()) { tok = await askOwner('Retur ' + R.nomor + ': ' + alasan + '. Owner dapat menyetujui dengan PIN.', 'retur', rid, 0); }
  try {
    const res = await api('sale.return', {request_id: rid, id: R.id, items: items.map(x => ({variant_id: x.variant_id, qty: x.qty})), alasan: alasan, override_token: tok});
    delete S.retRid[key]; closeSheet(); const d = res.sale || {};
    Object.keys(res.stok || {}).forEach(id => { const v = vById(id); if (v) v.stok = r6(res.stok[id] - pendingQty(id)); }); LS.set('data', S.data);
    toast(res.duplicate || res.cached ? 'Retur ini sudah tercatat sebelumnya' : 'Retur tercatat. Kembalikan ' + rp(res.refund) + ' ke pelanggan (' + (res.metode || '') + ')'); if (S.tab === 'riwayat') vRiwayat();
  } catch (e) { if (e.auth) softLogout(); else toast(e.server ? e.message : 'Koneksi bermasalah. Ulangi retur yang sama; aman, tidak akan tercatat dua kali.'); }
}

