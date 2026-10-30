/* ---------- Tutup kasir ---------- */
const KAS_CATS = ['Transport', 'Gas', 'Listrik', 'Air', 'Pemasaran', 'Lain-lain']; // kategori kas keluar laci (P0 F-05); server hanya mewajibkan terisi
async function vTutup() {
  const back = '<button class="chip" data-act="tab" data-t="menu">← Menu</button>';
  $('#main').innerHTML = back + '<div class="li" style="display:block;margin-top:8px"><b>Tutup kasir</b><p class="muted">Hitung uang tunai di laci lebih dulu, isi jumlahnya, lalu tutup. Rekap penjualan baru tampil setelah penutupan (hitung buta) agar selisihnya jujur.</p></div><div id="tbody">' + skel(3) + '</div>';
  const unsent = mineAll().length;
  if (unsent) { flush(); $('#tbody').innerHTML = '<div class="notice"><span>Masih ada ' + unsent + ' transaksi yang belum terkirim ke server. Kirim dulu agar rekap lengkap.</span><button class="chip" data-act="tab" data-t="tutup">Periksa lagi</button></div><button class="btn pri" data-act="qnow">Kirim sekarang</button>'; return; }
  await vload('shift.summary', {}, r => {
    if (S.tab !== 'tutup' || !$('#tbody')) return; const typed = ($('#tf') && $('#tf').value) || ($('#tn') && $('#tn').value) || ($('#tm') && $('#tm').value) || ($('#mn') && $('#mn').value); S.shift = r; if (typed) return; /* jangan menimpa isian yang sedang diketik */ const kv = (a, b) => '<div class="kv"><span>' + a + '</span><span>' + b + '</span></div>';
    S.shiftOpen = !!r.sesi; S.wajibBuka = r.wajib_buka !== false;
    if (!r.sesi) { // F4: modal awal ditetapkan saat BUKA kasir (sebelum ada penjualan), bukan diketik saat tutup
      $('#tbody').innerHTML = '<div class="li" style="display:block"><b>Kasir belum dibuka</b><p class="muted">Hitung uang modal di laci, isi jumlahnya, lalu buka kasir. Angka ini terkunci dan dipakai menghitung selisih saat tutup.</p></div>' +
        '<label>Modal awal laci (Rp)<input class="inp" id="tm" inputmode="numeric" placeholder="0"></label><button class="btn pri big" data-act="kopen">Buka kasir</button><div id="tlist"></div>'; tutupList(); return;
    }
    const mv = (r.gerakan || []).map(g => '<div class="kv"><span>' + (g.jenis === 'in' ? 'Kas masuk' : 'Kas keluar') + ' · ' + esc(g.alasan) + '</span><span>' + rp(g.nominal) + '</span></div>').join('');
    $('#tbody').innerHTML = '<div class="li" style="display:block">' + kv('Sejak', esc(String(r.dari).slice(0, 16))) + kv('Jumlah transaksi', num(r.jumlah_trx)) + kv('Modal awal', rp(r.modal_awal)) + mv + '</div>' +
      '<div class="li" style="display:block"><b>Kas masuk/keluar</b><p class="muted">Mis. beli es batu memakai uang laci. Catat SAAT terjadi, dengan alasan. Kas keluar otomatis tercatat sebagai biaya sesuai kategorinya.</p><div class="row2"><select class="inp" id="mj"><option value="out">Keluar</option><option value="in">Masuk</option></select><input class="inp" id="mn" inputmode="numeric" placeholder="Nominal"></div><select class="inp" id="mk"><option value="">Kategori biaya (wajib untuk kas keluar)</option>' + KAS_CATS.map(c => '<option>' + esc(c) + '</option>').join('') + '</select><input class="inp" id="ma" placeholder="Alasan (min. 3 huruf)"><button class="btn sec" data-act="kmove">Catat</button></div>' +
      '<label>Uang tunai di laci sekarang (Rp)<input class="inp" id="tf" inputmode="numeric" placeholder="Hitung dulu, lalu isi"></label><label>Catatan (opsional)<input class="inp" id="tn"></label><button class="btn pri big" data-act="tclose">Tutup kasir</button><div id="tlist"></div>';
    tutupList();
  }, {fail: e => { if ($('#tbody')) $('#tbody').innerHTML = '<p class="err">' + esc(e.message) + '</p>'; }});
}
async function tutupList() { await vload('shift.list', {}, L => { let el = $('#tlist'); if (!el && $('#tbody')) { el = document.createElement('div'); el.id = 'tlist'; $('#tbody').appendChild(el); } if (!el) return; const h = '<h3 style="margin:14px 0 6px">Penutupan terakhir</h3>' + (L.length ? L.slice(0, 10).map(x => '<div class="li" style="display:block"><div class="kv"><b>' + esc(x.kasir) + '</b><span>' + esc(String(x.sampai).slice(0, 16)) + '</span></div><div class="muted">' + num(x.jumlah_trx) + ' trx · total ' + rp(x.total_semua) + ' · tunai laci ' + rp(x.uang_fisik) + (own() ? ' · modal ' + rp(x.modal_awal) + (x.fisik_sebelumnya != null && Math.abs(Number(x.modal_awal) - x.fisik_sebelumnya) > 0.5 ? ' (sisa laci sebelumnya ' + rp(x.fisik_sebelumnya) + ')' : '') + (Number(x.kas_keluar) > 0 ? ' · kas keluar ' + rp(x.kas_keluar) : '') : '') + ' · selisih <b style="color:' + (Number(x.selisih_tunai) === 0 ? 'var(--ok)' : 'var(--err)') + '">' + rp(x.selisih_tunai) + '</b>' +
    (x.disetujui ? '<div><span class="tag">Ditinjau</span> ' + esc(x.disetujui_oleh || '') + (x.catatan_tinjau ? ' · ' + esc(x.catatan_tinjau) : '') + '</div>' : (Number(x.selisih_tunai) !== 0 && can('approve') && x.kasir_id !== S.data.user.uid ? '<button class="chip" data-act="shapp" data-id="' + esc(x.id) + '" data-d="' + esc(x.selisih_tunai) + '">Tandai ditinjau</button>' : '')) + '</div></div>').join('') : '<p class="muted">Belum ada.</p>'); el.innerHTML = h; }); }
async function tutupSimpan() {
  const v = dnum(($('#tf') || {}).value);
  if (isNaN(v) || v < 0 || ($('#tf') || {}).value === '') return toast('Isi jumlah uang tunai di laci');
  if (mineAll().length) return toast('Masih ada transaksi belum terkirim');
  return busy('Menutup kasir…', async () => { try { S.shiftOpen = false; const r = await api('shift.close', {uang_fisik: v, catatan: ($('#tn') || {}).value || ''}); const d = r.selisih_tunai, kv = (a, b) => '<div class="kv"><span>' + a + '</span><span>' + b + '</span></div>';
    $('#tbody').innerHTML = '<div class="okmark">' + svg('check', 30) + '</div><h2 class="c">Kasir ditutup</h2><div class="li" style="display:block">' + kv('Jumlah transaksi', num(r.jumlah_trx)) + kv('Tunai (setelah retur)', rp(r.tunai)) + kv('Transfer', rp(r.transfer)) + kv('QRIS', rp(r.qris)) + (r.lain ? kv('Lainnya', rp(r.lain)) : '') + (r.retur ? kv('Retur di shift ini', rp(r.retur)) : '') + kv('<b>Total</b>', '<b>' + rp(r.total) + '</b>') + '</div>' +
      '<div class="li" style="display:block">' + kv('Modal awal', rp(r.modal_awal)) + kv('Kas keluar', rp(r.kas_keluar)) + kv('Tunai seharusnya di laci', rp(r.tunai_diharapkan)) + kv('Uang di laci', rp(r.uang_fisik)) + '</div>' +
      '<div class="rc-sum"><div><small>Selisih tunai</small><b style="color:' + (d === 0 ? 'var(--ok)' : 'var(--err)') + '">' + (d > 0 ? '+' : '') + rp(d) + '</b></div></div><p class="muted c">' + (d === 0 ? 'Uang laci sesuai.' : d > 0 ? 'Uang laci lebih dari catatan.' : 'Uang laci kurang dari catatan.') + '</p><div id="tlist"></div>'; tutupList(); } catch (e) { toast(e.message); } });
}


async function kasOpen() {
  const m = dnum(($('#tm') || {}).value || '0'); if (isNaN(m) || m < 0) return toast('Modal awal harus berupa angka 0 atau lebih');
  return busy('Membuka kasir…', async () => { try { await api('shift.open', {modal_awal: m}); S.shiftOpen = true; toast('Kasir dibuka'); vTutup(); } catch (e) { toast(e.message); } });
}
async function kasMove() {
  const n = dnum(($('#mn') || {}).value), a = (($('#ma') || {}).value || '').trim(); if (!(n > 0)) return toast('Isi nominal lebih dari 0'); if (a.length < 3) return toast('Alasan wajib diisi');
  const j = ($('#mj') || {}).value, k = ($('#mk') || {}).value || ''; if (j === 'out' && !k) return toast('Pilih kategori biaya untuk kas keluar');
  S.kmRid = S.kmRid || ((window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2)); // kirim ulang setelah timeout memakai id yang sama (tidak menggandakan)
  return busy('Mencatat…', async () => { try { await api('cash.move', {jenis: j, nominal: n, alasan: a, kategori: j === 'out' ? k : undefined, request_id: S.kmRid}); S.kmRid = null; toast('Tercatat'); vTutup(); } catch (e) { if (e.server && !e.retry) S.kmRid = null; toast(e.message); } });
}
async function shiftCheck() { if (!S.token || !can('sell')) return; try { const r = await api('shift.summary', {}, {silent: true}); S.shiftOpen = !!r.sesi; S.wajibBuka = r.wajib_buka !== false; } catch (e) { /* abaikan: hanya untuk spanduk */ } }
const shiftNeeded = () => can('sell') && S.wajibBuka && S.shiftOpen === false;

/* F-17: supervisor/owner menandai selisih kas sudah ditinjau (catatan wajib bila ada selisih). */
async function shiftApprove(id, diff) {
  let note = ''; if (Number(diff) !== 0) { note = prompt('Catatan hasil tinjauan selisih Rp' + num(diff) + ' (min. 3 huruf):'); if (note === null) return; if (note.trim().length < 3) return toast('Catatan wajib diisi'); }
  return busy('Menyimpan…', async () => { try { await api('shift.approve', {id: id, catatan: note.trim()}); toast('Ditandai ditinjau'); tutupList(); } catch (e) { toast(e.message); } });
}
