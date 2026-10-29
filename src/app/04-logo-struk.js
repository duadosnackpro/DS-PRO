/* ---------- Logo struk: bitmap 1-bit untuk printer thermal ----------
   Disimpan di pengaturan `logo_data` sebagai "L1;<lebar>x<tinggi>;<t|h>;<base64>" (1 = titik hitam, MSB dahulu, per baris).
   t = hitam-putih tegas (ambang), h = halftone (Floyd-Steinberg). Dicetak dengan perintah raster ESC/POS `GS v 0`.
   Ukuran logo sudah final saat disimpan (persen dari lebar kertas); bila kertas diganti jadi lebih sempit, logo dikecilkan saat cetak. */
const LOGO_MAX_H = 256, LOGO_BAND = 64, LOGO_RE = /^L1;(\d{1,3})x(\d{1,3});([th]);([A-Za-z0-9+\/]+={0,2})$/;
const paperDots = () => rcWidth() === 48 ? 576 : 384; // 203 dpi = 8 titik per mm (58 mm: 384 titik, 80 mm: 576 titik)
const cfgOn = (k, def) => { const v = cfg(k); return v == null || v === '' ? !!def : T(v); };
function logoPack(mono, w, h) { // mono: Uint8Array w*h (1 = hitam) -> byte per baris, bit tertinggi = titik paling kiri
  const bpr = w >> 3, out = new Uint8Array(bpr * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mono[y * w + x]) out[y * bpr + (x >> 3)] |= 0x80 >> (x & 7);
  return out;
}
const logoEncode = lg => 'L1;' + lg.w + 'x' + lg.h + ';' + lg.mode + ';' + b64(lg.bytes);
function logoDecode(str) {
  const m = LOGO_RE.exec(String(str || '')); if (!m) return null;
  const w = +m[1], h = +m[2]; if (w < 8 || w % 8 || w > 576 || h < 1 || h > LOGO_MAX_H) return null;
  let bin; try { bin = atob(m[4]); } catch (e) { return null; }
  if (bin.length !== (w >> 3) * h) return null;
  const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return {w: w, h: h, mode: m[3], bytes: bytes};
}
const LGC = {s: null, v: null, url: null}; // logo tersimpan (didekode sekali per perubahan data)
function logoGet() { const s = String(cfg('logo_data') || ''); if (s !== LGC.s) { LGC.s = s; LGC.v = logoDecode(s); LGC.url = null; } return LGC.v; }
const logoOn = () => cfgOn('logo_aktif', false) ? logoGet() : null;
const toGray = (rgba, n) => { const g = new Uint8Array(n); for (let i = 0; i < n; i++) g[i] = (rgba[4 * i] * 77 + rgba[4 * i + 1] * 150 + rgba[4 * i + 2] * 29) >> 8; return g; };
function otsu(g) { // ambang otomatis yang memisahkan latar dan gambar; titik dengan nilai < hasil dicetak hitam
  const hst = new Array(256).fill(0), n = g.length; for (let i = 0; i < n; i++) hst[g[i]]++;
  let sum = 0, sb = 0, wb = 0, best = -1, thr = 128; for (let i = 0; i < 256; i++) sum += i * hst[i];
  for (let t = 0; t < 256; t++) { wb += hst[t]; if (!wb) continue; const wf = n - wb; if (!wf) break; sb += t * hst[t]; const mb = sb / wb, mf = (sum - sb) / wf, v = wb * wf * (mb - mf) * (mb - mf); if (v > best) { best = v; thr = t + 1; } }
  return thr;
}
const monoThreshold = (g, thr) => { const m = new Uint8Array(g.length); for (let i = 0; i < g.length; i++) m[i] = g[i] < thr ? 1 : 0; return m; };
function monoDither(g, w, h, bias) { // Floyd-Steinberg; bias > 0 = lebih terang. Lewat kurva gamma: putih murni tetap putih, hitam murni tetap hitam (tanpa titik liar di latar)
  const lut = new Float32Array(256), gm = Math.pow(2, -bias / 64); for (let i = 0; i < 256; i++) lut[i] = 255 * Math.pow(i / 255, gm);
  const f = new Float32Array(w * h), m = new Uint8Array(w * h); for (let i = 0; i < f.length; i++) f[i] = lut[g[i]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, o = f[i], nv = o < 128 ? 0 : 255, er = o - nv; m[i] = nv === 0 ? 1 : 0;
    if (x + 1 < w) f[i + 1] += er * 7 / 16;
    if (y + 1 < h) { if (x > 0) f[i + w - 1] += er * 3 / 16; f[i + w] += er * 5 / 16; if (x + 1 < w) f[i + w + 1] += er / 16; }
  }
  return m;
}
function isColorImg(rgba, n) { // berwarna bila >4% titik bukan-putih punya selisih kanal RGB yang jelas
  let ink = 0, col = 0;
  for (let i = 0; i < n; i++) { const r = rgba[4 * i], g = rgba[4 * i + 1], b = rgba[4 * i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mn > 235) continue; ink++; if (mx - mn > 48) col++; }
  return ink > 0 && col / ink > 0.04;
}
function logoFit(lg, maxW) { // kecilkan logo bila lebih lebar dari kertas (rata-rata area lalu dibuat 1-bit lagi)
  if (lg.w <= maxW) return lg;
  const w = maxW & ~7, h = Math.max(1, Math.round(lg.h * w / lg.w)), g = new Uint8Array(w * h), sx = lg.w / w, sy = lg.h / h, bpr = lg.w >> 3;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x * sx), x1 = Math.min(lg.w, Math.max(x0 + 1, Math.ceil((x + 1) * sx))), y0 = Math.floor(y * sy), y1 = Math.min(lg.h, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
    let on = 0; for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) if (lg.bytes[yy * bpr + (xx >> 3)] & (0x80 >> (xx & 7))) on++;
    g[y * w + x] = Math.round(255 * (1 - on / ((x1 - x0) * (y1 - y0))));
  }
  return {w: w, h: h, mode: lg.mode, bytes: logoPack(lg.mode === 'h' ? monoDither(g, w, h, 0) : monoThreshold(g, 128), w, h)};
}
function logoRaster(lg) { // GS v 0 per pita LOGO_BAND baris: printer murah dengan buffer kecil tidak kebanjiran
  const bpr = lg.w >> 3, out = [];
  for (let y = 0; y < lg.h; y += LOGO_BAND) {
    const n = Math.min(LOGO_BAND, lg.h - y); out.push(0x1D, 0x76, 0x30, 0, bpr & 255, bpr >> 8, n & 255, n >> 8);
    for (let i = y * bpr; i < (y + n) * bpr; i++) out.push(lg.bytes[i]);
  }
  return out;
}
function logoPaint(cv, lg) { // gambar bitmap 1-bit ke kanvas (pratinjau, struk di layar)
  cv.width = lg.w; cv.height = lg.h; const cx = cv.getContext('2d'), im = cx.createImageData(lg.w, lg.h), bpr = lg.w >> 3;
  for (let y = 0; y < lg.h; y++) for (let x = 0; x < lg.w; x++) { const i = (y * lg.w + x) * 4, v = lg.bytes[y * bpr + (x >> 3)] & (0x80 >> (x & 7)) ? 0 : 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; }
  cx.putImageData(im, 0, 0);
}
function logoURL(lg) {
  if (!lg) return ''; if (lg === LGC.v && LGC.url != null) return LGC.url;
  let u = ''; try { const cv = document.createElement('canvas'); logoPaint(cv, lg); u = cv.toDataURL('image/png'); } catch (e) { logErr(e, 'logo'); }
  if (lg === LGC.v) LGC.url = u; return u;
}
const logoPct = lg => Math.min(100, lg.w / paperDots() * 100).toFixed(1) + '%';

/* editor: pilih gambar -> pratinjau langsung -> simpan */
let LGE = null;
const loadImg = f => new Promise((ok, no) => { const u = URL.createObjectURL(f), im = new Image(); im.onload = () => { URL.revokeObjectURL(u); ok(im); }; im.onerror = () => { URL.revokeObjectURL(u); no(new Error('gambar')); }; im.src = u; });
function logoDraw(src, sw, sh, w, h) { // skala bertahap (maks. 2x per langkah) agar gambar besar tetap halus; latar transparan menjadi putih
  const mk = (a, b) => { const c = document.createElement('canvas'); c.width = a; c.height = b; const x = c.getContext('2d', {willReadFrequently: true}); x.fillStyle = '#fff'; x.fillRect(0, 0, a, b); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; return [c, x]; };
  let cur = src, cw = sw, ch = sh;
  while (cw > w * 2 || ch > h * 2) { const nw = Math.max(w, Math.ceil(cw / 2)), nh = Math.max(h, Math.ceil(ch / 2)), p = mk(nw, nh); p[1].drawImage(cur, 0, 0, nw, nh); cur = p[0]; cw = nw; ch = nh; }
  const p = mk(w, h); p[1].drawImage(cur, 0, 0, w, h); return p[0];
}
function logoSize(e) { // lebar final (kelipatan 8) dari persen lebar kertas; tinggi dibatasi LOGO_MAX_H
  let w = Math.max(8, Math.round(paperDots() * e.pct / 100 / 8) * 8), h = Math.max(1, Math.round(w * e.sh / e.sw));
  if (h > LOGO_MAX_H) { w = Math.max(8, Math.floor(LOGO_MAX_H * e.sw / e.sh / 8) * 8); h = Math.min(LOGO_MAX_H, Math.max(1, Math.round(w * e.sh / e.sw))); }
  return {w: w, h: h};
}
function logoCompute(e, rgba, w, h) { // rgba: piksel gambar pada ukuran final -> bitmap 1-bit sesuai pilihan
  let g = toGray(rgba, w * h); if (e.inv) g = g.map(v => 255 - v);
  const bw = !e.color || e.bw; // gambar tidak berwarna selalu hitam-putih tegas
  return {w: w, h: h, mode: bw ? 't' : 'h', bytes: logoPack(bw ? monoThreshold(g, e.thr) : monoDither(g, w, h, 128 - e.thr + 20), w, h)}; // +20: titik thermal melebar, halftone dibuat sedikit lebih terang
}
function logoRender() {
  const e = LGE, pv = $('#lg_cv'); if (!e || !pv) return;
  const d = logoSize(e), cv = logoDraw(e.src, e.sw, e.sh, d.w, d.h);
  e.out = logoCompute(e, cv.getContext('2d').getImageData(0, 0, d.w, d.h).data, d.w, d.h);
  logoPaint(pv, e.out); pv.style.width = logoPct(e.out);
  const inf = $('#lg_info'); if (inf) inf.textContent = d.w + ' × ' + d.h + ' titik · lebar ± ' + (d.w / 8) + ' mm · ' + (e.out.bytes.length / 1024).toFixed(1) + ' KB';
}
function logoEdit(el) {
  const e = LGE; if (!e) return; const k = el.dataset.lg;
  e[k] = el.type === 'checkbox' ? el.checked : (k === 'thr' || k === 'pct') ? Number(el.value) : el.value;
  cancelAnimationFrame(e.raf); e.raf = requestAnimationFrame(logoRender);
}
async function logoLoad(file) {
  if (!file) return;
  if (!/^image\//.test(file.type || '')) return toast('Pilih file gambar (PNG, JPG, atau WebP)');
  if (file.size > 10 * 1024 * 1024) return toast('Gambar terlalu besar (maks. 10 MB)');
  let src; try { src = typeof createImageBitmap === 'function' ? await createImageBitmap(file) : await loadImg(file); } catch (e1) { try { src = await loadImg(file); } catch (e2) { return toast('Gambar tidak bisa dibaca. Gunakan PNG atau JPG.'); } }
  const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight; if (!sw || !sh) return toast('Gambar tidak bisa dibaca. Gunakan PNG atau JPG.');
  const k = Math.min(1, 1152 / Math.max(sw, sh)), rw = Math.max(1, Math.round(sw * k)), rh = Math.max(1, Math.round(sh * k));
  const base = logoDraw(src, sw, sh, rw, rh); if (src.close) { try { src.close(); } catch (e3) {} }
  const sk = Math.min(1, 96 / Math.max(rw, rh)), sc = logoDraw(base, rw, rh, Math.max(1, Math.round(rw * sk)), Math.max(1, Math.round(rh * sk))), sd = sc.getContext('2d').getImageData(0, 0, sc.width, sc.height).data;
  const color = isColorImg(sd, sc.width * sc.height), thr = Math.min(215, Math.max(40, otsu(toGray(sd, sc.width * sc.height))));
  LGE = {src: base, sw: rw, sh: rh, color: color, bw: true, inv: false, thr: thr, pct: 60, out: null, raf: 0};
  logoSheet();
}
function logoSheet() {
  const e = LGE, pcts = [30, 40, 50, 60, 70, 80, 90, 100], kertas = rcWidth() === 48 ? '80' : '58';
  sheet('<div class="grab"></div><h2>Logo struk</h2><p class="muted">Pratinjau memakai lebar kertas ' + kertas + ' mm. Printer thermal hanya mencetak titik hitam atau putih.</p>' +
    '<div class="lg-paper"><canvas id="lg_cv" class="lg-cv" aria-label="Pratinjau logo"></canvas></div><p class="muted c" id="lg_info"></p>' +
    (e.color ? '<div class="lg-note">Logo berwarna terdeteksi. Warna tidak bisa dicetak, jadi gambar perlu diubah ke hitam-putih.</div>' +
      '<label class="sw"><input type="checkbox" data-lg="bw" checked><span class="sw-t" aria-hidden="true"></span><span class="sw-l"><b>Ubah ke hitam-putih (B&amp;W)</b><small>Aktif: garis dan teks tegas, cocok untuk logo. Nonaktif: halftone (titik-titik) agar gradasi tetap terlihat.</small></span></label>' : '') +
    '<label>Ketebalan hitam<input type="range" class="lg-rng" data-lg="thr" min="20" max="235" value="' + e.thr + '"></label><p class="muted" style="margin:-6px 0 8px">Bagian terang (mis. kuning) ikut hilang? Geser ke kanan. Terlalu pekat? Geser ke kiri.</p>' +
    '<label class="sw"><input type="checkbox" data-lg="inv"><span class="sw-t" aria-hidden="true"></span><span class="sw-l"><b>Balik hitam dan putih</b><small>Aktifkan bila logo berwarna putih atau latarnya transparan.</small></span></label>' +
    '<label>Ukuran logo (% lebar kertas)<select class="inp" data-lg="pct">' + pcts.map(p => '<option value="' + p + '"' + (p === e.pct ? ' selected' : '') + '>' + p + '%</option>').join('') + '</select></label>' +
    '<div class="row2"><button class="btn sec" data-act="close">Batal</button><button class="btn pri" data-act="logosave">Simpan logo</button></div>');
  logoRender();
}
function logoSave() {
  const e = LGE; if (!e || !e.out) return; const first = !logoGet();
  return busy('Menyimpan logo…', async () => { try { await api('setting.logo', {data: logoEncode(e.out), aktif: first}); await loadData(); closeSheet(); render(); toast('Logo disimpan'); } catch (er) { toast(er.message); } });
}
function logoDel() {
  if (S.dirty) return toast('Simpan perubahan pengaturan dulu.');
  if (!confirm('Hapus logo struk?')) return;
  return busy('Menghapus logo…', async () => { try { await api('setting.logo', {data: ''}); await loadData(); render(); toast('Logo dihapus'); } catch (er) { toast(er.message); } });
}
function logoCard() { // isi kartu "Logo struk" di Pengaturan (di luar tombol-tombol sakelar)
  const lg = logoGet(), url = lg ? logoURL(lg) : '';
  return '<input type="file" id="logo_file" accept="image/*" hidden>' + (lg ?
    '<div class="lg-paper">' + (url ? '<img class="lg-cv" alt="Logo struk" src="' + url + '" style="width:' + logoPct(lg) + '">' : '') + '</div><p class="muted c">' + lg.w + ' × ' + lg.h + ' titik · lebar ± ' + (lg.w / 8) + ' mm · ' + (lg.mode === 'h' ? 'halftone' : 'hitam-putih') + '</p>' :
    '<p class="muted">Belum ada logo. Pilih gambar (PNG, JPG, atau WebP); aplikasi mengubahnya menjadi hitam-putih untuk printer thermal.</p>') +
    '<div class="row2"><button class="btn sec sm" data-act="logopick">' + (lg ? 'Ganti logo' : 'Pilih gambar logo') + '</button>' + (lg ? '<button class="btn dan sm" data-act="logodel">Hapus logo</button>' : '') + '</div>';
}
const b64 = u8 => { let t = ''; for (let i = 0; i < u8.length; i += 0x8000) t += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(t); };
function go(url, blank) { const a = document.createElement('a'); a.href = url; if (blank) { a.target = '_blank'; a.rel = 'noopener'; } a.style.display = 'none'; document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 800); }
const isAndroid = () => /Android/i.test(navigator.userAgent);
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BT_SERVICES = ['000018f0-0000-1000-8000-00805f9b34fb', '0000ff00-0000-1000-8000-00805f9b34fb', '49535343-fe7d-4ae5-8fa9-9fafd205e455', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '0000ffe0-0000-1000-8000-00805f9b34fb', '0000fee7-0000-1000-8000-00805f9b34fb'];
const BT = {dev: null, chr: null};
async function btConnect(pick) { // Web Bluetooth: hanya printer BLE (bukan Bluetooth klasik/SPP)
  if (!navigator.bluetooth) throw new Error('Browser ini tidak mendukung Web Bluetooth');
  if (!BT.dev && !pick && navigator.bluetooth.getDevices) { try { const ds = await navigator.bluetooth.getDevices(), n = LS.get('btname', ''); BT.dev = ds.find(d => d.name === n) || null; } catch (e) {} }
  if (!BT.dev || pick) { BT.dev = await navigator.bluetooth.requestDevice({acceptAllDevices: true, optionalServices: BT_SERVICES}); BT.chr = null; LS.set('btname', BT.dev.name || ''); if (BT.dev.addEventListener) BT.dev.addEventListener('gattserverdisconnected', () => { BT.chr = null; }); }
  if (!BT.dev.gatt.connected) { BT.chr = null; await BT.dev.gatt.connect(); }
  if (!BT.chr) {
    for (const sv of await BT.dev.gatt.getPrimaryServices()) { const w = (await sv.getCharacteristics()).find(c => c.properties.writeWithoutResponse || c.properties.write); if (w) { BT.chr = w; break; } }
    if (!BT.chr) throw new Error('Printer tidak menyediakan jalur tulis BLE yang dikenali. Pastikan printer BLE, atau pakai RawBT di Android.');
  }
  return BT.chr;
}
async function btPrint(rc) {
  const bytes = escpos(rc), chr = await btConnect(false);
  for (let i = 0; i < bytes.length; i += 100) { const part = bytes.slice(i, i + 100); if (chr.properties.writeWithoutResponse) await chr.writeValueWithoutResponse(part); else await chr.writeValue(part); await sleep(25); }
}
function iosHelp() {
  sheet('<div class="grab"></div><h2>Cetak dari iPhone</h2><p class="muted">Safari dan Chrome di iPhone tidak bisa mengirim data ke printer Bluetooth. Pilihan yang bisa dipakai:</p>' +
    '<div class="li" style="display:block"><b>1. Browser dengan Web Bluetooth</b><div class="muted">Pasang browser seperti Bluefy, buka alamat aplikasi ini di sana, lalu tekan Cetak Bluetooth. Printer harus tipe <b>BLE</b>; printer Bluetooth klasik (kebanyakan printer murah) tidak dikenali iPhone.</div><button class="btn sec sm" data-act="copyurl">Salin alamat aplikasi</button></div>' +
    '<div class="li" style="display:block"><b>2. AirPrint atau PDF</b><div class="muted">Tombol Cetak memakai menu cetak iOS (printer AirPrint, atau simpan sebagai PDF).</div><button class="btn sec sm" data-act="print">Cetak</button></div>' +
    '<div class="li" style="display:block"><b>3. Bagikan struk</b><div class="muted">Kirim ke WhatsApp atau aplikasi printer lain lewat menu bagikan iOS.</div><button class="btn sec sm" data-act="share">Bagikan…</button></div>' +
    '<div class="li" style="display:block"><b>4. Android + RawBT</b><div class="muted">Untuk printer Bluetooth klasik, gunakan HP Android dengan aplikasi RawBT.</div></div><button class="btn pri" data-act="close">Mengerti</button>');
}
async function printBT(rc) {
  if (!rc) return toast('Tidak ada struk untuk dicetak');
  const direct = !!LS.get('btdirect', false);
  if (isAndroid() && !(direct && navigator.bluetooth)) return go('intent:base64,' + b64(escpos(rc)) + '#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;');
  if (navigator.bluetooth) {
    try { toast('Mencetak ke printer…'); await btPrint(rc); toast('Struk dikirim ke printer'); }
    catch (e) { logErr(e, 'btprint'); BT.chr = null; if (e && e.name === 'NotFoundError') toast('Pemilihan printer dibatalkan'); else toast('Gagal mencetak: ' + e.message); }
    return;
  }
  if (isIOS()) return iosHelp();
  toast('Bluetooth tidak tersedia di browser ini. Memakai cetak browser.'); printBrowser();
}
const PG = {rule: null};
function printBrowser() {
  const d = document.querySelector('#rtxt'); if (d && d.closest('details')) d.closest('details').open = true;
  try { // @page lewat CSSOM pada app.css (diizinkan CSP; elemen <style> sisipan tidak)
    const ss = Array.from(document.styleSheets).find(x => /css\/app\.css/.test(x.href || '')) || document.styleSheets[0];
    if (PG.rule) { const i = Array.prototype.indexOf.call(ss.cssRules, PG.rule); if (i >= 0) ss.deleteRule(i); }
    PG.rule = ss.cssRules[ss.insertRule('@page{size:' + (rcWidth() === 48 ? 80 : 58) + 'mm auto;margin:0}', ss.cssRules.length)]; // ukuran kertas mengikuti pengaturan
  } catch (e) { logErr(e, 'cetak'); }
  setTimeout(() => window.print(), 60);
}
function waSend(rc, number) {
  let n = String(number || '').replace(/\D/g, ''); if (n.indexOf('0') === 0) n = '62' + n.slice(1); else if (n.indexOf('8') === 0) n = '62' + n;
  go((n ? 'https://wa.me/' + n : 'https://api.whatsapp.com/send') + '?text=' + encodeURIComponent('```' + receiptText(rc) + '```'), true);
}
async function copyText(t, msg) {
  msg = msg || 'Struk disalin. Tempel di WhatsApp atau aplikasi lain.';
  try { await navigator.clipboard.writeText(t); toast(msg); }
  catch (e) { const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (x) {} ta.remove(); toast(ok ? msg : 'Tidak bisa menyalin.'); }
}
async function shareRc(rc) {
  const text = receiptText(rc);
  if (navigator.share) { try { await navigator.share({title: 'Struk ' + (cfg('nama_usaha') || 'Duado Snack'), text: text}); } catch (e) { if (e && e.name !== 'AbortError') copyText(text); } } else copyText(text);
}
const testRc = () => { S.nomor.uji = 'UJI-001'; return {rid: 'uji', time: Date.now(), kasir: String((S.data && S.data.user && S.data.user.nama) || 'Kasir'), ch: 'Uji coba', metode: 'tunai', terima: 20000, kembali: 3000, sub: 17000, dis: 0, ppn: 0, total: 17000, lines: [{n: 'Contoh Produk A 80gr', q: 1, h: 7000}, {n: 'Contoh Produk B 100gr', q: 1, h: 10000}]}; };

