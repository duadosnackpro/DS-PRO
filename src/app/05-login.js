/* ---------- Login ---------- */
function renderLogin(msg) {
  $('#app').innerHTML = '<div class="login"><div class="lg-hero"><img src="icons/icon-192.png" alt="Duado Snack" width="116" height="116"><h1 class="wordmark">DUADO SNACK</h1><p>Jajanan Cemilan Pedas</p></div><div class="lg-card">' +
    '<label>Username<input id="lu" class="inp" autocomplete="username" autocapitalize="none" value="' + esc(LS.get('lastUser', '')) + '"></label>' +
    '<label>PIN atau kata sandi<input id="lp" class="inp" type="password" autocomplete="current-password"></label>' +
    '<label class="sw"><input type="checkbox" id="lsh"' + (LS.get('shared', false) ? ' checked' : '') + '><span class="sw-t" aria-hidden="true"></span><span class="sw-l"><b>Perangkat bersama</b><small>Hapus data lokal saat keluar</small></span></label>' +
    '<button class="btn pri big" data-act="login">Masuk</button><div class="err" id="lerr" role="alert">' + esc(msg || '') + '</div>' +
    (S.queue.length ? '<div class="muted">' + S.queue.length + ' transaksi menunggu dikirim setelah masuk.</div>' : '') + '</div></div>';
}
async function doLogin() {
  const u = $('#lu').value.trim(), p = $('#lp').value; if (!u || !p) return;
  $('#lerr').textContent = '';
  await busy('Masuk…', async () => { try {
    const r = await api('login', {username: u, pin: p, dev: devId()}); S.token = r.token;
    /* Penguncian ganti user: antrean pengguna lain yang belum terkirim tidak boleh tertinggal atau tercampur. */
    const other = S.queue.filter(q => q.uid !== r.uid);
    if (other.length) {
      if (can('takeover', r.role) && confirm('Ada ' + other.length + ' transaksi pengguna lain yang belum terkirim di perangkat ini.\n\nKirim atas nama mereka sekarang (diambil alih Owner)? Pilih Batal untuk membatalkan login.')) other.forEach(q => { q.by = r.uid; });
      else { try { await api('logout', {}, {silent: true}); } catch (e) {} S.token = null; throw Object.assign(new Error(can('takeover', r.role) ? 'Login dibatalkan. Antrean pengguna lain belum terkirim.' : 'Masih ada ' + other.length + ' transaksi pengguna lain yang belum terkirim di perangkat ini. Masuk sebagai pengguna tersebut dulu agar antrean terkirim, atau hubungi Owner.'), {server: true}); }
      LS.set('queue', S.queue);
    }
    LS.set('token', r.token); LS.set('lastUser', u); LS.set('shared', !!($('#lsh') && $('#lsh').checked));
    await loadData(); await shiftCheck(); S.tab = homeTab(); render(); flush();
    if (r.pin_lemah) setTimeout(() => toast(own() ? 'PIN Anda lemah. Ganti di Menu, Pengguna.' : 'PIN Anda lemah. Minta Owner menggantinya.'), 900);
  } catch (e) { S.token = null; $('#lerr').textContent = e.server ? e.message : 'Tidak dapat terhubung ke server. ' + e.message; } });
}

