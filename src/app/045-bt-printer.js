/* ---------- Printer Bluetooth: jalur, koneksi tangguh, antrean cetak ----------
   Tiga jalur (pilihan utama disimpan per perangkat di LS 'btmode'):
   - 'rawbt'  : Android + aplikasi RawBT (intent). Printer Bluetooth KLASIK (SPP) maupun BLE, dipasangkan di dalam RawBT. Bawaan di Android.
   - 'ble'    : Web Bluetooth langsung (Chrome Android/desktop, Bluefy di iPhone/iPad). Hanya printer BLE.
   - 'serial' : Web Serial (Chrome/Edge di komputer, Chrome 117+). Printer Bluetooth KLASIK (SPP) yang sudah dipasangkan di sistem operasi.
   Jalur BLE/Serial: status koneksi (idle, connecting, ready, printing, retry, lost), satu antrean cetak (tidak pernah dua penulisan bersamaan),
   batas waktu sambung, sambung ulang otomatis (1s, 2s, 4s, 8s), cetak ulang seluruh pekerjaan dari ESC @ bila gagal di tengah, profil printer
   (id perangkat, layanan, karakteristik, tingkat kecepatan kirim) dan penanda status untuk kasir. */
const BT_SERVICES = ['000018f0-0000-1000-8000-00805f9b34fb', '0000ff00-0000-1000-8000-00805f9b34fb', '49535343-fe7d-4ae5-8fa9-9fafd205e455', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '0000ffe0-0000-1000-8000-00805f9b34fb', '0000fee7-0000-1000-8000-00805f9b34fb', '0000ae30-0000-1000-8000-00805f9b34fb', '0000fff0-0000-1000-8000-00805f9b34fb'];
const BT_LV = [{sz: 100, dl: 25, rp: 2}, {sz: 60, dl: 40, rp: 3}, {sz: 20, dl: 60, rp: 4, resp: true}]; // tingkat kirim BLE: turun otomatis bila tulis gagal (rp = jeda ms per baris raster)
const BT_SER = {sz: 256, dl: 15, rp: 2}, SPP = '00001101-0000-1000-8000-00805f9b34fb';
const BT = {dev: null, chr: null, ser: null, st: 'idle', err: '', fail: null, lvl: 0, drops: 0, ok: 0, okAt: 0, manual: false, ln: null, tm: null, hb: null, wl: null, wlp: false, to: 12000, bo: [1000, 2000, 4000, 8000], q: Promise.resolve(), pend: {}, busy: 0};
const btRun = fn => { BT.busy++; const p = BT.q.then(fn, fn); BT.q = p.then(() => { BT.busy--; }, () => { BT.busy--; }); return p; };
function btErr(code, msg) { const e = /** @type {any} */ (new Error(msg)); e.btcode = code; return e; }
const btHasSerial = () => !!(navigator.serial && navigator.serial.requestPort) && !isAndroid();
const btActive = () => !!(navigator.userActivation && navigator.userActivation.isActive);
function btTimeout(p, what) { return new Promise((res, rej) => { const t = setTimeout(() => rej(btErr('timeout', what + ': waktu habis')), BT.to); p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); }); }); }
function btUuid(s) { s = String(s || '').trim().toLowerCase().replace(/^0x/, ''); if (/^[0-9a-f]{4}$/.test(s)) return '0000' + s + '-0000-1000-8000-00805f9b34fb'; if (/^[0-9a-f]{8}$/.test(s)) return s + '-0000-1000-8000-00805f9b34fb'; return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s) ? s : ''; }
const btServices = () => BT_SERVICES.concat((LS.get('btsvc', []) || []).map(btUuid).filter(x => x && BT_SERVICES.indexOf(x) < 0));

/* ----- jalur ----- */
function btRoutes() { return isAndroid() ? [['rawbt', 'RawBT'], ['ble', 'BLE langsung']] : btHasSerial() ? [['ble', 'BLE langsung'], ['serial', 'Klasik (Serial)']] : [['ble', 'BLE langsung']]; }
function btRoute() {
  let m = LS.get('btmode', null); if (!m) m = LS.get('btdirect', false) ? 'ble' : isAndroid() ? 'rawbt' : 'ble'; // 'btdirect' = pengaturan lama (v2.5.0 ke bawah)
  if (m === 'rawbt' && !isAndroid()) m = 'ble';
  if (m === 'serial' && !btHasSerial()) m = 'ble';
  return m;
}
const btSaved = () => btRoute() === 'serial' ? !!(BT.ser || LS.get('btser', false)) : !!(BT.dev || LS.get('btprof', null) || LS.get('btname', ''));
const btName = () => { const p = LS.get('btprof', null); return btRoute() === 'serial' ? 'printer klasik' : (BT.dev && BT.dev.name) || (p && p.name) || LS.get('btname', '') || ''; };
const btAlive = () => btRoute() === 'serial' ? !!(BT.ser && BT.ser.writable) : !!(BT.dev && BT.dev.gatt && BT.dev.gatt.connected && BT.chr);

/* ----- pesan galat untuk kasir ----- */
function btWhy(e) {
  const c = e && e.btcode, n = e && e.name, m = String((e && e.message) || e || '');
  if (c === 'cancel') return 'Pemilihan printer dibatalkan';
  if (c === 'needpick') return 'Pilih printer lagi: ketuk status printer (izin lama hilang)';
  if (c === 'nowrite') return 'Printer ini belum dikenali. Isi UUID layanan printer di Diagnostik, atau pakai RawBT.';
  if (c === 'nosupport') return m;
  if (c === 'timeout') return 'Printer mati atau jauh (waktu menyambung habis)';
  if (n === 'SecurityError' || n === 'NotAllowedError') return 'Izin Bluetooth ditolak atau hilang. Pilih printer lagi.';
  if (n === 'InvalidStateError' || /already in progress/i.test(m)) return 'Printer masih sibuk. Tunggu sebentar lalu coba lagi.';
  if (n === 'NetworkError' || /GATT|disconnect|no longer in range|connection/i.test(m)) return 'Printer mati, jauh, atau sedang dipakai perangkat lain (mis. RawBT)';
  if (n === 'NotFoundError') return 'Printer tidak ditemukan';
  return m || 'Galat tidak dikenal';
}
const btRetry = e => ['cancel', 'needpick', 'nosupport', 'nowrite'].indexOf(e && e.btcode) < 0 && !/^(Security|NotAllowed)Error$/.test((e && e.name) || '');

/* ----- status + tampilan ----- */
function btSet(st, msg) { BT.st = st; if (msg !== undefined) BT.err = msg; btUi(); }
const btHash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return String(h); };
function btProf(patch) { LS.set('btprof', Object.assign({}, LS.get('btprof', {}), patch)); }
const btKv = (a, b) => '<div class="kv"><span>' + a + '</span><span>' + b + '</span></div>';
function btSeg(withHint) {
  const rs = btRoutes(), rt = btRoute(); let h = '';
  if (rs.length > 1) h += '<div class="seg" role="group" aria-label="Jalur cetak Bluetooth">' + rs.map(r => '<button class="' + (r[0] === rt ? 'on' : '') + '" aria-pressed="' + (r[0] === rt) + '" data-act="btmode" data-m="' + r[0] + '">' + esc(r[1]) + '</button>').join('') + '</div>';
  if (withHint) h += '<p class="muted">' + (rt === 'rawbt' ? 'Printer klasik maupun BLE; dipasangkan di aplikasi RawBT.' : rt === 'serial' ? 'Printer Bluetooth klasik (SPP) yang sudah dipasangkan di komputer. Chrome atau Edge.' : navigator.bluetooth ? 'Hanya printer BLE, tersambung langsung dari browser. ' + (isIOS() ? 'Di iPhone/iPad pakai Bluefy.' : 'Printer klasik: pakai RawBT (Android) atau jalur Klasik di komputer.') : 'Browser ini tidak mendukung Web Bluetooth.' + (isAndroid() ? ' Cetak memakai RawBT.' : isIOS() ? ' Buka aplikasi ini di Bluefy.' : '')) + '</p>';
  return h;
}
function btBadge() {
  if (btRoute() === 'rawbt') return '';
  const s = BT.st, nm = btName(); let cls, txt;
  if (s === 'ready') { cls = 'ok'; txt = 'Tersambung' + (nm ? ' · ' + nm : ''); }
  else if (s === 'printing') { cls = 'wait spin'; txt = 'Mencetak…'; }
  else if (s === 'connecting') { cls = 'wait spin'; txt = 'Menyambung…'; }
  else if (s === 'retry') { cls = 'wait spin'; txt = BT.err || 'Menyambung ulang…'; }
  else if (s === 'lost') { cls = 'warn'; txt = 'Terputus · ketuk untuk sambung'; }
  else if (!btSaved()) { cls = 'off'; txt = 'Belum pilih printer · ketuk'; }
  else { cls = 'off'; txt = 'Siap menyambung · ketuk'; }
  return '<button class="badge ' + cls + '" data-act="btstat">' + esc(txt) + '</button>';
}
function btFailBox() {
  return BT.fail ? '<div class="notice"><span>' + esc('Struk belum tercetak: ' + BT.fail.msg) + '</span><span style="display:flex;gap:6px;flex:none"><button class="chip" data-act="rawbt">Cetak ulang</button>' + (isAndroid() && btRoute() !== 'rawbt' ? '<button class="chip" data-act="btraw">Pakai RawBT</button>' : '') + '</span></div>' : '';
}
function btInfo() {
  const rt = btRoute(), p = LS.get('btprof', null) || {}; if (rt === 'rawbt') return '<p class="muted">Pasangkan dan uji printer di aplikasi RawBT dulu. Pesan galat dari RawBT tidak terbaca oleh aplikasi ini.</p>';
  const L = rt === 'serial' ? BT_SER : (BT_LV[BT.lvl] || BT_LV[0]);
  return btKv('Printer', esc(btName() || '-')) + (rt === 'ble' ? btKv('ID perangkat', esc(String((BT.dev && BT.dev.id) || p.id || '-').slice(0, 14))) + btKv('Layanan', esc(String(p.svc || '-').slice(0, 8))) + btKv('Karakteristik', esc(String(p.chr || '-').slice(0, 8))) : '') +
    btKv('Kecepatan kirim', L.sz + ' B / ' + L.dl + ' ms' + (L.resp ? ' (tunggu balasan)' : '')) + btKv('Putus / sukses', BT.drops + ' / ' + BT.ok) + btKv('Cetak terakhir', BT.okAt ? esc(fmtDT(BT.okAt).slice(5)) : '-') + (BT.err && BT.st !== 'ready' ? '<p class="err">' + esc(BT.err) + '</p>' : '');
}
function btAct() { return btRoute() === 'rawbt' ? '' : '<div class="row2"><button class="btn sec sm" data-act="btpick">Pilih printer</button><button class="btn sec sm" data-act="btconn">Sambung ulang</button></div><div class="row2"><button class="btn sec sm" data-act="btdisc">Putuskan</button><button class="btn sec sm" data-act="btforget">Lupakan printer</button></div>'; }
function btAdv() {
  const rt = btRoute(); if (rt === 'rawbt') return '';
  return (rt === 'ble' ? '<label>UUID layanan khusus (bila printer tidak dikenali)<input class="inp" id="btuuid" autocapitalize="none" placeholder="mis. ff00 atau UUID penuh, pisahkan koma" value="' + esc((LS.get('btsvc', []) || []).join(', ')) + '"></label><button class="btn sec sm" data-act="btuuid">Simpan UUID</button><p class="muted">Setelah menyimpan, pilih printer lagi supaya UUID dikenali.</p>' : '') +
    '<label class="sw sm"><input type="checkbox" data-act="btbeat"' + (LS.get('btbeat', false) ? ' checked' : '') + '><span class="sw-t" aria-hidden="true"></span><span class="sw-l"><b>Jaga koneksi (denyut)</b><small>Kirim sinyal kecil tiap 25 detik di layar Kasir. Uji dulu: efeknya beda tiap merek printer.</small></span></label>' +
    '<label class="sw sm"><input type="checkbox" data-act="btwake"' + (LS.get('btwake', false) ? ' checked' : '') + '><span class="sw-t" aria-hidden="true"></span><span class="sw-l"><b>Layar tetap menyala di Kasir</b><small>Mencegah layar mati memutus koneksi. Baterai lebih boros.</small></span></label>';
}
function btPart(k) {
  const rt = btRoute();
  if (k === 'sw') return btSeg(true);
  if (k === 'st') return btBadge();
  if (k === 'rc') return btSeg(false) + btBadge() + btFailBox();
  if (k === 'bar') return rt !== 'rawbt' && (btSaved() || BT.st !== 'idle' || LS.get('btmode', null) === rt) ? btBadge() : '';
  if (k === 'info') return btInfo();
  if (k === 'act') return btAct();
  if (k === 'adv') return btAdv();
  return '';
}
function btBox(k) { const h = btPart(k); return '<div class="btbox" data-btui="' + k + '" data-h="' + btHash(h) + '">' + h + '</div>'; }
function btUi() { /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('div[data-btui]')).forEach(el => { const h = btPart(el.dataset.btui || ''), k = btHash(h); if (el.dataset.h !== k) { el.innerHTML = h; el.dataset.h = k; } }); }
function btDiagCard() {
  const kv = btKv;
  return '<div class="card-s"><h3>Printer Bluetooth</h3>' + kv('Android (RawBT)', isAndroid() ? 'Ya' : 'Tidak') + kv('iPhone / iPad', isIOS() ? 'Ya' : 'Tidak') + kv('Web Bluetooth (BLE langsung)', navigator.bluetooth ? 'Tersedia' : 'Tidak tersedia') + kv('Web Serial (klasik, komputer)', btHasSerial() ? 'Tersedia' : 'Tidak tersedia') +
    '<p class="muted" style="margin-top:8px"><b>Jalur cetak utama</b></p>' + btBox('sw') + btBox('st') + btBox('info') + btBox('act') + btBox('adv') +
    '<p class="muted">Printer klasik (SPP): Android lewat RawBT, komputer lewat jalur Klasik. iPhone/iPad hanya mendukung printer BLE (Bluefy).</p></div>';
}

/* ----- koneksi ----- */
function btAttach(d) {
  if (BT.dev && BT.dev !== d && BT.dev.removeEventListener) BT.dev.removeEventListener('gattserverdisconnected', btOnDrop);
  if (BT.dev !== d) BT.chr = null;
  BT.dev = d; d.addEventListener('gattserverdisconnected', btOnDrop); // fungsi yang sama didaftarkan berulang tetap hanya satu pendengar
  const p = LS.get('btprof', null);
  if (!p || p.id !== d.id) { LS.set('btprof', {id: d.id, name: d.name || '', lvl: 0}); BT.lvl = 0; } else BT.lvl = p.lvl || 0;
  LS.set('btname', d.name || ''); return d;
}
async function bleDevice(o) {
  const b = navigator.bluetooth; if (!b) throw btErr('nosupport', 'Browser ini tidak mendukung Web Bluetooth');
  if (!o.pick && BT.dev) return BT.dev;
  if (!o.pick && b.getDevices) {
    try {
      const ds = await b.getDevices(), p = LS.get('btprof', null), n = LS.get('btname', ''); let d = null;
      if (p && p.id) d = ds.find(x => x.id === p.id) || null; else if (n) { const m = ds.filter(x => x.name === n); if (m.length === 1) d = m[0]; } // pulihkan lewat ID; nama hanya untuk data lama dan hanya bila tidak ambigu
      if (d) return btAttach(d);
    } catch (e) {}
  }
  if (o.silent || (o.auto && !btActive())) throw btErr('needpick', 'Pilih printer lagi');
  try { return btAttach(await b.requestDevice({acceptAllDevices: true, optionalServices: btServices()})); }
  catch (e) { if (e && e.name === 'NotFoundError') throw btErr('cancel', 'Pemilihan printer dibatalkan'); throw e; }
}
async function bleChar(d) {
  const p = LS.get('btprof', null);
  if (p && p.id === d.id && p.svc && p.chr) { try { const c = await (await d.gatt.getPrimaryService(p.svc)).getCharacteristic(p.chr); if (c.properties.write || c.properties.writeWithoutResponse) return c; } catch (e) {} } // profil tersimpan: tanpa penelusuran
  const rank = s => { const i = BT_SERVICES.indexOf(s.uuid); return i < 0 ? 99 : i; }, svs = (await d.gatt.getPrimaryServices()).sort((a, b) => rank(a) - rank(b));
  for (const sv of svs) { let cs = []; try { cs = await sv.getCharacteristics(); } catch (e) { continue; } const w = cs.find(c => c.properties.writeWithoutResponse) || cs.find(c => c.properties.write); if (w) { btProf({svc: sv.uuid, chr: w.uuid}); return w; } }
  throw btErr('nowrite', 'Printer tidak menyediakan jalur tulis BLE yang dikenali');
}
async function serLink(o) {
  if (!btHasSerial()) throw btErr('nosupport', 'Web Serial tidak tersedia. Pakai Chrome atau Edge di komputer.');
  let p = !o.pick && BT.ser;
  if (!p && !o.pick) { try { p = (await navigator.serial.getPorts())[0] || null; } catch (e) {} }
  if (!p) {
    if (o.silent || (o.auto && !btActive())) throw btErr('needpick', 'Pilih printer lagi');
    try { p = await navigator.serial.requestPort({filters: [{bluetoothServiceClassId: SPP}]}); }
    catch (e) { if (e && e.name === 'NotFoundError') throw btErr('cancel', 'Pemilihan printer dibatalkan'); if (e && e.name === 'TypeError') p = await navigator.serial.requestPort(); else throw e; }
  }
  if (BT.ser !== p) BT.ser = p;
  navigator.serial.addEventListener('disconnect', btSerGone);
  if (!p.writable) { try { await btTimeout(p.open({baudRate: 115200}), 'Membuka port printer'); } catch (e) { if (!e || e.name !== 'InvalidStateError') throw e; } }
  LS.set('btser', true); btSet('ready'); return p;
}
function btSerGone(ev) { if (ev && ev.target === BT.ser) { BT.ser = null; btOnDrop(null); } }
async function btLinkCore(o) {
  try { await btLinkRun(o); } catch (e) { if (BT.st === 'connecting') btSet('idle'); throw e; }
}
async function btLinkRun(o) {
  const rt = btRoute(); if (!o.pick && btAlive()) { if (BT.st !== 'printing') btSet('ready'); return; }
  BT.manual = false; btSet('connecting', '');
  if (rt === 'serial') { await serLink(o); return; }
  const d = await bleDevice(o);
  if (!d.gatt.connected) { BT.chr = null; try { await btTimeout(d.gatt.connect(), 'Menyambung ke printer'); } catch (e) { try { d.gatt.disconnect(); } catch (_) {} throw e; } } // connect() menggantung: bersihkan sebelum coba lagi
  if (!BT.chr) BT.chr = await bleChar(d);
  btSet('ready');
}
async function btLink(o) { // satu proses sambung sekali jalan; pemanggil lain ikut menunggu hasil yang sama
  if (BT.ln && !o.pick) return BT.ln;
  if (BT.ln) { try { await BT.ln; } catch (e) {} }
  BT.ln = btLinkCore(o); const p = BT.ln; const done = () => { if (BT.ln === p) BT.ln = null; }; p.then(done, done); return p;
}
function btOnDrop(ev) {
  if (ev && ev.target && BT.dev && ev.target !== BT.dev) return;
  BT.chr = null; BT.drops++;
  if (BT.st === 'lost') return; // putus susulan setelah gagal: jangan memulai siklus sambung baru
  if (BT.st === 'printing' || BT.st === 'connecting' || BT.st === 'retry') return; // pekerjaan cetak yang berjalan menangani sendiri
  if (BT.manual) return btSet('idle');
  btSet('retry', 'Terputus, menyambung ulang…'); btAuto(0, false);
}
function btAuto(i, now) { // sambung ulang diam-diam; tanpa dialog pilih printer (butuh sentuhan pengguna)
  clearTimeout(BT.tm); if (btRoute() === 'rawbt' || BT.manual || !btSaved()) return;
  if (document.hidden) return btSet('idle');
  BT.tm = setTimeout(async () => {
    if (BT.st === 'ready' || BT.st === 'printing' || BT.ln) return;
    btSet(i ? 'retry' : 'connecting', i ? 'Menyambung ulang (' + (i + 1) + '/' + BT.bo.length + ')…' : '');
    try { await btRun(() => btLink({silent: true})); }
    catch (e) { if (!btRetry(e) || i + 1 >= BT.bo.length) return btSet('lost', btWhy(e)); btSet('retry', 'Menyambung ulang (' + (i + 2) + '/' + BT.bo.length + ')…'); btAuto(i + 1, false); }
  }, now && i === 0 ? 0 : BT.bo[i]);
}

/* ----- pengiriman ----- */
function btRaster(b) { // akhir tiap blok raster GS v 0 -> jumlah barisnya (jeda ekstra supaya buffer printer tidak meluap)
  const m = {}; for (let i = 0; i + 7 < b.length;) { if (b[i] === 0x1D && b[i + 1] === 0x76 && b[i + 2] === 0x30) { const x = b[i + 4] | (b[i + 5] << 8), y = b[i + 6] | (b[i + 7] << 8), e = i + 8 + x * y; m[Math.min(e, b.length)] = y; i = e; } else i++; } return m;
}
function btPut(L) {
  if (btRoute() === 'serial') return async part => { const w = BT.ser.writable.getWriter(); try { await w.write(part); } finally { w.releaseLock(); } };
  const c = BT.chr, pr = c.properties;
  if (L.resp && pr.write) return v => c.writeValueWithResponse ? c.writeValueWithResponse(v) : c.writeValue(v);
  return pr.writeWithoutResponse ? v => c.writeValueWithoutResponse(v) : v => c.writeValue(v);
}
async function btSend(bytes) {
  const L = btRoute() === 'serial' ? BT_SER : (BT_LV[BT.lvl] || BT_LV[0]), put = btPut(L), ends = btRaster(bytes), stops = Object.keys(ends).map(Number).sort((a, b) => a - b), n = bytes.length;
  let i = 0, si = 0;
  try {
    while (i < n) {
      let end = Math.min(i + L.sz, n); while (si < stops.length && stops[si] <= i) si++;
      if (si < stops.length && stops[si] < end) end = stops[si]; // potong tepat di akhir pita raster
      await put(bytes.slice(i, end)); await sleep(L.dl + (ends[end] ? ends[end] * L.rp : 0)); i = end;
    }
  } catch (e) { if (e && !e.btcode) e.btcode = 'write'; throw e; }
}
function btOk() { BT.ok++; BT.okAt = Date.now(); BT.fail = null; btSet('ready', ''); }
async function btJob(bytes, o) { // sambung (bila perlu) lalu kirim; gagal = sambung ulang dan kirim ulang SELURUH struk dari ESC @ (maks. 2 kali)
  let err = null;
  for (let a = 0; a < 3; a++) {
    try { await btLink(o); btSet('printing'); await btSend(bytes); btOk(); return; }
    catch (e) {
      err = e; if (!btRetry(e) || a === 2) break;
      if (e.btcode === 'write' && btAlive() && btRoute() === 'ble' && BT.lvl < BT_LV.length - 1) { BT.lvl++; btProf({lvl: BT.lvl}); } // koneksi hidup tapi tulis gagal: perlambat dan ingat per printer
      else { BT.chr = null; btSet('retry', 'Mencoba lagi (' + (a + 1) + '/2)…'); try { if (BT.dev && BT.dev.gatt.connected) BT.dev.gatt.disconnect(); } catch (_) {} await sleep(600 * (a + 1)); }
      btSet('retry', 'Mencoba lagi (' + (a + 1) + '/2)…');
    }
  }
  BT.fail = {msg: btWhy(err)}; BT.err = BT.fail.msg; btSet(err && (err.btcode === 'cancel' || err.btcode === 'needpick') ? 'idle' : 'lost'); throw err; // pilih-ulang bukan "terputus": badge menawarkan memilih printer
}
function btPrintQ(rc, o) { // semua cetak (otomatis, tombol, uji) masuk satu antrean berurutan
  const key = rc.rid ? String(rc.rid) : '';
  if (key && BT.pend[key]) { toast('Struk ini sedang dalam antrean cetak'); return Promise.resolve(false); }
  if (key) BT.pend[key] = 1;
  const bytes = escpos(rc), auto = !!(o && o.auto);
  toast(BT.busy ? 'Masuk antrean cetak…' : 'Mencetak ke printer…');
  return btRun(() => btJob(bytes, {auto: auto})).then(() => { toast('Struk dikirim ke printer'); return true; }, e => { if (!e || e.btcode !== 'cancel') logErr(e, 'btprint'); toast(e && e.btcode === 'cancel' ? 'Pemilihan printer dibatalkan' : 'Gagal mencetak: ' + btWhy(e)); return false; }).then(r => { if (key) delete BT.pend[key]; return r; });
}
const btRawbt = rc => { btRelease(); return go('intent:base64,' + b64(escpos(rc)) + '#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;'); };
function btRelease() { clearTimeout(BT.tm); BT.manual = true; try { if (BT.dev && BT.dev.gatt && BT.dev.gatt.connected) BT.dev.gatt.disconnect(); } catch (e) {} BT.chr = null; if (BT.st !== 'printing') BT.st = 'idle'; } // satu printer BLE hanya melayani satu perangkat: lepaskan agar RawBT bisa menyambung
async function printBT(rc, o) {
  if (!rc) return toast('Tidak ada struk untuk dicetak');
  const rt = btRoute();
  if (rt === 'rawbt') return btRawbt(rc);
  if (rt === 'ble' && !navigator.bluetooth) {
    if (isAndroid()) return btRawbt(rc);
    if (isIOS()) return iosHelp();
    toast('Bluetooth tidak tersedia di browser ini. Memakai cetak browser.'); return printBrowser();
  }
  await btPrintQ(rc, o);
}
function iosHelp() {
  sheet('<div class="grab"></div><h2>Cetak dari iPhone</h2><p class="muted">Safari dan Chrome di iPhone tidak bisa mengirim data ke printer Bluetooth. Pilihan yang bisa dipakai:</p>' +
    '<div class="li" style="display:block"><b>1. Browser dengan Web Bluetooth</b><div class="muted">Pasang browser seperti Bluefy, buka alamat aplikasi ini di sana, lalu tekan Cetak Bluetooth. Printer harus tipe <b>BLE</b>; printer Bluetooth klasik (kebanyakan printer murah) tidak dikenali iPhone.</div><button class="btn sec sm" data-act="copyurl">Salin alamat aplikasi</button></div>' +
    '<div class="li" style="display:block"><b>2. AirPrint atau PDF</b><div class="muted">Tombol Cetak memakai menu cetak iOS (printer AirPrint, atau simpan sebagai PDF).</div><button class="btn sec sm" data-act="print">Cetak</button></div>' +
    '<div class="li" style="display:block"><b>3. Bagikan struk</b><div class="muted">Kirim ke WhatsApp atau aplikasi printer lain lewat menu bagikan iOS.</div><button class="btn sec sm" data-act="share">Bagikan…</button></div>' +
    '<div class="li" style="display:block"><b>4. Android + RawBT</b><div class="muted">Untuk printer Bluetooth klasik, gunakan HP Android dengan aplikasi RawBT.</div></div><button class="btn pri" data-act="close">Mengerti</button>');
}

/* ----- aksi kasir (dipanggil dari ACT) ----- */
async function btDisconnect() { clearTimeout(BT.tm); BT.manual = true; try { if (BT.dev && BT.dev.gatt && BT.dev.gatt.connected) BT.dev.gatt.disconnect(); } catch (e) {} BT.chr = null; if (BT.ser) { try { await BT.ser.close(); } catch (e) {} } btSet('idle', ''); }
async function btSetMode(m) {
  if (!btRoutes().some(r => r[0] === m)) return;
  if (BT.st === 'printing') return toast('Tunggu cetakan selesai dulu');
  LS.set('btmode', m); BT.fail = null; BT.err = '';
  if (m === 'rawbt') await btDisconnect(); else { BT.manual = false; btSet('idle', ''); }
  btUi(); btTick();
  const f = /** @type {HTMLElement|null} */ (document.querySelector('[data-btui] [data-m="' + m + '"]')); if (f) f.focus({preventScroll: true});
  toast(m === 'rawbt' ? 'Jalur utama: RawBT' : m === 'serial' ? 'Jalur utama: Bluetooth klasik (Serial)' : 'Jalur utama: BLE langsung');
}
async function btConnUser(pick) {
  if (BT.st === 'printing') return toast('Tunggu cetakan selesai dulu');
  if (btRoute() === 'rawbt') return toast('Jalur utama RawBT: pasangkan printer di aplikasi RawBT');
  try { if (pick) await btDisconnect(); await btRun(() => btLink({pick: !!pick})); toast((pick ? 'Printer dipilih: ' : 'Printer tersambung: ') + (btName() || 'tanpa nama')); }
  catch (e) { btSet(e && e.btcode === 'cancel' ? 'idle' : 'lost', btWhy(e)); if (!e || e.btcode !== 'cancel') logErr(e, 'btconn'); toast(btWhy(e)); }
}
function btStat() { const s = BT.st; if (s === 'ready') return toast('Printer tersambung: ' + (btName() || 'tanpa nama')); if (s === 'connecting' || s === 'printing' || s === 'retry') return toast('Sedang diproses, mohon tunggu'); return btConnUser(!btSaved()); }
async function btForget() {
  await btDisconnect();
  try { if (BT.dev && BT.dev.forget) await BT.dev.forget(); } catch (e) {} try { if (BT.ser && BT.ser.forget) await BT.ser.forget(); } catch (e) {}
  BT.dev = null; BT.ser = null; BT.lvl = 0; BT.fail = null; BT.err = ''; LS.del('btprof'); LS.del('btname'); LS.del('btser'); btSet('idle', ''); toast('Printer dilupakan');
}
function btUuidSave() {
  const el = /** @type {HTMLInputElement|null} */ (document.getElementById('btuuid')); if (!el) return;
  const raw = el.value.split(/[,\s]+/).filter(Boolean), ok = raw.map(btUuid);
  if (ok.some(x => !x)) return toast('UUID tidak valid. Contoh: ff00 atau 0000ff00-0000-1000-8000-00805f9b34fb');
  LS.set('btsvc', ok); toast(ok.length ? 'UUID tersimpan. Pilih printer lagi agar dikenali.' : 'UUID khusus dihapus');
}
function btOpt(k, on) { LS.set(k, !!on); btTick(); toast(on ? 'Diaktifkan' : 'Dimatikan'); }

/* ----- menjaga koneksi (dipanggil dari render(), kembali ke aplikasi, dan opsi) ----- */
function btPing() { if (BT.st !== 'ready' || document.hidden || BT.busy) return; btRun(async () => { if (BT.st !== 'ready') return; try { await btSend(new Uint8Array([0x1B, 0x40])); } catch (e) { btOnDrop(null); } }); }
function btBeatSet() { const on = !!LS.get('btbeat', false) && btRoute() !== 'rawbt' && S.tab === 'kasir'; if (on && !BT.hb) BT.hb = setInterval(btPing, 25000); else if (!on && BT.hb) { clearInterval(BT.hb); BT.hb = null; } }
async function btWakeSet() {
  const on = !!LS.get('btwake', false) && btRoute() !== 'rawbt' && S.tab === 'kasir' && !document.hidden && !!navigator.wakeLock;
  if (on && !BT.wl && !BT.wlp) { BT.wlp = true; try { BT.wl = await navigator.wakeLock.request('screen'); BT.wl.addEventListener('release', () => { BT.wl = null; }); } catch (e) {} BT.wlp = false; }
  else if (!on && BT.wl) { try { await BT.wl.release(); } catch (e) {} BT.wl = null; }
}
function btTick() {
  btBeatSet(); btWakeSet();
  if (S.tab === 'kasir' && btRoute() !== 'rawbt' && BT.st === 'idle' && !BT.manual && btSaved() && !document.hidden) btAuto(0, true); // sambung di muka: cetak pertama tidak menunggu
}
function btWake() { // aplikasi terlihat lagi (mis. kembali dari WhatsApp)
  if (btRoute() === 'rawbt') return;
  if (BT.st === 'ready' && !btAlive()) btOnDrop(null); else if (BT.st === 'lost') btSet('idle');
  btTick();
}
