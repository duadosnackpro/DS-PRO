# Telaah pemakaian `innerHTML` (Medium #5, bagian 1)

Tanggal: 2026-10-31 · Cakupan: `src/app/*.js` dan `web/js/modules.js` (± 95 kemunculan `innerHTML`).

## Metode
1. Pindai statis semua `innerHTML`/`sheet()`: setiap sisipan `' + ekspresi + '` dicek apakah dibungkus `esc()` atau fungsi format angka/tanggal (`rp`, `num`, `dec`, `qf`, `pct`, `idDate`, ...).
2. Pindai kedua: kolom data milik pengguna (`nama`, `catatan`, `alasan`, `supplier`, `sku`, `nomor`, `email`, `error`, ...) yang disisipkan ke HTML tanpa `esc()`.
3. Tinjau manual setiap temuan.

## Hasil
- 17 + 12 temuan heuristik, **semuanya aman** setelah ditinjau: angka hasil hitung, konstanta internal, keluaran fungsi yang sendirinya sudah memakai `esc()` (`outletLabel`, `heroHtml`, `kpi`, `cartInner`), atau teks yang dipasang lewat `textContent` (`toast`).
- Tidak ditemukan input pengguna yang masuk ke HTML tanpa `esc()`. `esc()` (01-inti.js) mengganti `& < > " '`, cukup untuk konteks teks dan atribut berkutip.

## Keterbatasan (belum terbukti)
- Pemindai berbasis pola, bukan parser. Ekspresi di tengah rantai yang dibangun lintas baris, atau template literal, bisa terlewat.
- Belum ada tes otomatis yang memasukkan `<img src=x onerror=...>` ke nama produk, catatan, dan nama outlet lalu memeriksa DOM. Itu langkah berikutnya.
- Tidak mencakup Edge Function maupun SQL.

## Belum dikerjakan
- Menurunkan baseline 119 galat tipe (typecheck) dan 17 peringatan lint. ESLint tidak terpasang di lingkungan ini (tanpa jaringan).
