/* ---------- Tutup kasir ---------- */
const KAS_CATS = ['Transport', 'Gas', 'Listrik', 'Air', 'Pemasaran', 'Lain-lain']; // kategori kas keluar laci (P0 F-05); server hanya mewajibkan terisi
async function vTutup() {
  const back = '<button class="chip" data-act="tab" data-t="menu">← Menu</button>';
  $('#main').innerHTML = back + '<div class="li" style="display:block;margin-top:8px"><b>Tutup kasir</b><p class="muted">Hitung uang tunai di laci lebih dulu, isi jumlahnya, lalu tutup. Rekap penjualan baru tampil setelah penutupan (hitung buta) agar selisihnya jujur.</p></div><div id="tbody">' + skel(3) + '</div>';
  const unsent = mineAll().length;
  if (unsent) { flush(); $('#tbody').innerHTML = '<div class="notice"><span>Masih ada ' + unsent + ' transaksi yang belum terkirim ke server. Kirim dulu agar rekap lengkap.</span><button class="chip" data-act="tab" data-t="tutup">Periksa lagi</button></div><button class="btn pri" data-act="qnow">Kirim sekarang</button>'; return; }
  await vload('shift.summary', {}, r => {
    if (S.tab !== 'tutup' || !$('#tbody')) return; const typed = ($('#tf') && $('#tf').value) || ($('#tn') && $('#tn').value) || ($('#tm') && $('#tm').value) || ($('#mn') && $('#mn').value); S.shift = r; if (typed) return; /* jangan menimpa isian yang sedang diketik */ const kv = (a, b) => '<div class="kv"><span>' + a + '</span><span>' + b + '</span></div>';
    S.shiftOpen = !!r.sesi; S.wajibBuka = r.wajib_buka !== false; shiftUpd();
    if (!r.sesi) { // F4: modal awal ditetapkan saat BUKA kasir (sebelum ada penjualan), bukan diketik saat tutup
      $('#tbody').innerHTML = '<div class="li" style="display:block"><b>Kasir belum dibuka</b><p class="muted">Hitung uang modal di laci, isi jumlahnya, lalu buka kasir. Angka ini terkunci dan dipakai menghitung selisih saat tutup.</p></div>' +
        '<label>Modal awal laci (Rp)<input class="inp" id="tm" inputmode="numeric" placeholder="0"></label><button class="btn pri big" data-act="kopen">Buka kasir</button><div id="tlist"></div>'; tutupList(); return;
    }
    const mv = (r.gerakan || []).map(g => '<div class="kv"><span>' + (g.jenis === 'in' ? 'Kas masuk' : 'Kas keluar') + ' · ' + esc(g.alasan) + '</span><span>' + rp(g.nominal) + '</span></div>').join('');
    $('#tbody').innerHTML = '<div class="li" style="display:block">' + kv('Sejak', esc(String(r.dari).slice(0, 16))) + kv('Jumlah transaksi', num(r.jumlah_trx)) + kv('Modal awal', rp(r.modal_awal)) + mv + '</div>' +
      '<div class="li" style="display:block"><b>Kas masuk/keluar</b><p class="muted">Mis. beli es batu memakai uang laci. Catat SAAT terjadi, dengan alasan. Kas keluar otomatis tercatat sebagai biaya sesuai kategorinya.</p><div class="row2"><label><span id="mj_l">Jenis</span><select class="inp" id="mj" aria-labelledby="mj_l"><option value="out">Keluar</option><option value="in">Masuk</option></select></label><label>Nominal (Rp)<input class="inp" id="mn" inputmode="numeric" placeholder="0"></label></div><label><span id="mk_l">Kategori biaya (wajib untuk kas keluar)</span><select class="inp" id="mk" aria-labelledby="mk_l"><option value="">Pilih kategori</option>' + KAS_CATS.map(c => '<option>' + esc(c) + '</option>').join('') + '</select></label><label>Alasan<input class="inp" id="ma" placeholder="Min. 3 huruf"></label><button class="btn sec" data-act="kmove">Catat kas</button></div>' +
      '<label>Uang tunai di laci sekarang (Rp)<input class="inp" id="tf" inputmode="numeric" placeholder="Hitung dulu, lalu isi"></label><label>Catatan (opsional)<input class="inp" id="tn"></label><button class="btn pri big" data-act="tclose">Tutup kasir</button><div id="tlist"></div>';
    tutupList();
  }, {fail: e => { if ($('#tbody')) $('#tbody').innerHTML = '<p class="err">' + esc(e.message) + '</p>'; }});
}
async function tutupList() { await vload('shift.list', {}, L => { let el = $('#tlist'); if (!el && $('#tbody')) { el = document.createElement('div'); el.id = 'tlist'; $('#tbody').appendChild(el); } if (!el) return; const seen = {}, h = '<h3 style="margin:14px 0 6px">Penutupan terakhir</h3>' + (L.length ? L.slice(0, 10).map(x => { const latest = !seen[x.kasir_id]; seen[x.kasir_id] = 1; x._ro = latest && can('approve') && (own() || x.kasir_id !== S.data.user.uid); return x; }).map(x => '<div class="li" style="display:block"><div class="kv"><b>' + esc(x.kasir) + '</b><span>' + esc(String(x.sampai).slice(0, 16)) + '</span></div><div class="muted">' + num(x.jumlah_trx) + ' trx · total ' + rp(x.total_semua) + ' · tunai laci ' + rp(x.uang_fisik) + (own() ? ' · modal ' + rp(x.modal_awal) + (x.fisik_sebelumnya != null && Math.abs(Number(x.modal_awal) - x.fisik_sebelumnya) > 0.5 ? ' (sisa laci sebelumnya ' + rp(x.fisik_sebelumnya) + ')' : '') + (Number(x.kas_keluar) > 0 ? ' · kas keluar ' + rp(x.kas_keluar) : '') : '') + ' · selisih <b style="color:' + (Number(x.selisih_tunai) === 0 ? 'var(--ok)' : 'var(--err)') + '">' + rp(x.selisih_tunai) + '</b>' +
    (x._ro ? '<button class="chip" data-act="shreopen" data-id="' + esc(x.id) + '">Salah input? Buka kembali</button> ' : '') + (x.disetujui ? '<div><span class="tag">Ditinjau</span> ' + esc(x.disetujui_oleh || '') + (x.catatan_tinjau ? ' · ' + esc(x.catatan_tinjau) : '') + '</div>' : (Number(x.selisih_tunai) !== 0 && can('approve') && x.kasir_id !== S.data.user.uid ? '<button class="chip" data-act="shapp" data-id="' + esc(x.id) + '" data-d="' + esc(x.selisih_tunai) + '">Tandai ditinjau</button>' : '')) + '</div></div>').join('') : '<p class="muted">Belum ada.</p>'); el.innerHTML = h; }); }
async function tutupSimpan() {
  const v = dnum(($('#tf') || {}).value);
  if (isNaN(v) || v < 0 || ($('#tf') || {}).value === '') return fail('Isi jumlah uang tunai di laci', '#tf');
  if (mineAll().length) return fail('Masih ada transaksi belum terkirim');
  return busy('Menutup kasir…', async () => { try { const r = await api('shift.close', {uang_fisik: v, catatan: ($('#tn') || {}).value || ''}); S.shiftOpen = false; shiftUpd(); const d = r.selisih_tunai, kv = (a, b) => '<div class="kv"><span>' + a + '</span><span>' + b + '</span></div>';
    $('#tbody').innerHTML = '<div class="okmark">' + svg('check', 30) + '</div><h2 class="c">Kasir ditutup</h2><div class="li" style="display:block">' + kv('Jumlah transaksi', num(r.jumlah_trx)) + kv('Tunai (setelah retur)', rp(r.tunai)) + kv('Transfer', rp(r.transfer)) + kv('QRIS', rp(r.qris)) + (r.lain ? kv('Lainnya', rp(r.lain)) : '') + (r.retur ? kv('Retur di shift ini', rp(r.retur)) : '') + kv('<b>Total</b>', '<b>' + rp(r.total) + '</b>') + '</div>' +
      '<div class="li" style="display:block">' + kv('Modal awal', rp(r.modal_awal)) + kv('Kas keluar', rp(r.kas_keluar)) + kv('Tunai seharusnya di laci', rp(r.tunai_diharapkan)) + kv('Uang di laci', rp(r.uang_fisik)) + '</div>' +
      '<div class="rc-sum"><div><small>Selisih tunai</small><b style="color:' + (d === 0 ? 'var(--ok)' : 'var(--err)') + '">' + (d > 0 ? '+' : '') + rp(d) + '</b></div></div><p class="muted c">' + (d === 0 ? 'Uang laci sesuai.' : d > 0 ? 'Uang laci lebih dari catatan.' : 'Uang laci kurang dari catatan.') + '</p><div id="tlist"></div>'; tutupList(); } catch (e) { fail(e.message); } });
}


/* P2 (UX-04): kasir dibuka langsung dari banner Kasir atau chip di header lewat sheet kecil (ketuk, isi modal, ketuk), tanpa pindah layar: keranjang dan posisi tetap. Halaman Tutup kasir tetap bisa membukanya. */
function kasOpenSheet() {
  sheet('<div class="grab"></div><h2>Buka kasir</h2><p class="muted">Hitung uang modal di laci dan isi jumlahnya. Angka ini terkunci untuk menghitung selisih saat tutup.</p><label>Modal awal laci (Rp)<input class="inp" id="bm" inputmode="numeric" placeholder="0"></label><button class="btn pri big" data-act="kopen">Buka kasir</button><button class="btn sec" data-act="close">Batal</button>');
  setTimeout(() => { const i = $('#bm'); if (i) i.focus(); }, 60);
}
async function kasOpen() {
  const inSheet = !!$('#bm'), fld = inSheet ? '#bm' : '#tm';
  const m = dnum(($(fld) || {}).value || '0'); if (isNaN(m) || m < 0) return fail('Modal awal harus berupa angka 0 atau lebih', fld);
  return busy('Membuka kasir…', async () => { try { await api('shift.open', {modal_awal: m}); S.shiftOpen = true; if (inSheet) closeSheet(); toast('Kasir dibuka'); if (S.tab === 'tutup') vTutup(); else render(); } catch (e) { fail(e.message); } });
}
async function kasMove() {
  const n = dnum(($('#mn') || {}).value), a = (($('#ma') || {}).value || '').trim(); if (!(n > 0)) return fail('Isi nominal lebih dari 0', '#mn'); if (a.length < 3) return fail('Alasan wajib diisi (min. 3 huruf)', '#ma');
  const j = ($('#mj') || {}).value, k = ($('#mk') || {}).value || ''; if (j === 'out' && !k) return fail('Pilih kategori biaya untuk kas keluar', '#mk');
  S.kmRid = S.kmRid || ((window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2)); // kirim ulang setelah timeout memakai id yang sama (tidak menggandakan)
  return busy('Mencatat…', async () => { try { await api('cash.move', {jenis: j, nominal: n, alasan: a, kategori: j === 'out' ? k : undefined, request_id: S.kmRid}); S.kmRid = null; toast('Tercatat'); vTutup(); } catch (e) { if (e.server && !e.retry) S.kmRid = null; fail(e.message); } });
}
async function shiftCheck() { if (!S.token || !can('sell')) return; try { const r = await api('shift.summary', {}, {silent: true}); S.shiftOpen = !!r.sesi; S.wajibBuka = r.wajib_buka !== false; } catch (e) { /* abaikan: hanya untuk spanduk */ } }
const shiftNeeded = () => can('sell') && S.wajibBuka && S.shiftOpen === false;

/* F-17: supervisor/owner menandai selisih kas sudah ditinjau (catatan wajib bila ada selisih). */
async function shiftApprove(id, diff) {
  let note = ''; if (Number(diff) !== 0) { note = await askReason('Tinjau selisih Rp' + num(diff), 'Tulis hasil peninjauan (min. 3 huruf).', 'Tandai ditinjau', {label: 'Catatan', danger: false}); if (note === null) return; }
  return busy('Menyimpan…', async () => { try { await api('shift.approve', {id: id, catatan: note.trim()}); toast('Ditandai ditinjau'); tutupList(); } catch (e) { fail(e.message); } });
}

/* 0031: buka kembali penutupan yang salah input (owner/admin; supervisor untuk kasir lain). Sesi kembali terbuka, lalu kasir menutup ulang dengan angka yang benar. */
async function shiftReopen(id) {
  const why = await askReason('Buka kembali penutupan?', 'Kasir bisa mengisi ulang uang laci. Tulis alasannya, mis. salah ketik uang laci.', 'Buka kembali', {danger: false}); if (why === null) return;
  return busy('Membuka kembali…', async () => { try { await api('shift.reopen', {id: id, alasan: why.trim()}); S.shiftOpen = true; shiftUpd(); toast('Dibuka kembali. Isi ulang uang laci.'); vTutup(); } catch (e) { fail(e.message); } });
}
