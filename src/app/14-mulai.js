/* ---------- Mulai ---------- */
let swReg = null;
function updBanner() { const b = $('#upd'); b.hidden = false; b.innerHTML = 'Versi baru tersedia <button data-act="reload">Muat ulang</button>'; }
if ('serviceWorker' in navigator) {
  const had = !!navigator.serviceWorker.controller; let rl = false;
  navigator.serviceWorker.register('sw.js', {updateViaCache: 'none'}).then(reg => {
    swReg = reg; if (reg.waiting && had) updBanner();
    reg.addEventListener('updatefound', () => { const nw = reg.installing; if (nw) nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) updBanner(); }); });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had && !rl) { rl = true; reloadWhenIdle(); } });
}
/* v1.9.8: pembaruan tidak boleh memutus sesi kasir. Pemuatan ulang (mis. akibat tab lain menekan "Muat ulang") menunggu sampai tidak ada layar terbuka, permintaan berjalan,
   atau pengiriman antrean; keranjang dan antrean sudah tersimpan di perangkat sehingga tetap utuh setelah dimuat ulang. */
const idleNow = () => $('#sheet').hidden && !S.busyOn && !flushing && !S.dirty && pending === 0;
let rlT = null;
function reloadWhenIdle() {
  clearTimeout(rlT);
  if (!(S.token && S.data) || idleNow()) { Promise.resolve(Store.flush()).catch(() => {}).then(() => location.reload()); return; }
  const b = $('#upd'); b.hidden = false; b.textContent = 'Versi baru siap. Aplikasi dimuat ulang otomatis setelah layar yang sedang terbuka selesai.';
  rlT = setTimeout(reloadWhenIdle, 1500);
}
ACT.reload = () => { if (S.token && S.data && !idleNow()) return toast('Selesaikan dulu layar yang sedang terbuka, lalu tekan Muat ulang lagi'); if (swReg && swReg.waiting) swReg.waiting.postMessage({type: 'SKIP_WAITING'}); else location.reload(); };
window.addEventListener('online', () => { badge(); flush(); checkUpdates(true); });
window.addEventListener('offline', badge);
document.addEventListener('visibilitychange', () => { if (document.hidden) Store.flush(); if (!document.hidden) { checkUpdates(); flush(); if (swReg) swReg.update().catch(() => {}); } });
async function start() {
  await Store.init();
  S.token = LS.get('token', null); S.data = LS.get('data', null); S.queue = LS.get('queue', []); S.queue.forEach(q => { const o = q.payload && q.payload.override; if (o && typeof o.diskon === 'string' && o.diskon.indexOf('sbov:') === 0) delete q.payload.override; }); /* P1-4/P1-5: token approver (JWT) dari versi lama tidak boleh tetap tersimpan */ S.ch = LS.get('ch', null); S.cart = LS.get('cart', []); S.metode = LS.get('metode', 'tunai'); S.lastSync = LS.get('lastsync', 0) || null; S.hideOut = !!LS.get('hideOut', false);
  if (S.token && S.data) { S.tab = homeTab(); render(); shiftCheck().then(() => { if (S.tab === 'kasir') render(); }); checkUpdates(true); flush(); setTimeout(notifyConflicts, 1200); } else renderLogin(); // transaksi "perlu ditinjau" dari sesi sebelumnya langsung diingatkan
}
window.addEventListener('pagehide', () => Store.flush());
if (window.MutationObserver) new MutationObserver(ms => { if (ms.every(m => { const t = /** @type {any} */ (m.target); return t.closest && t.closest('#grid,#cl,#cartbar,#tot,#addons'); })) return; /* v1.9.9: tap produk tidak lagi memaksa pengukuran tata letak */ cancelAnimationFrame(S.fr); S.fr = requestAnimationFrame(initFades); }).observe(document.getElementById('app'), {childList: true, subtree: true});
if (window.matchMedia) { const mq = matchMedia('(min-width: 768px)'); (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(() => { if (S.token && S.data && $('#sheet').hidden && !S.dirty) render(); }); }
Object.assign(APP.views, {tutup: vTutup, kasir: vKasir, riwayat: vRiwayat, stok: vStok, menu: vMenu, master: vMaster, users: vUsers, settings: vSettings, diag: vDiag});
Object.assign(APP, {can: can, own: own, S: S, api: api, $: $, rp: rp, num: num, esc: esc, LS: LS, T: T, sheet: sheet, closeSheet: closeSheet, toast: toast, busy: busy, busyLabel: busyLabel, skel: skel, ACT: ACT,
  render: render, loadData: loadData, patchRecipe: patchRecipe, patchMaster: patchMaster, checkUpdates: checkUpdates, verSync: verSync, dverKey: dverKey, vload: vload, dnum: dnum, qf: qf, r6: r6, flush: flush, Store: Store, isWide: isWide, skuLevel: skuLevel, wrapChips: wrapChips, isAddon: isAddon, emptyState: emptyState, idDate: idDate, idRange: idRange, addDays: addDays, lvText: lvText, vById: vById, pById: pById, vName: vName, vSub: vSub, chName: chName, fmtDT: fmtDT, today: today, start: start});
})();
