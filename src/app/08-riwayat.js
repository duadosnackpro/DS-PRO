/* ---------- Riwayat ---------- */
async function vRiwayat() {
  const t0 = today(), day = S.day || t0; if (S.rlimDay !== day) { S.rlimDay = day; delete LIM.hist; } // hari berganti: mulai dari halaman pertama
  const yd = addDays(t0, -1), pre = S.rcustom ? 'custom' : day === t0 ? 'today' : day === yd ? 'yday' : 'custom';
  $('#main').innerHTML = wrapChips('<button class="chip ' + (pre === 'today' ? 'on' : '') + '" data-act="rday" data-p="today">Hari ini</button><button class="chip ' + (pre === 'yday' ? 'on' : '') + '" data-act="rday" data-p="yday">Kemarin</button><button class="chip ' + (pre === 'custom' ? 'on' : '') + '" data-act="rday" data-p="custom">Pilih tanggal</button>') +
    '<p class="muted rcap">' + esc(idDate(day)) + '</p>' + (pre === 'custom' ? '<label>Tanggal<input type="date" class="inp" data-chg="day" value="' + day + '"></label>' : '') + '<div id="rq"></div><div id="rsum"></div><div id="rlist">' + skel(3) + '</div>';
  const qs = S.queue.map((q, i) => q.uid !== S.data.user.uid && q.by !== S.data.user.uid ? '' : '<div class="li"><div><b>' + rp(q.total) + '</b> <span class="muted">' + esc(q.ch) + ' · ' + fmtDT(q.ts).slice(11) + '</span>' +
    (q.status === 'review' ? '<div class="muted" style="color:var(--err)">' + esc(q.error) + '</div>' : '') + '</div><div class="r"><span class="tag ' + (q.status === 'review' ? 'red' : '') + '">' + (q.status === 'review' ? 'Perlu ditinjau' : 'Menunggu kirim') + '</span>' +
    (q.status === 'review' ? '<div><button class="chip" data-act="qretry" data-i="' + i + '">Coba lagi</button> <button class="chip" data-act="qdel" data-i="' + i + '">Hapus</button></div>' : '') + '</div></div>').join('');
  $('#rq').innerHTML = qs;
  const uid = S.data.user.uid, hist = S.rhist && S.rhist.uid === uid ? S.rhist : (S.rhist = {uid: uid, d: {}}), ent = hist.d[day];
  const paint = e => {
    if (S.tab !== 'riwayat' || !$('#rlist') || !$('#rsum')) return; const rows = e.rows; S.rcur = e;
    const sm = e.sum || (() => { const dn = rows.filter(r => r.status === 'selesai'); return {omzet: dn.reduce((a, r) => a + Number(r.total), 0), nTrx: dn.filter(r => !r.ref_sale_id).length, nDone: dn.length}; })(), nTrx = sm.nTrx, omzet = sm.omzet, avg = nTrx ? omzet / nTrx : 0; // v1.9.9: ringkasan dari server (semua transaksi), bukan hanya halaman yang dimuat; // retur (nilai minus) mengurangi omzet tetapi tidak dihitung sebagai transaksi
    $('#rsum').innerHTML = '<div class="kgrid"><div class="kpi"><div class="muted">Omzet</div><b>' + rp(omzet) + '</b></div><div class="kpi"><div class="muted">Transaksi</div><b>' + nTrx + '</b></div><div class="kpi wide"><div class="muted">Rata-rata per transaksi</div><b>' + rp(avg) + '</b></div>' + (own() ? '<div class="kpi wide"><div class="muted">Produk terlaris</div><b id="rtop">' + (sm.nDone ? (e.top || 'Memuat…') : '-') + '</b></div>' : '') + '</div>';
    if (own() && sm.nDone && !e.top && !e.topReq) { e.topReq = true; api('report.get', {type: 'penjualan', from: day, to: day}, {silent: true}).then(r => { const best = r.rows.slice().sort((a, b) => b[2] - a[2])[0]; e.top = best ? esc((best[0] + ' ' + best[1]).trim()) + ' <small class="muted">' + qf(best[2]) + ' terjual</small>' : '-'; const el = $('#rtop'); if (el && S.tab === 'riwayat') el.innerHTML = e.top; }).catch(() => { const el = $('#rtop'); if (el && !e.top) el.textContent = '-'; }); }
    paintList(e);
  };
  const paintList = e => { // v1.9.8: daftar bertahap; "Tampilkan lagi" hanya menggambar ulang daftar (KPI tidak dihitung ulang)
    if (S.tab !== 'riwayat' || !$('#rlist')) return; const rows = e.rows;
    const rest = e.srv ? e.total - rows.length : 0; $('#rlist').innerHTML = (e.srv ? rows : rows.slice(0, lim('hist'))).map(r => '<div class="li"><div><b>' + esc(r.nomor) + '</b>' + (r.ref_sale_id ? ' <span class="tag red">Retur</span>' : '') + '<div class="muted">' + esc(String(r.tanggal).slice(11, 16)) + ' · ' + esc(chName(r.channel_id)) + ' · ' + esc(r.metode_bayar) + '</div></div><div class="r"><b>' + rp(r.total) + '</b>' + (r.status === 'selesai' && !r.ref_sale_id ? '<div><button class="chip" data-act="retur" data-id="' + esc(r.id) + '">Retur</button></div>' : '') + '</div></div>').join('') + (e.srv ? (rest > 0 ? '<button class="btn sec lmore" data-act="more" data-k="hist">Tampilkan ' + Math.min(rest, PGN.hist) + ' lagi (sisa ' + rest + ')</button>' : '') : moreBtn('hist', rows.length)) ||
      emptyState('riwayat', 'Belum ada transaksi', 'Tidak ada transaksi pada ' + esc(idDate(day)) + '.', '<button class="btn pri" data-act="tab" data-t="kasir">Mulai transaksi</button>');
    watchMore();
  };
  S.rlist = paintList;
  S.rmore = async () => { // halaman berikutnya dari server; hindari ganda lewat id (transaksi baru menggeser urutan)
    const e = S.rcur; if (!e || !e.srv || e.loading || e.rows.length >= e.total) return; e.loading = true;
    try { const r = await api('sales.list', {tanggal: day, limit: PGN.hist, offset: e.rows.length}, {silent: true}); if (r && r.rows) { const seen = new Set(e.rows.map(x => x.id)); r.rows.forEach(x => { if (!seen.has(x.id)) e.rows.push(x); }); e.total = r.total; } }
    catch (er) { toast('Gagal memuat transaksi berikutnya: ' + er.message); } finally { e.loading = false; if (S.rcur === e) paintList(e); }
  };
  try {
    if (ent) paint(ent); // tampil seketika dari hasil terakhir; diperbarui hanya bila ada data baru
    if (ent && navigator.onLine === false) return;
    await verSync(15000); if (S.tab !== 'riwayat' || !$('#rlist')) return; // cek versi murah dulu; muat daftar penuh hanya bila versi berubah
    const k = dverKey(); if (ent && ent.k === k) return;
    const res = await api('sales.list', {tanggal: day, limit: PGN.hist}); if (S.tab !== 'riwayat' || !$('#rlist')) return;
    const ne = Array.isArray(res) ? {k: k, rows: res} : {k: k, rows: res.rows, total: res.total, sum: res.summary, srv: true}; /* server lama menjawab larik penuh */ hist.d[day] = ne; Object.keys(hist.d).slice(0, -8).forEach(x => delete hist.d[x]); paint(ne); // maks. 8 hari disimpan di memori
  } catch (e) { if ($('#rlist') && !ent) $('#rlist').innerHTML = '<p class="muted">Tidak bisa memuat riwayat dari server (' + esc(e.message) + ').</p>'; }
}

