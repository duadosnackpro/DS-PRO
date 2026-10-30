/* ---------- Aksi (event delegation) ---------- */
function askReason(title, msg, okLabel) { // v1.9.9: pengganti prompt() bawaan browser; resolve(teks alasan) atau null bila dibatalkan
  return new Promise(res => {
    S.opin = {res: res, kind: 'alasan'}; S.qopen = false; // qopen=false: badge() tidak menimpa sheet ini dengan daftar antrean
    sheet('<div class="grab"></div><h2>' + esc(title) + '</h2><p class="muted">' + esc(msg) + '</p><label>Alasan<textarea class="inp ta" id="rsn" rows="3" maxlength="300"></textarea></label><div class="err" id="rerr" role="alert"></div><button class="btn dan" data-act="reason_ok">' + esc(okLabel || 'Lanjutkan') + '</button><button class="btn sec" data-act="close">Batal</button>');
    setTimeout(() => { const t = $('#rsn'); if (t) t.focus(); }, 60);
  });
}
const ACT = {
  login: doLogin, logout: confirmLogout, close: closeSheet, cart: cartSheet, pay: pay,
  hideout: el => { S.hideOut = !!el.checked; LS.set('hideOut', S.hideOut); grid(); }, showout: () => { S.hideOut = false; LS.set('hideOut', false); vKasir(); },
  rday: el => { const p = el.dataset.p; if (p === 'today') { S.day = today(); S.rcustom = false; } else if (p === 'yday') { S.day = addDays(today(), -1); S.rcustom = false; } else S.rcustom = true; vRiwayat(); },
  scat: el => { S.scat = el.dataset.c; vStok(); },
  install: async () => { const ev = S.installEv; if (!ev) return; try { ev.prompt(); await ev.userChoice; } catch (e) {} S.installEv = null; if (S.tab === 'menu') vMenu(); },
  tab: el => { S.tab = el.dataset.t; render(); },
  chan: el => { S.ch = el.dataset.c; LS.set('ch', S.ch); vKasir(); cartbar(); },
  cat: el => { S.cat = el.dataset.c; vKasir(); },
  add: el => { if (el.classList.contains('off')) { return toast(priceOf(el.dataset.v, S.ch) == null ? 'Harga belum diatur untuk channel ini' : 'Stok habis'); } addToCart(el.dataset.v); },
  inc1: el => addToCart(el.dataset.v), dec1: el => dropFromCart(el.dataset.v),
  inc: el => { const l = S.cart[el.dataset.i]; if (!l) return; const st = Number(vById(l.v).stok) || 0; if (T(cfg('blokir_stok_minus')) && l.qty + 1 > st) return toast('Stok tidak cukup'); l.qty++; saveCart(); cartLines(); addonsRender(); cashBox(); upd(); updCard(l.v); buzz(); },
  dec: el => { const l = S.cart[el.dataset.i]; if (!l) return; const id = l.v; l.qty--; if (l.qty <= 0) S.cart.splice(el.dataset.i, 1); saveCart(); if (!S.cart.length && !isWide()) closeSheet(); cartLines(); addonsRender(); cashBox(); upd(); updCard(id); },
  metode: el => { S.metode = el.dataset.m; LS.set('metode', S.metode); const c = $('#mchips'); if (c) c.innerHTML = methodChips(); cashBox(); upd(); },
  qk: el => { S.terima = el.dataset.n; cashBox(); upd(); },
  wa: () => waSend(S.rc, ($('#wa') || {}).value), rawbt: () => printBT(S.rc), print: () => printBrowser(), share: () => shareRc(S.rc), copyrc: () => copyText(receiptText(S.rc)),
  addonnew: () => { if (S.dirty) return toast('Simpan perubahan pengaturan dulu.'); addonSheet(); },
  addonsave: () => { const n = $('#ad_n').value.trim(), h = dnum($('#ad_h').value), c = dnum($('#ad_c').value), st = dnum($('#ad_s').value); if (!n) return toast('Isi nama produk tambahan'); if (!(h >= 0)) return toast('Harga jual tidak valid');
    return busy('Membuat produk tambahan…', async () => { try { await api('addon.create', {nama: n, harga: h, hpp: isNaN(c) ? 0 : c, stok: isNaN(st) ? 0 : st}); await loadData(); closeSheet(); render(); toast('Produk tambahan dibuat'); } catch (e) { toast(e.message); } }); },
  fotopick: () => { const f = $('#foto_file'); if (f) f.click(); }, fotodel: fotoDel, logopick: () => { if (S.dirty) return toast('Simpan perubahan pengaturan dulu.'); const f = $('#logo_file'); if (f) f.click(); }, logosave: logoSave, logodel: logoDel,
  rcpreview: () => { if (S.dirty) return toast('Simpan pengaturan dulu agar pratinjau sesuai.'); S.rc = testRc(); sheet('<div class="grab"></div><h2>Pratinjau struk</h2><p class="muted">Contoh transaksi uji, kertas ' + (rcWidth() === 48 ? '80' : '58') + ' mm.</p><pre class="rc" id="rtxt"></pre><div class="row2"><button class="btn dark" data-act="rawbt">Cetak Bluetooth</button><button class="btn sec" data-act="print">Cetak</button></div><button class="btn pri" data-act="close">Tutup</button>'); refreshRc(); },
  logotest: () => { if (!logoOn()) return toast('Aktifkan "Cetak logo di struk" dan simpan pengaturan dulu'); printBT(testRc()); },
  go_diag: () => { S.tab = 'diag'; render(); },
  opin_ok: opinOk,
  reason_ok: () => { const o = S.opin, v = (($('#rsn') || {}).value || '').trim(); if (!o || o.kind !== 'alasan') return; if (v.length < 3) { $('#rerr').textContent = 'Alasan wajib diisi (minimal 3 huruf).'; return; } S.opin = null; closeSheet(); o.res(v); },
  qauth: async el => { const q = S.queue[el.dataset.i]; if (!q) return; if (!/^Diskon/.test(q.error || '')) return toast('Hanya diskon yang bisa disetujui Owner. Perbarui data lalu Coba lagi, atau Hapus dengan alasan.'); const kind = 'diskon';   // F3: jalur 'selisih' dibuang (tidak berefek di server)
    const tok = await askOwner(q.error + ' Owner dapat menyetujui dengan PIN.', kind, q.rid, q.payload.diskon);
    if (!tok) return queueSheet(); q.payload.override = Object.assign({}, q.payload.override, {[kind]: tok}); q.status = 'pending'; q.state = 'waiting'; q.error = ''; q.alerted = false; LS.set('queue', S.queue); flush(); queueSheet(); },
  go_tutup: () => { S.tab = 'tutup'; render(); }, tclose: () => tutupSimpan(),
  queue: queueSheet, qnow: () => { flush(); setTimeout(() => { if (S.qopen) queueSheet(); }, 700); },
  btdirect: el => { LS.set('btdirect', !!el.checked); toast(el.checked ? 'Cetak langsung via BLE aktif' : 'Cetak lewat RawBT (Android)'); },
  btpick: async () => { try { await btConnect(true); toast('Printer dipilih: ' + (BT.dev.name || 'tanpa nama')); vDiag(); } catch (e) { toast(e && e.name === 'NotFoundError' ? 'Pemilihan printer dibatalkan' : 'Gagal: ' + (e.message || e)); } },
  skugen: el => { const f = {}; document.querySelectorAll('#sheet [data-f]').forEach(e => f[e.dataset.f] = e.value); if (!f.product_id) return toast('Pilih produk dulu'); const i = document.querySelector('#sheet [data-f=sku]'); if (i) i.value = genSkuLocal(f, el.dataset.id || ''); },
  dtwa: () => waSend(testRc(), ''), dtbt: () => printBT(testRc()), dtshare: () => shareRc(testRc()),
  dping: async () => { const el = $('#dres'); el.textContent = 'Menguji…'; const t0 = performance.now(); try { S.srvMs = undefined; await api('ping', {}, {silent: true}); const a = Math.round(performance.now() - t0), ms1 = S.srvMs; // lalu muat data penuh: ukuran dan waktu server untuk bootstrap (hasil dibuang)
      el.textContent = 'Ping: ' + a + ' ms' + (ms1 !== undefined ? ' (server ' + ms1 + ' ms)' : '') + '. Mengukur muat data…'; const t1 = performance.now(); S.srvMs = undefined; const b = await api('bootstrap', {}, {silent: true}); const bt = Math.round(performance.now() - t1), kb = Math.round(JSON.stringify(b).length / 1024);
      el.textContent = 'Ping: ' + a + ' ms' + (ms1 !== undefined ? ' (server ' + ms1 + ' ms)' : '') + ' · Muat data: ' + bt + ' ms' + (S.srvMs !== undefined ? ' (server ' + S.srvMs + ' ms)' : '') + ', ' + kb + ' KB. Bandingkan dengan sebelum/sesudah deploy.'; } catch (e) { el.textContent = 'Gagal: ' + e.message; logErr(e, 'ping'); } },
  dcopy: () => copyText(JSON.stringify({v: C.VERSION, ua: navigator.userAgent, online: navigator.onLine, queue: S.queue.length, penyimpanan: Store.mode(), err: LS.get('errlog', [])}, null, 1), 'Log disalin. Tempel untuk dikirim.'),
  dclear: () => { LS.set('errlog', []); vDiag(); toast('Catatan kesalahan dihapus'); },
  copyurl: () => copyText(location.href.split('#')[0], 'Alamat aplikasi disalin.'),
  qretry: el => { const q = S.queue[el.dataset.i]; if (q) { q.status = 'pending'; q.state = 'waiting'; q.error = ''; q.alerted = false; } LS.set('queue', S.queue); qrefresh(); flush(); },
  qaccept: el => { const q = S.queue[el.dataset.i]; if (!q) return; q.payload.terima_selisih = true; q.status = 'pending'; q.state = 'waiting'; q.error = ''; q.alerted = false; LS.set('queue', S.queue); qrefresh(); flush(); toast('Dikirim ulang dengan harga server; ditandai untuk ditinjau Owner'); },
  sreview: async el => { const note = await askReason('Tandai sudah ditinjau?', 'Tulis hasil peninjauan (mis. selisih harga dijelaskan, stok sudah di-opname). Angka transaksi tidak diubah.', 'Tandai ditinjau'); if (note === null) return;
    try { await api('sale.review', {id: el.dataset.id, catatan: note}); S.rhist = null; VC = {}; toast('Ditandai sudah ditinjau'); if (S.tab === 'riwayat') vRiwayat(); else if (S.tab === 'dash') render(); } catch (e) { toast(e.auth ? 'Sesi berakhir, masuk lagi' : e.message); } },
  qretryall: () => { S.queue.forEach(q => { if (q.status === 'review' && (q.uid === S.data.user.uid || q.by === S.data.user.uid) && !qinfo(q).auth) { q.status = 'pending'; q.state = 'waiting'; q.error = ''; q.alerted = false; } }); LS.set('queue', S.queue); qrefresh(); flush(); },
  more: el => { const k = el.dataset.k; if (!PGN[k]) return; LIM[k] = lim(k) + PGN[k]; // satu halaman lagi
    if (k === 'grid') grid(); else if (k === 'cart') cartLines(); else if (k === 'hist') { if (S.rcur && S.rcur.srv) { if (S.rmore) S.rmore(); } else if (S.rlist && S.rcur) S.rlist(S.rcur); }
    else if (k === 'q') { const sc = document.querySelector('#sheet .sheet'), top = sc ? sc.scrollTop : 0; queueSheet(); const n2 = document.querySelector('#sheet .sheet'); if (n2) n2.scrollTop = top; } }, // sheet digambar ulang: pertahankan posisi gulir
  qdel: async el => {
    const q = S.queue[el.dataset.i]; if (!q) return;
    if (!navigator.onLine) return toast('Hubungkan internet dulu: penghapusan dicatat ke server agar ada jejaknya');
    const fromQ = S.qopen, back = () => { if (fromQ) queueSheet(); }, alasan = await askReason('Hapus transaksi ' + rp(q.total) + '?', 'Alasan wajib dan dicatat di server. Tulis juga bila uang pelanggan sudah diterima.' + (can('approve') ? '' : ' Kasir memerlukan persetujuan PIN Owner/Supervisor.'), 'Hapus transaksi'); if (alasan === null) return back();
    let tok = null; if (!can('approve')) { tok = await askOwner('Hapus transaksi ' + rp(q.total) + ' dari antrean: ' + alasan.trim(), 'hapus', q.rid, q.total); if (!tok) return back(); }   // P0 (F-04): kasir tidak boleh membuang penjualan sendirian
    try { await api('sale.reject_log', {override_token: tok, aksi: 'hapus', nomor: q.nomor || '', galat: q.error || '', request_id: q.rid, total: q.total, metode: q.payload.metode_bayar, channel: q.ch, waktu: fmtDT(q.ts), error: q.error || '', alasan: alasan.trim(), items: q.payload.items.map(it => { const v = vById(it.variant_id); return {sku: v ? v.sku : it.variant_id, qty: it.qty}; })}); }
    catch (e) { back(); return toast(e.auth ? 'Sesi berakhir, masuk lagi' : e.server ? e.message : 'Tidak ada koneksi; coba lagi'); }
    const k = S.queue.indexOf(q); if (k < 0) return back(); S.queue.splice(k, 1); q.payload.items.forEach(it => { const v = vById(it.variant_id); if (v) v.stok = r6((Number(v.stok) || 0) + it.qty); }); LS.set('queue', S.queue); LS.set('data', S.data); badge(); if (fromQ) queueSheet(); else qrefresh(); toast('Dihapus dan dicatat di server');
  },
  retur: el => returOpen(el.dataset.id), retur_ok: () => returGo(),
  retur_all: () => { document.querySelectorAll('#sheet [data-rv]').forEach(e => { e.value = e.max; }); },
  ohsaran: async () => { const el = $('#oh-saran'); try { const r = await api('overhead.saran', {}); if (r.saran_per_unit == null) { if (el) el.textContent = r.pesan || 'Belum bisa dihitung.'; return; } if (el) el.textContent = 'Bulan ' + r.bulan + ': biaya ' + rp(r.biaya) + ' dibagi ' + num(r.unit) + ' unit = ' + rp(r.saran_per_unit) + ' per bungkus. Diisikan ke kolom di atas; tekan Simpan pengaturan.'; const f = document.querySelector('#sf [data-f="overhead_per_unit"]'), m = document.querySelector('#sf [data-f="metode_overhead"]'); if (m && m.value !== 'per_unit') { m.value = 'per_unit'; m.dispatchEvent(new Event('change', {bubbles: true})); } if (f) { f.value = r.saran_per_unit; f.dispatchEvent(new Event('input', {bubbles: true})); } } catch (e) { toast(e.message); } },
  stab: el => { S.stab = el.dataset.s; S.scat = 'Semua'; S.sq = ''; vStok(); },
  adj: el => adjSheet(el.dataset.t, el.dataset.id), adjsave: el => adjSave(el.dataset.t, el.dataset.id),
  pbopen: pbSheet, pbdel: el => { S.pb.items.splice(el.dataset.i, 1); pbSheet(); }, pbsave: pbSave,
  pbadd: () => { const q = dnum($('#pb_q').value), h = dnum($('#pb_h').value), id = $('#pb_m').value; if (!id || !(q > 0) || !(h >= 0) || $('#pb_h').value === '') return toast('Isi jumlah dan harga'); S.pb.items.push({id: id, qty: q, harga: h}); pbSheet(); },
  go_master: () => { S.tab = 'master'; render(); }, go_riwayat: () => { S.tab = 'riwayat'; render(); }, go_laporan: () => { S.tab = 'laporan'; render(); }, go_shopee: () => { S.tab = 'shopee'; render(); }, go_resep: () => { S.tab = 'resep'; render(); }, go_cek: () => { S.tab = 'cek'; render(); }, go_users: () => { S.tab = 'users'; render(); }, go_settings: () => { S.tab = 'settings'; render(); },
  expvoid: el => { const why = (($('#xv_r') || {}).value || '').trim(); if (why.length < 3) return toast('Alasan pembatalan wajib diisi');
    return busy('Membatalkan…', async () => { try { await api('expense.void', {id: el.dataset.id, alasan: why}); S.expLoaded = false; closeSheet(); loadExp(); toast('Biaya dibatalkan'); } catch (e) { toast(e.message); } }); },
  pbhist: () => pbHist(), pbcancel: el => pbCancel(el.dataset.id), shapp: el => shiftApprove(el.dataset.id, el.dataset.d),
  plock: () => { const d = ($('#pl_d') || {}).value || '', r = (($('#pl_r') || {}).value || '').trim(); if (r.length < 3) return toast('Alasan wajib diisi');
    if (!confirm(d ? 'Kunci semua periode sampai ' + d + '? Biaya/impor pada tanggal itu dan sebelumnya akan ditolak.' : 'Buka semua kunci periode?')) return;
    return busy('Menyimpan…', async () => { try { await api('period.lock', {sampai: d, alasan: r}); await loadData(); render(); toast('Kunci periode disimpan'); } catch (e) { toast(e.message); } }); },
  mt: el => { S.mt = el.dataset.k; vMaster(); }, medit: el => meditSheet(el.dataset.id), msave: el => mSave(el.dataset.id), mdel: el => mDel(el.dataset.id),
  uunlock: async el => { try { await api('user.unlock', {id: el.dataset.id}); closeSheet(); vUsers(); toast('Kunci akun dibuka'); } catch (e) { toast(e.message); } }, uedit: el => ueditSheet(el.dataset.id), usave: el => uSave(el.dataset.id), ssave: sSave,
  sync: () => busy('Memperbarui data…', async () => { try {
    if (own()) { await api('sistem.refresh', {}); await loadData(); lastChk = Date.now(); render(); await flush(); toast('Data diperbarui'); } // Owner: muat ulang penuh dan bersihkan cache server (setelah mengedit spreadsheet langsung)
    else { const r = await verSync(0); if (r === null) throw new Error('Tidak ada koneksi ke server'); if (r) redrawFor(r); await flush(); toast(r ? 'Data diperbarui' : 'Sudah yang terbaru'); } // Kasir: hanya memuat bila ada data baru
  } catch (e) { if (e.auth) softLogout(); else toast('Gagal memperbarui: ' + e.message); } })
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'), a = el && el.dataset.act; if (!el || !ACT[a]) return;
  if (S.dirty && S.tab === 'settings' && (a === 'tab' || a === 'logout' || a === 'sync' || /^go_/.test(a))) { if (!confirm('Perubahan pengaturan belum disimpan. Keluar tanpa menyimpan?')) return; S.dirty = false; }
  ACT[a](el);
});
document.addEventListener('input', e => { if (S.tab === 'settings' && e.target.closest && e.target.closest('#sf')) sDirty(); });
document.addEventListener('change', e => { const t0 = /** @type {HTMLSelectElement} */ (e.target); if (t0 && t0.dataset && t0.dataset.f === 'role' && t0.closest && t0.closest('#sheet')) { const ri = $('#role-info'); if (ri) ri.textContent = ROLE_INFO[t0.value] || 'Pilih peran untuk melihat hak aksesnya.'; const pl = $('#pin-lbl'); if (pl && pl.firstChild) pl.firstChild.textContent = credLabel(t0.value, (($('[data-act="usave"]') || {dataset: {}}).dataset || {}).id); return; } if (e.target.id === 'foto_file') { const f = e.target.files && e.target.files[0]; e.target.value = ''; fotoLoad(f); return; } if (e.target.id === 'logo_file') { const f = e.target.files && e.target.files[0]; e.target.value = ''; logoLoad(f); return; } if (S.tab === 'settings' && e.target.closest && e.target.closest('#sf')) sDirty(); });
document.addEventListener('input', e => { if (e.target.dataset && e.target.dataset.lg) logoEdit(e.target); });
window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installEv = e; if (S.tab === 'menu' && S.data) vMenu(); });
window.addEventListener('appinstalled', () => { S.installEv = null; if (S.tab === 'menu' && S.data) vMenu(); });
{ let rzT = 0; window.addEventListener('resize', () => { cancelAnimationFrame(rzT); rzT = requestAnimationFrame(initFades); }); }
document.addEventListener('input', e => {
  const k = e.target.dataset && e.target.dataset.in; if (!k) return; let v = e.target.value;
  if (k === 'q') { S.q = v; clearTimeout(S.qT); S.qT = setTimeout(() => { if ($('#grid')) grid(); }, 90); return; } // v1.9.9: gabungkan ketikan beruntun menjadi satu penggambaran
  if (k === 'sq') { S.sq = v; return stokList(); }
  if (k === 'pbsup') { S.pb.sup = v; return; }
  if (k === 'pbongkir') { S.pb.ongkir = v.replace(/\D/g, ''); return; }
  if (k === 'catatan') { S.catatan = v; return; }
  if (k === 'ref') { S.ref = v; return; }
  if (k === 'diskon' || k === 'terima') { v = v.replace(/\D/g, ''); S[k] = v; return upd(); }
});
document.addEventListener('change', e => { if (e.target.dataset && e.target.dataset.chg === 'day') { S.day = e.target.value; vRiwayat(); } });
document.addEventListener('keydown', e => { const t = /** @type {HTMLElement} */ (e.target); if ((e.key === 'Enter' || e.key === ' ') && t && t.matches && t.matches('[role="button"][data-act]:not(button)')) { e.preventDefault(); t.click(); return; } /* kartu produk berperan tombol: sebelumnya hanya bisa diketuk/diklik, tidak bisa lewat keyboard */ if (e.key === 'Tab') trapTab(e); if (e.key === 'Escape' && $('#sheet') && !$('#sheet').hidden && (!S.opin || S.opin.kind === 'alasan') && !S.busyOn) { closeSheet(); return; } if (e.key === 'Enter' && $('#lp') && document.activeElement === $('#lp')) doLogin(); });

