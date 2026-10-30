/* ---------- Kasir ---------- */
function calc() {
  const s = S.data.settings; let sub = 0; S.cart.forEach(l => { sub += l.qty * (priceOf(l.v, S.ch) || 0); });
  const dis = Math.min(Math.max(Number(S.diskon) || 0, 0), sub), base = sub - dis, pp = Number(s.ppn_persen) || 0; let ppn = 0, total = base;
  if (T(s.ppn_aktif) && pp > 0) { if (T(s.ppn_inklusif)) ppn = Math.round(base * pp / (100 + pp)); else { ppn = Math.round(base * pp / 100); total = base + ppn; } }
  return {sub: sub, dis: dis, ppn: ppn, total: total};
}
const cartQty = id => { const l = S.cart.find(x => x.v === id); return l ? l.qty : 0; };
const saveCart = () => LS.set('cart', S.cart);
const chShort = n => /whatsapp/i.test(n) ? 'WA / IG' : n;
const isWide = () => !!(window.matchMedia && matchMedia('(min-width: 768px)').matches); // tablet: layar terbagi, daftar produk kiri dan pesanan kanan
function vKasir() {
  const d = S.data, wide = isWide(); S.cart = S.cart.filter(l => vById(l.v));
  const withAny = new Set(d.variants.map(v => v.product_id)), withV = new Set(d.variants.filter(v => !isAddon(v)).map(v => v.product_id)), cats = ['Semua'].concat(Array.from(new Set(d.products.filter(p => withV.has(p.id)).map(p => String(p.kategori == null ? '' : p.kategori)).filter(Boolean)))), noV = d.products.filter(p => !withAny.has(p.id)).length;
  if (S.cat !== 'Semua' && cats.indexOf(S.cat) < 0) S.cat = 'Semua';
  const ctl = (shiftNeeded() ? '<div class="notice"><span>Kasir belum dibuka. Isi modal awal dulu agar penjualan bisa tercatat.</span><button class="chip" data-act="go_tutup">Buka kasir</button></div>' : '') + (own() && noV ? '<div class="notice"><span>' + noV + ' produk belum punya varian, jadi belum tampil di sini.</span><button class="chip" data-act="go_cek">Periksa data</button></div>' : '') + '<button id="qstat" data-act="queue"></button>' +
    '<div class="chips-wrap seg-wrap"><div class="chips seg" role="group" aria-label="Channel penjualan">' + d.channels.map(c => '<button class="' + (c.id === S.ch ? 'on' : '') + '" aria-pressed="' + (c.id === S.ch) + '" data-act="chan" data-c="' + esc(c.id) + '">' + esc(chShort(c.nama)) + '</button>').join('') + '</div></div>',
    flt = '<label class="search">' + svg('search', 18) + '<input id="q" class="inp" data-in="q" placeholder="Cari produk atau SKU" value="' + esc(S.q) + '" aria-label="Cari produk"></label>' +
    wrapChips(cats.map(c => '<button class="chip ' + (c === S.cat ? 'on' : '') + '" aria-pressed="' + (c === S.cat) + '" data-act="cat" data-c="' + esc(c) + '">' + esc(c) + '</button>').join('')) +
    '<div class="krow"><span class="muted" id="kcount"></span><label class="sw sm"><input type="checkbox" data-act="hideout"' + (S.hideOut ? ' checked' : '') + '><span class="sw-t" aria-hidden="true"></span><span class="sw-l">Sembunyikan yang habis</span></label></div>',
    top = wide ? '<div class="kasir-top">' + ctl + flt + '</div>' : '<div class="kasir-ctl">' + ctl + '</div><div class="kasir-top">' + flt + '</div>'; // v1.9.9 ponsel: pemilih channel ikut tergulir; hanya cari + kategori yang menempel (hemat ~1/4 layar)
  const m = $('#main'); m.className = wide ? 'split' : '';
  m.innerHTML = wide ? '<div class="kleft">' + top + '<div class="grid" id="grid"></div></div><aside class="kright" id="cpanel">' + cartInner(true) + '</aside>' : top + '<div class="grid" id="grid"></div>';
  grid(); if (wide) mountCart(); qstatUpd();
}
const isOff = v => priceOf(v.id, S.ch) == null || (T(cfg('blokir_stok_minus')) && (Number(v.stok) || 0) <= 0);
const TILE = [['#E0A23C', '#B8741E'], ['#E07B3C', '#9E4514'], ['#C9482A', '#8A2410'], ['#D9A441', '#8F5A1C'], ['#B8602A', '#6B1409'], ['#E7B25A', '#C07A22']];
const tileOf = v => { let h = 0; String(v.product_id || v.id).split('').forEach(c => { h = (h * 31 + c.charCodeAt(0)) >>> 0; }); return TILE[h % TILE.length]; };
/* ===== v1.9.1 (tahap 2): foto produk. Foto = satu per PRODUK (semua varian memakainya), disimpan di Supabase Storage (bucket product-photos); products.photo_url menyimpan alamatnya ===== */
const fotoOf = p => p && /^https:\/\//.test(p.foto_url || '') ? p.foto_url : '';
const photoInner = (p, name) => '<span class="ini">' + esc(String(name).trim().charAt(0).toUpperCase()) + '</span>' + (fotoOf(p) ? '<img src="' + esc(fotoOf(p)) + '" alt="" crossorigin="anonymous" referrerpolicy="no-referrer" decoding="async" loading="lazy" data-foto="1">' : '');
const photoHtml = v => photoInner(pById(v.product_id), vName(v));
function fotoErr(im) { // gagal muat: sekali coba tanpa CORS (hanya online, tidak masuk cache); gagal lagi = buang gambar, huruf awal di bawahnya tampil
  if (!im.dataset.r && im.hasAttribute('crossorigin')) { im.dataset.r = '1'; im.removeAttribute('crossorigin'); im.src = im.src; } else im.remove();
}
const FOTO = {side: 480, target: 32 * 1024, small: 40 * 1024, cache: 'duado-foto'};
const blobB64 = b => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = () => no(new Error('baca')); r.readAsDataURL(b); });
const toBlob = (cv, type, q) => new Promise(ok => { try { cv.toBlob(ok, type, q); } catch (e) { ok(null); } });
async function fotoPrepare(file) { // -> {b64, bytes}. File kecil (WebP/JPEG <= 40 KB, <= 640 px) dikirim apa adanya; selain itu dipotong persegi di tengah, dikecilkan ke 480 px, dikodekan WebP (JPEG bila WebP tak didukung)
  let src; try { src = typeof createImageBitmap === 'function' ? await createImageBitmap(file, {imageOrientation: 'from-image'}) : await loadImg(file); } catch (e1) { try { src = await loadImg(file); } catch (e2) { throw new Error('Foto tidak bisa dibaca. Gunakan JPG, PNG, atau WebP.'); } }
  const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight; if (!sw || !sh) throw new Error('Foto tidak bisa dibaca. Gunakan JPG, PNG, atau WebP.');
  if ((file.type === 'image/webp' || file.type === 'image/jpeg') && file.size <= FOTO.small && Math.max(sw, sh) <= 640) { if (src.close) src.close(); return {b64: await blobB64(file), bytes: file.size}; }
  const s = Math.min(sw, sh), m = Math.min(s, FOTO.side * 2), c0 = document.createElement('canvas'); c0.width = c0.height = m;
  const x0 = c0.getContext('2d'); x0.fillStyle = '#fff'; x0.fillRect(0, 0, m, m); x0.imageSmoothingEnabled = true; x0.imageSmoothingQuality = 'high'; x0.drawImage(src, (sw - s) >> 1, (sh - s) >> 1, s, s, 0, 0, m, m);
  if (src.close) src.close();
  let side = Math.min(FOTO.side, m), best = null, type = null;
  for (let pass = 0; pass < 3; pass++) {
    const cv = logoDraw(c0, m, m, side, side);
    if (!type) { const pr = await toBlob(cv, 'image/webp', 0.8); type = pr && pr.type === 'image/webp' ? 'image/webp' : 'image/jpeg'; } // Safari lama menjawab PNG untuk WebP
    for (const q of [0.82, 0.72, 0.62, 0.52, 0.42]) {
      const b = await toBlob(cv, type, q); if (!b) throw new Error('Foto tidak bisa dikompres di perangkat ini.');
      if (!best || b.size < best.size) best = b; if (b.size <= FOTO.target) return {b64: await blobB64(b), bytes: b.size};
    }
    side = Math.max(160, Math.round(side * 0.85)); // masih di atas target: kecilkan ukuran lalu ulangi
  }
  return {b64: await blobB64(best), bytes: best.size};
}
function fotoInner(id) {
  const p = S.data.products.find(x => x.id === id); if (!p) return '';
  const t = tileOf({id: id}), has = !!fotoOf(p);
  return '<div class="fprev ph" style="--t1:' + t[0] + ';--t2:' + t[1] + '">' + photoInner(p, p.nama) + '</div><div class="fact"><b>Foto produk</b><span class="muted">Tampil di halaman Kasir untuk semua varian. Dikecilkan otomatis (±480 px, ±30 KB).</span><div class="row2"><button class="btn sec sm" data-act="fotopick">' + (has ? 'Ganti foto' : 'Pilih foto') + '</button>' + (has ? '<button class="btn dan sm" data-act="fotodel">Hapus foto</button>' : '') + '</div></div>';
}
const fotoBox = id => id ? '<input type="file" id="foto_file" accept="image/*" hidden><div class="fbox" id="fbox">' + fotoInner(id) + '</div>' : '<p class="muted">Simpan produk dulu, lalu buka lagi untuk menambahkan foto.</p>';
function fotoApply(pid, url) {
  const p = S.data.products.find(x => x.id === pid); if (p) p.foto_url = url; LS.set('data', S.data);
  const b = $('#fbox'); if (b && S.fotoFor === pid) b.innerHTML = fotoInner(pid);
  if (S.tab === 'kasir' && $('#grid')) grid(); setTimeout(fotoWarm, 300);
}
async function fotoLoad(file) {
  const pid = S.fotoFor; if (!file || !pid) return;
  if (!/^image\//.test(file.type || '')) return toast('Pilih file gambar (JPG, PNG, atau WebP)');
  if (file.size > 25 * 1024 * 1024) return toast('Foto terlalu besar (maks. 25 MB)');
  if (navigator.onLine === false) return toast('Tidak ada koneksi. Foto hanya bisa diunggah saat online.');
  return busy('Menyiapkan foto…', async () => {
    let r; try { r = await fotoPrepare(file); } catch (e) { return toast(e.message); }
    busyLabel('Mengunggah foto (' + Math.max(1, Math.round(r.bytes / 1024)) + ' KB)…');
    try { const out = await api('produk.foto', {product_id: pid, data: r.b64}); fotoApply(pid, out.foto_url); toast('Foto tersimpan'); } catch (e) { toast(e.message); }
  });
}
async function fotoDel() {
  const pid = S.fotoFor; if (!pid || !confirm('Hapus foto produk ini?')) return;
  return busy('Menghapus foto…', async () => { try { await api('produk.foto', {product_id: pid, data: ''}); fotoApply(pid, ''); toast('Foto dihapus'); } catch (e) { toast(e.message); } });
}
document.addEventListener('error', ev => { const t = ev.target; if (t && t.tagName === 'IMG' && t.hasAttribute('data-foto')) fotoErr(t); }, true); // error gambar tidak menggelembung: ditangkap di fase capture (CSP v1.9.7 melarang onerror inline; sebelumnya fotoErr juga tidak terjangkau dari atribut)
let fotoBusy = false;
async function fotoWarm() { // simpan semua foto katalog ke cache offline (satu per satu, ringan) dan buang yang sudah tidak dipakai
  if (fotoBusy || !S.data || !window.caches || navigator.onLine === false) return; fotoBusy = true;
  try {
    const urls = Array.from(new Set((S.data.products || []).map(fotoOf).filter(Boolean))), keep = new Set(urls.map(u => new URL(u).href)), c = await caches.open(FOTO.cache);
    for (const u of urls) { try { if (!(await c.match(u, {ignoreVary: true}))) { const r = await fetch(u, {mode: 'cors', credentials: 'omit'}); if (r.ok) await c.put(u, r); } } catch (e) { /* offline atau tanpa CORS: tampil saat online saja */ } }
    for (const k of await c.keys()) if (!keep.has(k.url)) await c.delete(k);
  } catch (e) { logErr(e, 'foto'); } finally { fotoBusy = false; }
}
/* Kartu yang belum di keranjang = satu tombol "tambah". Kartu yang sudah di keranjang memuat tombol - dan + sungguhan; di dalam role=button anak-anaknya dianggap dekoratif (tak terbaca pembaca layar), jadi kartu itu menjadi group. */
const cardAttrs = v => cartQty(v.id) ? {role: 'group', 'aria-label': vName(v)} : {role: 'button', tabindex: '0', 'aria-disabled': isOff(v) ? 'true' : 'false'};
const cardRole = v => { const a = cardAttrs(v); return Object.keys(a).map(k => ' ' + k + '="' + esc(a[k]) + '"').join(''); };
function cardHtml(v) {
  const pr = priceOf(v.id, S.ch), st = Number(v.stok) || 0, q = cartQty(v.id), off = isOff(v), lv = lvText(v.level_pedas), t = tileOf(v);
  const stk = st <= 0 ? '' : st <= 5 ? '<span class="stk low">Sisa ' + num(st) + '</span>' : '<span class="stk">Stok ' + num(st) + '</span>';
  const bad = pr == null ? '<span class="badge-out warn">Harga?</span>' : st <= 0 ? '<span class="badge-out">HABIS</span>' : '';
  return '<div class="ph" style="--t1:' + t[0] + ';--t2:' + t[1] + '">' + photoHtml(v) + bad + heat(v.level_pedas) + '</div><div class="bd"><b class="pn">' + esc(vName(v)) + (lv ? ' <span class="lvt">· ' + esc(lv) + '</span>' : '') + '</b>' + (v.ukuran ? '<div class="pm"><span class="sz">' + esc(v.ukuran) + '</span></div>' : '') +
    '<div class="pf"><div class="pp"><span class="pr">' + (pr == null ? 'Harga belum diatur' : rp(pr)) + '</span>' + stk + '</div>' +
    (q ? '<div class="step"><button data-act="dec1" data-v="' + esc(v.id) + '" aria-label="Kurangi ' + esc(vName(v)) + '">−</button><b>' + q + '</b><button data-act="inc1" data-v="' + esc(v.id) + '" aria-label="Tambah ' + esc(vName(v)) + '">+</button></div>' : '<span class="plus' + (off ? ' dis' : '') + '" aria-hidden="true">+</span>') + '</div></div>';
}
function grid() {
  const d = S.data, q = S.q.toLowerCase(), avail = v => (Number(v.stok) || 0) > 0;
  const base = d.variants.filter(v => !isAddon(v) && (S.cat === 'Semua' || String((pById(v.product_id) || {}).kategori) === S.cat) && (!q || (vName(v) + ' ' + vSub(v) + ' ' + v.sku).toLowerCase().indexOf(q) >= 0));
  let list = S.hideOut ? base.filter(avail) : base;
  list = list.map((v, i) => [v, i]).sort((x, y) => (avail(y[0]) - avail(x[0])) || (x[1] - y[1])).map(x => x[0]); // tersedia di atas, habis di bawah, urutan asli dijaga
  const sig = S.cat + '|' + q + '|' + S.hideOut; if (S.gsig !== sig) { S.gsig = sig; delete LIM.grid; const mn = $('#main'); if (mn) mn.scrollTop = 0; } // filter berganti: mulai dari halaman pertama dan dari atas (tanpa ini browser menahan posisi di dasar daftar baru dan sentinel memuat berantai sampai semua baris)
  const kc = $('#kcount'); if (kc) kc.textContent = list.length + ' produk' + (S.hideOut && base.length > list.length ? ' · ' + (base.length - list.length) + ' habis disembunyikan' : '');
  $('#grid').innerHTML = (list.slice(0, lim('grid')).map(v => {
    const off = isOff(v), n = heatN(v.level_pedas);
    return '<div class="card pc h' + (n < 0 ? 'x' : n) + (off ? ' off' : '') + (cartQty(v.id) ? ' in' : '') + '" data-act="add" data-v="' + esc(v.id) + '"' + cardRole(v) + '>' + cardHtml(v) + '</div>';
  }).join('') + moreBtn('grid', list.length)) || (S.hideOut && base.length ? emptyState('stok', 'Semua produk habis', 'Matikan "Sembunyikan yang habis" untuk melihat daftar lengkap.', '<button class="btn sec" data-act="showout">Tampilkan yang habis</button>') :
    own() ? emptyState('stok', 'Belum ada produk untuk dijual', 'Produk harus punya varian dan harga agar tampil di sini.', '<button class="btn pri" data-act="go_cek">Periksa data</button>') : emptyState('stok', 'Belum ada produk', 'Tidak ada produk di kategori ini.', ''));
  watchMore();
}
function updCard(id) { // perbarui satu kartu saja, tanpa menggambar ulang seluruh daftar
  const el = document.querySelector('#grid .card[data-v="' + id + '"]'), v = vById(id); if (!el || !v) return;
  const had = el.contains(document.activeElement); // pengguna keyboard: fokus jangan hilang saat isi kartu diganti
  el.innerHTML = cardHtml(v); el.classList.toggle('in', cartQty(id) > 0);
  ['role', 'tabindex', 'aria-disabled', 'aria-label'].forEach(a => el.removeAttribute(a));
  const at = cardAttrs(v); Object.keys(at).forEach(k => el.setAttribute(k, at[k]));
  if (had) { const nx = /** @type {HTMLElement|null} */ (cartQty(id) > 0 ? el.querySelector('[data-act="inc1"]') : el); if (nx) nx.focus({preventScroll: true}); } el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
}
function barRender() {
  const el = $('#cartbar'); if (!el) return;
  if (S.tab !== 'kasir' || !S.cart.length) { el.innerHTML = ''; return; }
  const c = calc(), n = S.cart.reduce((a, l) => a + l.qty, 0);
  el.innerHTML = '<button class="cartbar" data-act="cart"><span class="cb-i">' + svg('kasir', 20) + '<em>' + n + '</em></span><span class="cb-t"><small>' + n + ' item</small><b>' + rp(c.total) + '</b></span><span class="cb-go">Bayar ' + svg('chev', 18) + '</span></button>';
}
function cartbar() { // ponsel: bilah bawah; tablet: panel pesanan di kanan
  if (isWide()) { const b = $('#cartbar'); if (b) b.innerHTML = ''; if (S.tab === 'kasir' && $('#cpanel')) { cartLines(); cashBox(); upd(); } return; }
  barRender();
}
function addToCart(id) {
  const v = vById(id); if (!v) return;
  if (priceOf(id, S.ch) == null) return toast('Harga belum diatur untuk channel ini');
  const l = S.cart.find(x => x.v === id), q = (l ? l.qty : 0) + 1, st = Number(v.stok) || 0;
  if (T(cfg('blokir_stok_minus')) && q > st) return toast(st > 0 ? 'Stok tidak cukup' : 'Stok habis');
  if (l) l.qty = q; else { S.cart.push({v: id, qty: 1}); if (S.cart.length > lim('cart')) LIM.cart = S.cart.length; } // baris baru selalu terlihat
  saveCart(); updCard(id); syncCart(); buzz();
}
function dropFromCart(id) {
  const i = S.cart.findIndex(x => x.v === id); if (i < 0) return;
  S.cart[i].qty--; if (S.cart[i].qty <= 0) S.cart.splice(i, 1); saveCart(); updCard(id); syncCart();
}
const payMethods = () => ['tunai', 'transfer', 'qris'].filter(m => { const v = cfg('bayar_' + m); return v === undefined || v === '' || T(v); }); // whitelist dari Pengaturan
const methodChips = () => payMethods().map(m => '<button class="chip ' + (S.metode === m ? 'on' : '') + '" aria-pressed="' + (S.metode === m) + '" data-act="metode" data-m="' + m + '">' + m.toUpperCase() + '</button>').join('');
function cartLines() {
  const el = $('#cl'); if (!el) return;
  if (!S.cart.length) { delete LIM.cart; el.innerHTML = '<div class="cp-empty">' + svg('kasir', 34) + '<p>Ketuk produk di sebelah kiri untuk menambahkannya ke pesanan.</p></div>'; return; }
  el.innerHTML = S.cart.slice(0, lim('cart')).map((l, i) => { const v = vById(l.v), p = priceOf(l.v, S.ch) || 0;
    return '<div class="li cl-i"><div class="cl-n"><b>' + esc(vName(v)) + '</b><div class="muted">' + esc([vSub(v), rp(p)].filter(Boolean).join(' · ')) + '</div></div><div class="qty"><button data-act="dec" data-i="' + i + '" aria-label="Kurangi">−</button><span>' + l.qty + '</span><button data-act="inc" data-i="' + i + '" aria-label="Tambah">+</button></div><b class="cl-t">' + rp(p * l.qty) + '</b></div>'; }).join('') + moreBtn('cart', S.cart.length); watchMore();
}
function cashBox() {
  const el = $('#cashbox'); if (!el) return;
  if (S.metode !== 'tunai') { const mn = Number(cfg('bayar_referensi_min')), req = mn > 0 && calc().total >= mn;   // F-10: referensi transfer/QRIS untuk rekonsiliasi dengan mutasi penyedia
    el.innerHTML = '<p class="muted">Pembayaran ' + esc(S.metode.toUpperCase()) + ' dicatat lunas saat disimpan.</p><label>No. referensi ' + (req ? '(wajib)' : '(disarankan)') + '<input class="inp" data-in="ref" maxlength="60" autocomplete="off" placeholder="Dari bukti ' + esc(S.metode.toUpperCase()) + '" value="' + esc(S.ref || '') + '"></label>'; return; }
  const t = calc().total, q = [t].concat([5000, 10000, 20000, 50000, 100000].map(n => Math.ceil(t / n) * n)).filter((x, i, a) => x > 0 && a.indexOf(x) === i).slice(0, 4);
  el.innerHTML = '<label>Uang diterima (Rp)<input class="inp" data-in="terima" inputmode="numeric" placeholder="' + num(t) + '" value="' + esc(S.terima) + '"></label><div class="chips">' + q.map((x, i) => '<button class="chip" data-act="qk" data-n="' + x + '">' + (i === 0 ? 'Uang pas' : num(x)) + '</button>').join('') + '</div>';
}
function cartInner(panel) {
  return (panel ? '<div class="cp-h"><h2>Pesanan</h2><span class="muted">' + esc(chName(S.ch)) + '</span></div>' : '<div class="grab"></div><div class="sh-h"><h2>Pembayaran</h2><span class="muted">' + esc(chName(S.ch)) + '</span></div>') +
    '<div id="cl"></div><div id="addons"></div><div class="paybox"><div class="chips" id="mchips">' + methodChips() + '</div><div id="cashbox"></div></div>' +
    '<details class="more"' + (S.diskon || S.catatan ? ' open' : '') + '><summary>Diskon dan catatan</summary><label>Diskon (Rp)<input class="inp" data-in="diskon" inputmode="numeric" value="' + esc(S.diskon) + '"></label><label>Catatan<input class="inp" data-in="catatan" value="' + esc(S.catatan) + '"></label></details>' +
    '<div id="tot"></div><button class="btn pri big" id="paybtn" data-act="pay">Bayar</button>';
}
function addonsRender() { // menu pembayaran: "Tambahan" seperti retail modern (kantong kresek, dll.)
  const el = $('#addons'); if (!el) return; const L = S.data.variants.filter(v => isAddon(v) && priceOf(v.id, S.ch) != null), block = T(cfg('blokir_stok_minus'));
  if (!L.length) { el.innerHTML = own() ? '<p class="muted ad-none">Belum ada produk tambahan (mis. kantong kresek). Buat di Pengaturan, kartu "Kantong & Tambahan".</p>' : ''; return; }
  el.innerHTML = '<div class="ad-h">Tambahan</div>' + L.map(v => { const q = cartQty(v.id), st = Number(v.stok) || 0, out = block && st <= 0, nm = esc(vName(v) + (v.ukuran ? ' ' + v.ukuran : ''));
    return '<div class="ad-row"><div class="ad-n"><b>' + nm + '</b><small>' + rp(priceOf(v.id, S.ch)) + (out ? ' · habis' : '') + '</small></div>' +
      (q ? '<div class="qty"><button data-act="dec1" data-v="' + esc(v.id) + '" aria-label="Kurangi ' + nm + '">−</button><span>' + q + '</span><button data-act="inc1" data-v="' + esc(v.id) + '" aria-label="Tambah ' + nm + '">+</button></div>' : '<button class="chip ad-add" data-act="inc1" data-v="' + esc(v.id) + '"' + (out ? ' aria-disabled="true"' : '') + '>+ Tambah</button>') + '</div>'; }).join('');
}
function refreshCart() { cartLines(); addonsRender(); cashBox(); upd(); if (!S.cart.length && !isWide() && $('#sheet') && !$('#sheet').hidden && $('#cl')) closeSheet(); }
const syncCart = () => { if ($('#cl')) refreshCart(); else cartbar(); };
const mountCart = () => { cartLines(); addonsRender(); cashBox(); upd(); };
function cartSheet() { if (isWide() || !S.cart.length) return; sheet(cartInner(false)); mountCart(); }
function upd() {
  const c = calc(), s = S.data.settings, kv = (a, b, cl) => '<div class="kv ' + (cl || '') + '"><span>' + a + '</span><span>' + b + '</span></div>', tunai = S.metode === 'tunai', terima = S.terima === '' ? null : Number(S.terima) || 0;
  let h = kv('Subtotal', rp(c.sub)); if (c.dis) h += kv('Diskon', '-' + rp(c.dis)); if (c.ppn) h += kv(T(s.ppn_inklusif) ? 'PPN (sudah termasuk)' : 'PPN', rp(c.ppn));
  h += kv('Total', rp(c.total), 'big'); if (tunai && terima !== null) h += kv(terima >= c.total ? 'Kembalian' : 'Kurang', rp(Math.abs(terima - c.total)), terima >= c.total ? 'ok-r' : 'err-r');
  const t = $('#tot'); if (t) t.innerHTML = h;
  const b = $('#paybtn'); if (b) { const short = tunai && terima !== null && terima < c.total; b.disabled = short || !S.cart.length; b.textContent = !S.cart.length ? 'Bayar' : short ? 'Uang kurang ' + rp(c.total - terima) : 'Bayar ' + rp(c.total); }
  if (!isWide()) barRender();
}
/* Otorisasi Owner di perangkat ini: Owner mengetik PIN, server memberi token sekali pakai untuk satu transaksi (PIN tidak disimpan). */
function askOwner(msg, kind, rid, nilai, ref) {
  return new Promise(res => {
    S.opin = {res: res, kind: kind, rid: rid, nilai: nilai, ref: ref};
    sheet('<div class="grab"></div><h2>Otorisasi Owner / Supervisor</h2><p class="muted">' + esc(msg) + '</p><label>Username Owner / Supervisor<input class="inp" id="ou" autocapitalize="none" value="' + esc(LS.get('ownerUser', 'owner')) + '"></label><label>PIN Owner / Supervisor<input class="inp" id="op" type="password" inputmode="numeric" autocomplete="off"></label><div class="err" id="oerr"></div><button class="btn pri" data-act="opin_ok">Setujui</button><button class="btn sec" data-act="close">Batal</button>');
  });
}
async function opinOk() {
  const o = S.opin; if (!o) return; const u = ($('#ou') || {}).value, pw = ($('#op') || {}).value; if (!u || !pw) return;
  $('#oerr').textContent = '';
  try { const r = await api('override.grant', {kind: o.kind, request_id: o.rid, nilai: o.nilai, ref_id: o.ref, username: u.trim(), pin: pw, dev: devId()}); LS.set('ownerUser', u.trim()); S.opin = null; closeSheet(); o.res(r.token); }
  catch (e) { $('#oerr').textContent = e.server ? e.message : 'Otorisasi butuh koneksi internet.'; }
}
async function pay() {
  if (S.paying || !S.cart.length) return;
  if (S.cart.some(l => !vById(l.v))) { S.cart = S.cart.filter(l => vById(l.v)); saveCart(); toast('Ada produk yang sudah tidak tersedia; keranjang diperbarui'); if (S.cart.length) { if (!isWide()) cartSheet(); } else closeSheet(); cartbar(); return; }
  const c = calc(), tunai = S.metode === 'tunai', terima = tunai ? (S.terima === '' ? c.total : Number(S.terima) || 0) : c.total;
  if (tunai && terima < c.total) return toast('Uang diterima kurang');
  { const mn = Number(cfg('bayar_referensi_min')); if (!tunai && mn > 0 && c.total >= mn && !String(S.ref || '').trim()) return toast('Isi nomor referensi ' + S.metode.toUpperCase() + ' (transaksi Rp' + num(mn) + ' ke atas)'); }
  if (payMethods().indexOf(S.metode) < 0) { S.metode = payMethods()[0] || 'tunai'; LS.set('metode', S.metode); const mc = $('#mchips'); if (mc) mc.innerHTML = methodChips(); cashBox(); upd(); return toast('Metode bayar tidak tersedia, dipilih ' + S.metode.toUpperCase()); }
  S.paying = true; let rc;
  const rid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2), ts = Date.now(), override = {};
  if (!own()) { // kontrol kasir: diskon di atas batas butuh PIN Owner (diverifikasi server saat ini juga)
    const raw = cfg('diskon_maks_persen'), mp = Number(raw), maks = raw === undefined || raw === '' || isNaN(mp) ? 100 : mp;
    if (c.dis > c.sub * maks / 100 + 0.5) {
      const tok = await askOwner('Diskon ' + rp(c.dis) + ' melebihi batas ' + maks + '% dari subtotal. Minta Owner memasukkan PIN untuk menyetujui.', 'diskon', rid, c.dis);
      if (!tok) { S.paying = false; if (!isWide()) cartSheet(); return; }
      override.diskon = tok;
    }
  }
  try {
    const payload = {request_id: rid, outlet_id: S.data.outlet ? S.data.outlet.id : undefined, channel_id: S.ch, items: S.cart.map(l => ({variant_id: l.v, qty: l.qty})), diskon: c.dis, metode_bayar: S.metode, catatan: S.catatan, client_ts: ts, total_klien: c.total};
    if (!tunai && String(S.ref || '').trim()) payload.referensi_bayar = String(S.ref).trim().slice(0, 60);
    if (override.diskon) payload.override = override;
    rc = {rid: rid, time: ts, kasir: String((S.data.user && (S.data.user.nama || S.data.user.username)) || ''), ch: chName(S.ch), metode: S.metode, terima: terima, kembali: terima - c.total, sub: c.sub, dis: c.dis, ppn: c.ppn, total: c.total,
      lines: S.cart.map(l => { const v = vById(l.v); return {n: (vName(v) + ' ' + vSub(v)).trim(), q: l.qty, h: priceOf(l.v, S.ch)}; })};
    S.queue.push({rid: rid, payload: payload, status: 'pending', state: 'waiting', ts: Date.now(), uid: S.data.user.uid, total: c.total, ch: rc.ch}); LS.set('queue', S.queue);
    S.cart.forEach(l => { const v = vById(l.v); if (v) v.stok = r6((Number(v.stok) || 0) - l.qty); }); LS.set('data', S.data);
  } catch (e) { S.paying = false; logErr(e, 'bayar'); return toast('Transaksi gagal disimpan: ' + e.message); }
  /* transaksi sudah aman di antrean: kosongkan keranjang lebih dulu agar tidak pernah tersisa, apa pun yang terjadi setelah ini */
  S.cart = []; S.diskon = ''; S.terima = ''; S.catatan = ''; S.ref = ''; LS.del('cart'); closeSheet();
  try { render(); } catch (e) { logErr(e, 'render'); }
  try { showReceipt(rc); } catch (e) { logErr(e, 'struk'); toast('Transaksi tersimpan, tetapi struk gagal ditampilkan.'); }
  if (T(cfg('auto_cetak'))) { try { printBT(rc); } catch (e) { logErr(e, 'cetak'); } }
  S.paying = false; flush();
}
function showReceipt(rc) {
  S.rc = rc; const tunai = rc.metode === 'tunai';
  sheet('<div class="grab"></div><div class="okmark">' + svg('check', 30) + '</div><h2 class="c">Pembayaran berhasil</h2><div class="rc-sum"><div><small>Total</small><b>' + rp(rc.total) + '</b></div><div><small>' + (tunai ? 'Kembalian' : 'Metode') + '</small><b>' + (tunai ? rp(Math.max(rc.kembali, 0)) : esc(rc.metode.toUpperCase())) + '</b></div></div>' +
    '<label>No. WhatsApp pelanggan (opsional)<input class="inp" id="wa" inputmode="tel" placeholder="08xxxxxxxxxx"></label>' +
    '<div class="row2"><button class="btn wa" data-act="wa">Kirim WhatsApp</button><button class="btn dark" data-act="rawbt">Cetak Bluetooth</button></div>' +
    '<div class="row3"><button class="btn sec sm" data-act="share">Bagikan…</button><button class="btn sec sm" data-act="copyrc">Salin</button><button class="btn sec sm" data-act="print">Cetak</button></div>' +
    '<details class="more"><summary>Lihat struk</summary><pre class="rc" id="rtxt"></pre></details><button class="btn pri big" data-act="close">Transaksi baru</button>');
  refreshRc();
}
function refreshRc() { // pratinjau + cetak browser: logo (bila aktif) di atas teks struk
  const el = $('#rtxt'); if (!el || !S.rc) return; const lg = logoOn(), u = lg ? logoURL(lg) : '', w = rcWidth();
  el.className = 'rc' + (w === 48 ? ' w48' : '');
  el.innerHTML = (u ? '<img class="lg-cv lg-rc" alt="Logo" src="' + u + '" style="width:' + logoPct(lg) + '">' : '') + docHtml(receiptDoc(S.rc, {w: w, rich: true, logo: lg}), w);
}

