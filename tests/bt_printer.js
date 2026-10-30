// Uji lapisan cetak Bluetooth (src/app/045-bt-printer.js) dengan perangkat Bluetooth/Serial tiruan: tanpa perangkat keras, tanpa jaringan.
const fs = require('fs'), vm = require('vm'), path = require('path');
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('GAGAL: ' + m); } };
const SRC = fs.readFileSync(path.join(__dirname, '../src/app/045-bt-printer.js'), 'utf8');
const RASTER = [0x1D, 0x76, 0x30, 0, 2, 0, 3, 0, 1, 2, 3, 4, 5, 6]; // 2 byte x 3 baris
function mk(o) {
  o = o || {}; const store = {}, log = {toast: [], err: []}, listeners = [];
  const mkChr = (w, nm) => ({uuid: 'chr-' + nm, properties: w, service: null, _w: [], async writeValueWithoutResponse(v) { await this._h(v); }, async writeValueWithResponse(v) { await this._h(v); }, async writeValue(v) { await this._h(v); },
    async _h(v) { dev.cc++; dev.max = Math.max(dev.max, dev.cc); await Promise.resolve(); try { if (dev.failAt && dev.writes.length + 1 === dev.failAt.n) { dev.failAt = null; if (dev.failDrop) dev.gatt.drop(); const e = new Error('GATT Error: write failed'); e.name = 'NetworkError'; throw e; } dev.writes.push(Array.from(v)); } finally { dev.cc--; } }});
  const mkDev = (id, name, svcs) => { const ls = [], d = {id, name, writes: [], cc: 0, max: 0, connects: 0, hang: 0, failAt: null, failDrop: false,
    addEventListener(t, f) { if (ls.indexOf(f) < 0) ls.push(f); }, removeEventListener(t, f) { const i = ls.indexOf(f); if (i >= 0) ls.splice(i, 1); }, nls: () => ls.length, forgot: false, async forget() { d.forgot = true; },
    gatt: {connected: false, connect() { d.connects++; if (d.hang > 0) { d.hang--; return new Promise(() => {}); } d.gatt.connected = true; return Promise.resolve(d.gatt); }, disconnect() { if (d.gatt.connected) { d.gatt.connected = false; setTimeout(() => ls.slice().forEach(f => f({target: d})), 0); } }, drop() { d.gatt.connected = false; ls.slice().forEach(f => f({target: d})); },
      async getPrimaryServices() { return svcs; }, async getPrimaryService(u) { const s = svcs.find(x => x.uuid === u); if (!s) throw new Error('no svc'); return s; }}};
    svcs.forEach(s => s.chars.forEach(c => { c.service = s; c._h = c._h; })); return d; };
  const chr1 = mkChr({writeWithoutResponse: true, write: true}, 'a'), svc1 = {uuid: '0000ff00-0000-1000-8000-00805f9b34fb', chars: [chr1], async getCharacteristics() { return this.chars; }, async getCharacteristic(u) { const c = this.chars.find(x => x.uuid === u); if (!c) throw new Error('no chr'); return c; }};
  chr1._h = function (v) { return Object.getPrototypeOf(chr1)._h ? 0 : 0; };
  const dev = mkDev(o.id || 'dev-1', o.name || 'PRN-A', o.svcs || [svc1]);
  // tiap karakteristik menulis lewat dev (agar penghitung dan penyuntikan galat berlaku)
  dev.gatt.getPrimaryServices = async () => (o.svcs || [svc1]);
  (o.svcs || [svc1]).forEach(s => s.chars.forEach(c => { c._h = async v => { dev.cc++; dev.max = Math.max(dev.max, dev.cc); await Promise.resolve(); try { if (dev.failAt && dev.writes.length + 1 === dev.failAt.n) { dev.failAt = null; if (dev.failDrop) dev.gatt.drop(); const e = new Error('GATT Error: write failed'); e.name = 'NetworkError'; throw e; } dev.writes.push(Array.from(v)); } finally { dev.cc--; } }; c.writeValueWithoutResponse = c.writeValueWithResponse = c.writeValue = v => c._h(v); }));
  const nav = {userAgent: o.ua || 'Mozilla/5.0 (Linux; Android 13) Chrome', platform: 'Linux armv8', maxTouchPoints: 5, userActivation: {isActive: o.active !== false},
    bluetooth: o.noBle ? undefined : {reqs: 0, async requestDevice() { nav.bluetooth.reqs++; if (o.cancel) { const e = new Error('cancel'); e.name = 'NotFoundError'; throw e; } return dev; }, async getDevices() { return o.noGet ? [] : (o.devices || [dev]); }}};
  if (o.noGet) delete nav.bluetooth.getDevices;
  const ctx = {navigator: nav, document: {hidden: false, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null}, S: {tab: 'kasir', rc: null}, setTimeout, clearTimeout, setInterval, clearInterval, Date, Object, Promise, Error, Array, String, Number, Math, JSON, Uint8Array,
    LS: {get: (k, d) => k in store ? store[k] : d, set: (k, v) => { store[k] = v; }, del: k => { delete store[k]; }}, toast: m => log.toast.push(m), logErr: e => log.err.push(e), sleep: () => Promise.resolve(), esc: s => String(s), fmtDT: () => '2026-10-30 10:00',
    isAndroid: () => /Android/.test(nav.userAgent), isIOS: () => /iPhone|iPad/.test(nav.userAgent), escpos: rc => new Uint8Array([0x1B, 0x40].concat(rc.big ? new Array(250).fill(65) : [66, 10], RASTER, [10, 0x1B, 0x64, 4])), go: u => { log.go = u; }, b64: u => 'B64', printBrowser: () => { log.browser = 1; }, sheet: () => { log.sheet = 1; }, Window: null};
  if (o.serial) ctx.navigator.serial = o.serial;
  vm.createContext(ctx); vm.runInContext(SRC, ctx); vm.runInContext('BT.to = 40; BT.bo = [5, 5, 5, 5];', ctx);
  ctx.__x = vm.runInContext('({BT, btRoute, btRoutes, printBT, btPrintQ, btRaster, btSetMode, btConnUser, btForget, btWhy, btPart, btUuid, btServices})', ctx);
  return {ctx, x: ctx.__x, dev, nav, store, log, chr: chr1};
}
const wait = ms => new Promise(r => setTimeout(r, ms)), flat = w => [].concat(...w), rc = (rid, big) => ({rid, big});
(async () => {
  // jalur & bawaan
  let t = mk(); ok(t.x.btRoute() === 'rawbt', 'Android: bawaan RawBT'); ok(t.x.btRoutes().length === 2, 'Android: dua pilihan (RawBT, BLE)');
  await t.x.printBT(rc('a')); ok(/^intent:base64,B64#Intent;scheme=rawbt/.test(t.log.go), 'RawBT memakai intent lama'); ok(t.dev.writes.length === 0, 'RawBT tidak menulis lewat BLE');
  t = mk(); t.store.btdirect = true; ok(t.x.btRoute() === 'ble', 'pengaturan lama btdirect => BLE');
  t = mk(); await t.x.btSetMode('ble'); ok(t.x.btRoute() === 'ble' && t.store.btmode === 'ble', 'ganti jalur ke BLE tersimpan'); await t.x.btSetMode('rawbt'); ok(t.x.btRoute() === 'rawbt', 'kembali ke RawBT');
  t = mk({ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome'}); ok(t.x.btRoute() === 'ble' && t.x.btRoutes().length === 1, 'desktop tanpa Serial: hanya BLE'); t.store.btmode = 'rawbt'; ok(t.x.btRoute() === 'ble', 'RawBT tidak berlaku di non-Android');
  t = mk({ua: 'Mozilla/5.0 (iPhone) Safari', noBle: true}); await t.x.printBT(rc('i')); ok(t.log.sheet === 1, 'iPhone tanpa Web Bluetooth => panduan');
  t = mk({noBle: true}); t.store.btmode = 'ble'; await t.x.printBT(rc('n')); ok(/^intent:/.test(t.log.go || ''), 'Android BLE tanpa Web Bluetooth => RawBT');

  // cetak BLE normal
  t = mk(); t.store.btmode = 'ble'; await t.x.printBT(rc('r1')); let w = flat(t.dev.writes);
  ok(w[0] === 0x1B && w[1] === 0x40 && w.length === 2 + 2 + RASTER.length + 4, 'seluruh byte terkirim berurutan dari ESC @');
  ok(t.x.BT.st === 'ready' && t.dev.connects === 1, 'status siap, satu kali menyambung'); ok(t.store.btprof && t.store.btprof.id === 'dev-1' && t.store.btprof.svc && t.store.btprof.chr, 'profil printer (id, layanan, karakteristik) tersimpan');
  ok(t.dev.nls() === 1, 'satu pendengar putus'); await t.x.btPrintQ(rc('r2')); ok(t.dev.connects === 1 && t.dev.nls() === 1, 'cetak kedua memakai koneksi yang ada, pendengar tidak dobel');
  // potongan di akhir pita raster
  const m = t.x.btRaster(new Uint8Array([0x1B, 0x40].concat(RASTER, [10]))); ok(Object.keys(m).length === 1 && m[2 + RASTER.length] === 3, 'peta raster: akhir blok => jumlah baris');
  // dua cetak bersamaan
  t = mk(); t.store.btmode = 'ble'; await Promise.all([t.x.btPrintQ(rc('p1', true)), t.x.btPrintQ(rc('p2', true))]); ok(t.dev.max === 1, 'tidak pernah dua penulisan bersamaan (maks ' + t.dev.max + ')');
  w = t.dev.writes; ok(w.filter(c => c[0] === 0x1B && c[1] === 0x40).length >= 2, 'dua struk utuh tercetak berurutan');
  // dobel rid
  t = mk(); t.store.btmode = 'ble'; const [a1, a2] = await Promise.all([t.x.btPrintQ(rc('same')), t.x.btPrintQ(rc('same'))]); ok(a1 === true && a2 === false, 'struk yang sama tidak masuk antrean dua kali');
  // connect menggantung
  t = mk(); t.store.btmode = 'ble'; t.dev.hang = 1; const okh = await t.x.btPrintQ(rc('h')); ok(okh === true && t.dev.connects === 2, 'connect menggantung => batas waktu, coba lagi, berhasil'); 
  t = mk(); t.store.btmode = 'ble'; t.dev.hang = 9; const nok = await t.x.btPrintQ(rc('h2')); ok(nok === false && t.x.BT.st === 'lost' && /mati atau jauh/.test(t.x.BT.fail.msg), 'printer mati => gagal jelas, status terputus, ada pesan');
  t = mk(); t.store.btmode = 'ble'; t.dev.hang = 99; await t.x.btPrintQ(rc('z0')); const c0 = t.dev.connects; ok(t.x.BT.st === 'lost', 'dasar: gagal => lost'); t.dev.gatt.drop(); await wait(80); ok(t.x.BT.st === 'lost' && t.dev.connects === c0, 'putus susulan saat status terputus tidak memulai siklus sambung baru');
  // putus di tengah => sambung ulang dan kirim ulang dari awal
  t = mk(); t.store.btmode = 'ble'; await t.x.btPrintQ(rc('w0')); t.dev.writes.length = 0; t.dev.failAt = {n: 2}; t.dev.failDrop = true; const okd = await t.x.btPrintQ(rc('w1', true));
  ok(okd === true && t.dev.connects === 2, 'putus di tengah => sambung ulang'); const starts = t.dev.writes.filter(c => c[0] === 0x1B && c[1] === 0x40).length; ok(starts === 2, 'seluruh struk dikirim ulang dari ESC @ (' + starts + ')');
  // tulis gagal tapi koneksi hidup => turun tingkat dan diingat
  t = mk(); t.store.btmode = 'ble'; t.dev.failAt = {n: 1}; ok(await t.x.btPrintQ(rc('d1')) === true && t.x.BT.lvl === 1 && t.store.btprof.lvl === 1, 'tulis gagal => potongan lebih kecil dan diingat per printer');
  // dikenali dari getDevices lewat ID, bukan nama
  t = mk({id: 'id-B', name: 'SAMA'}); t.store.btmode = 'ble'; t.store.btprof = {id: 'id-B', name: 'SAMA'}; t.store.btname = 'SAMA';
  const other = Object.assign({}, t.dev, {id: 'id-A', name: 'SAMA', writes: []}); t.nav.bluetooth.getDevices = async () => [other, t.dev]; await t.x.btPrintQ(rc('s1')); ok(t.nav.bluetooth.reqs === 0 && t.dev.writes.length > 0 && other.writes.length === 0, 'printer tersimpan dipulihkan lewat ID walau nama sama');
  // tanpa gestur dan tanpa printer tersimpan => tidak memunculkan dialog
  t = mk({noGet: true, active: false}); t.store.btmode = 'ble'; const na = await t.x.btPrintQ(rc('g1'), {auto: true}); ok(na === false && t.nav.bluetooth.reqs === 0 && /Pilih printer/.test(t.x.BT.fail.msg), 'cetak otomatis tanpa gestur: pesan jelas, tanpa dialog');
  t = mk({noGet: true, active: true}); t.store.btmode = 'ble'; ok(await t.x.btPrintQ(rc('g2'), {auto: true}) === true && t.nav.bluetooth.reqs === 1, 'cetak otomatis dengan gestur aktif boleh memilih printer');
  t = mk({cancel: true}); t.store.btmode = 'ble'; ok(await t.x.btPrintQ(rc('c1')) === false && t.x.BT.st === 'idle' && t.log.err.length === 0, 'dialog dibatalkan: bukan galat, status idle');
  // UUID tak dikenal
  const bad = {uuid: '0000aaaa-0000-1000-8000-00805f9b34fb', chars: [], async getCharacteristics() { return []; }}; t = mk({svcs: [bad]}); t.store.btmode = 'ble'; ok(await t.x.btPrintQ(rc('u1')) === false && /belum dikenali/.test(t.x.BT.fail.msg) && t.dev.connects === 1, 'layanan tak dikenal: pesan UUID, tidak diulang-ulang');
  ok(t.x.btUuid('ff00') === '0000ff00-0000-1000-8000-00805f9b34fb' && t.x.btUuid('0xFFE0') === '0000ffe0-0000-1000-8000-00805f9b34fb' && t.x.btUuid('zz') === '', 'normalisasi UUID');
  t.store.btsvc = ['0000aaaa-0000-1000-8000-00805f9b34fb']; ok(t.x.btServices().indexOf('0000aaaa-0000-1000-8000-00805f9b34fb') >= 0 && t.x.btServices().length === 9, 'UUID khusus ikut daftar layanan');
  // drop saat idle => sambung ulang otomatis
  t = mk(); t.store.btmode = 'ble'; await t.x.btPrintQ(rc('k1')); t.dev.gatt.drop(); ok(t.x.BT.st === 'retry', 'putus saat idle => menyambung ulang'); await wait(60); ok(t.x.BT.st === 'ready' && t.dev.gatt.connected, 'tersambung kembali otomatis');
  t = mk(); t.store.btmode = 'ble'; await t.x.btPrintQ(rc('k2')); t.dev.hang = 9; t.dev.gatt.drop(); await wait(600); ok(t.x.BT.st === 'lost', 'gagal terus => terputus setelah 4 percobaan (' + t.dev.connects + ' kali)');
  // pindah ke RawBT melepas BLE
  t = mk(); t.store.btmode = 'ble'; await t.x.btPrintQ(rc('m1')); await t.x.btSetMode('rawbt'); await wait(10); ok(!t.dev.gatt.connected, 'ganti ke RawBT melepas sambungan BLE (printer bebas untuk RawBT)');
  await t.x.btForget(); ok(!t.store.btprof && t.dev.forgot, 'lupakan printer menghapus profil');
  // Serial (klasik, komputer)
  const sw = []; const port = {writable: null, async open() { port.writable = {getWriter: () => ({write: async v => { sw.push(Array.from(v)); }, releaseLock() {}})}; }, async close() { port.writable = null; }};
  t = mk({ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome', serial: {requestPort: async () => port, getPorts: async () => [], addEventListener() {}}}); ok(t.x.btRoutes().length === 2, 'desktop dengan Web Serial: pilihan Klasik (Serial)');
  await t.x.btSetMode('serial'); ok(await t.x.btPrintQ(rc('s2')) === true && flat(sw).length > 0 && flat(sw)[0] === 0x1B, 'jalur Serial menulis struk ke port');
  // tampilan
  t = mk(); t.store.btmode = 'ble'; ok(/Belum pilih printer/.test(t.x.btPart('st')), 'badge: belum pilih printer'); await t.x.btPrintQ(rc('v1')); ok(/Tersambung · PRN-A/.test(t.x.btPart('st')), 'badge: tersambung + nama');
  t = mk(); ok(t.x.btPart('bar') === '' && /RawBT/.test(t.x.btPart('sw')), 'RawBT: tanpa badge status, seg tersedia');
  console.log(fail ? 'GAGAL: ' + fail + ' dari ' + (pass + fail) : 'Semua lulus (' + pass + ' pemeriksaan)'); process.exit(fail ? 1 : 0);
})();
