# P2 UX (audit UI/UX v2.5.6, fase 2 "Usability") — dikerjakan di v2.5.8

| ID | Perubahan | Berkas utama |
|---|---|---|
| UX-06 | `askConfirm(judul, pesan, labelOk, {danger, cancel})` menggantikan semua `confirm()` (9 di `src/app`, 5 di `modules.js`); tiga `prompt()` lama kini `askReason`. Konfirmasi di atas sheet yang sedang terbuka (form edit, detail transfer) **menahan** sheet itu dan memasangnya lagi apa adanya saat Batal, jadi isian tidak hilang. Esc, ketuk latar, dan Kembali = Batal. Tombol utama di atas, Batal di bawah; merah untuk hapus/tolak/batalkan. Takeover login memakai "Kirim" / "Batalkan masuk". | `01-inti.js`, `13-aksi.js`, `139-navigasi.js`, `modules.js`, semua pemanggil |
| UX-04 | Banner Kasir "Kasir belum dibuka." + "Buka kasir" membuka sheet modal awal langsung (2 ketukan + angka), tanpa pindah layar; keranjang utuh. Chip status di header ("Kasir buka" / "Kasir belum dibuka") ada di semua layar untuk peran yang menjual bila buka kasir diwajibkan; ketuk = buka kasir / ke Tutup kasir. Status tidak ditebak sebelum server menjawab. | `07-kasir-foto.js`, `11-tutup-kasir.js`, `06-kerangka.js` |
| UX-15 | Struk: WhatsApp + satu tombol cetak (Bluetooth bila perangkat bisa; selain itu "Cetak lewat browser"). Bagikan hanya bila ada Web Share. Salin dan cetak browser dilipat ke "Lainnya". "Transaksi baru" menempel di dasar sheet. Tombol terlihat tanpa membuka apa pun: 7 → 3. | `07-kasir-foto.js`, `app.css` |
| UX-11 | Pengaturan: 11 kartu → 3 halaman (Struk & printer 4, Penjualan 4, Data & biaya 3). Tetap SATU form: kartu lain hanya disembunyikan, jadi Simpan, penanda belum disimpan, dan Kembali berlaku untuk semuanya. | `10-menu-master-pengaturan.js`, `13-aksi.js` |

Perubahan kecil ikutan: teks antrean "Kasir belum dibuka" menunjuk ke tombol di atas layar; label struk "No. WhatsApp (opsional)" dan "Cetak lewat browser" (Bagian 6 baris 5, 8, 9, 22); `S.shiftOpen` kini baru diubah setelah server menjawab saat Tutup kasir (sebelumnya jadi `false` walau penutupan gagal).

## Aturan
- Konfirmasi: `await askConfirm(...)`. Isian teks: `askReason(..., {label, danger})`. Jangan memakai `confirm/prompt/alert`; `tests/p2_ux.js` menggagalkan CI. Satu-satunya `prompt(` tersisa adalah `ev.prompt()` (API pasang PWA, bukan dialog).
- Konfirmasi di tengah aksi `busy()`: bungkus dengan `busyPause(() => askConfirm(...))`, kalau tidak overlay menutupinya.

## Pengujian
- `npm run check`: lint (19 peringatan, sama seperti sebelumnya), typecheck 0 galat baru, semua tes lulus termasuk `tests/p2_ux.js` (41 pemeriksaan). Lima mutasi sengaja (confirm() kembali, sheet tak dipulihkan, 8 kartu satu halaman, tombol tak sticky, Esc tak menutup konfirmasi) semuanya tertangkap.
- `e2e_p2_chromium.py` (di luar CI, backend tiruan): 61 pemeriksaan lulus, termasuk 360 px, UA Android + Web Share, dan perangkat tanpa Bluetooth/Share.

## Belum terbukti / perlu Anda ketahui
- Belum diuji di perangkat kasir nyata dan pembaca layar (fokus ke dialog konfirmasi, `aria-current` pada tab halaman Pengaturan).
- Pemilihan "perangkat bisa Bluetooth" memakai deteksi fitur (Android, `navigator.bluetooth`, Web Serial). Perangkat yang mengaku mendukung tetapi printernya belum dipasangkan tetap melihat tombol Bluetooth.
- Chip header menambah satu baris kecil di header untuk peran yang menjual; badge sinkronisasi tidak tertutup (diperiksa di 360 px).
- Tidak dikerjakan di fase ini: UX-12/13 (konsolidasi badge dan gaya, fase 3), konten fase 4, UX-05/10/16.
