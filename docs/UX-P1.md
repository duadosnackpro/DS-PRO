# P1 UX (audit UI/UX v2.5.6) — dikerjakan di v2.5.7

| ID | Perubahan | Berkas utama |
|---|---|---|
| UX-01, UX-19 | `fail(pesan, kolom?)` untuk semua galat dan penolakan. Tanpa kolom: kotak `role="alert"` + tombol Tutup, bertahan sampai ditutup (di dalam sheet bila sheet terbuka, selain itu di `#errbar`). Dengan kolom: pesan di bawah kolom, `aria-invalid`, `aria-describedby`, fokus pindah; hilang saat kolom diubah. `toast()` kini hanya untuk sukses/info. | `01-inti.js`, `index.html`, `app.css`, semua pemanggil |
| UX-02 | Form Kas masuk/keluar: Jenis, Nominal (Rp), Kategori biaya, Alasan kini berlabel terlihat (select memakai `aria-labelledby`). Tombol "Catat kas". | `11-tutup-kasir.js` |
| UX-03 | Tombol Kembali: menutup sheet; dari sub-layar kembali ke layar asal/Menu; pengaturan belum disimpan minta Kembali dua kali; di layar utama "tekan sekali lagi untuk keluar". Pola perangkap satu entri riwayat, dipasang pada sentuhan pertama setelah masuk. | `139-navigasi.js` |

## Aturan memilih fail() atau toast()
Pesan bahwa aksi **gagal/ditolak/tidak bisa dilanjutkan** = `fail()`. Konfirmasi sukses dan info singkat = `toast()`.
Pengecualian sengaja: "Harga belum diatur / Stok habis / Stok tidak cukup" saat mengetuk produk (tombol sudah tampak nonaktif; banner permanen mengganggu saat ramai).
`tests/p1_ux.js` menggagalkan CI bila ada `toast(e.message)` atau pesan validasi ("Isi…", "Pilih…", "Alasan…") lewat `toast()`.

## Perilaku yang perlu diketahui
- Aksi baru (`busy()`) dan pindah layar membersihkan galat lama; render ulang latar belakang tidak.
- Banner di atas sementara menutupi badge sinkronisasi di header sampai ditutup.
- Galat dari server untuk form Data Master tetap berupa kotak galat (server tidak menyebut kolom), bukan inline.

## Belum terbukti (butuh perangkat nyata)
- Android PWA terpasang: Chrome mengabaikan entri riwayat yang dibuat tanpa interaksi pengguna. Perangkap sengaja dipasang pada sentuhan pertama; uji gestur Kembali di perangkat kasir sebenarnya (audit: UX-03 "Runtime test on Android").
- Pembaca layar (TalkBack/VoiceOver) atas `role="alert"` pada kotak galat dan pesan inline.
- Tes E2E Chromium untuk skenario ini dijalankan di luar repo dengan backend tiruan; belum menjadi bagian CI.
