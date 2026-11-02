# Sisa Pekerjaan setelah Rilis v2.5.4

Dokumen ini merangkum apa yang **belum** dikerjakan dari rekomendasi audit (Immediate Fixes + Medium poin 1), apa yang **belum terbukti**, dan sisa rekomendasi Medium/Strategic.

## A. Sudah dikerjakan di kode (tes lokal lulus)
| # | Item | Hasil |
|---|---|---|
| I-1 | Pelaporan galat klien | Migrasi `0026`, RPC `client_error_log`/`client_error_report`, hook di klien, kartu ringkasan di Menu → Diagnostik |
| I-2 | Uptime monitor | `.github/workflows/uptime.yml` + `docs/MONITORING.md` |
| I-3 | Pin versi | Semua GitHub Action dipin ke SHA; Supabase CLI dipin 2.121.0; CORS `admin-users` wajib (`ALLOWED_ORIGINS`) |
| I-5 (kompensasi) | PIN lebih panjang | PIN baru minimal 8 angka (`PIN_MIN_LENGTH`, bawaan 8) |
| M-1 | Sinkronisasi | Realtime lewat tabel sinyal `sync_events` + polling cadangan 45 dtk/3 mnt |
| – | CI | Menambah `test:rt` dan `test:bt`; tes SQL baru `005_observability_realtime` |

Hasil tes: SQL 5 rangkaian lulus (Postgres 16), release 55, adapter 109, Realtime 30 (baru), printer 44, Edge Function 16 (14 → 16), lint 0 error, typecheck 0 galat baru.

## B. Belum dikerjakan: butuh tindakan Anda (tidak bisa dari repo)
Urut dari yang paling mendesak.

1. **Isi Variable `ALLOWED_ORIGINS`** (mis. `https://akun.github.io`) di Settings → Secrets and variables → Actions. **Tanpa ini deploy produksi sengaja gagal** dan `admin-users` menolak semua permintaan browser. Opsional: `PIN_MIN_LENGTH`.
2. **Variable `SITE_URL`** dan, bila mau notifikasi, secret `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` untuk `uptime.yml`. Tanpa Telegram, hanya email GitHub saat run merah.
3. **Required reviewers** pada environment `production` (Settings → Environments). Ini pengaturan GitHub, bukan kode.
4. **Cadangan (I-4):** isi secret `BACKUP_DATABASE_URL` dan `BACKUP_PASSPHRASE` (environment `production`), jalankan `Actions → Backup` sekali, unduh artifact, dan **lakukan uji pemulihan di proyek Supabase staging**, lalu catat di tabel `docs/BACKUP-RESTORE.md`. Yang sudah dilakukan hanya uji prosedur di Postgres lokal.
5. **Hook penguncian akun (I-5):** buka Supabase → Authentication → Hooks → Password verification dan cek apakah tersedia di paket Anda. Bila tersedia, pilih `public.hook_password_verification_attempt`. Bila tidak, PIN 8 angka adalah satu-satunya kompensasi yang ada.
6. **Pg_cron / Realtime di dasbor:** aktifkan ekstensi `pg_cron` (Database → Extensions) bila ingin retensi terjadwal; pastikan Realtime aktif dan `select * from pg_publication_tables where pubname='supabase_realtime'` memuat `sync_events` setelah migrasi.
7. **Urutan rilis:** merge ke `main` → pipeline memasang migrasi `0026` sebelum situs terbit. Dianjurkan lewat staging dulu (lihat B-8).
8. **Cadangan yang tidak tercakup:** PITR (berbayar), foto produk di Supabase Storage, dan transaksi yang masih antre di perangkat kasir tetap di luar dump.

## C. Belum terbukti (ditulis dan diuji hanya secara lokal)
- **Load test hanya waktu database di mesin 1 inti**, tanpa PostgREST/jaringan. Ulangi `tests/load/run.sh` terhadap staging Supabase (database terpisah) sebelum menjanjikan < 1–2 dtk. Migrasi 0027–0029 belum dijalankan di Supabase nyata.
- **Laporan stockout**: definisi (item keluar dalam 60 hari, jam kalender) perlu disetujui pemilik usaha; belum dicoba dengan data nyata.
- **Realtime belum pernah dijalankan ke server Supabase sungguhan.** Protokol Phoenix (vsn 1.0.0), bentuk pesan `phx_join`, `access_token`, dan `postgres_changes` ditulis dari pengetahuan protokol dan diuji dengan WebSocket palsu. Uji di staging: buka dua perangkat, ubah harga di satu perangkat, amati yang lain dan layar Diagnostik ("Realtime tersambung"). Bila gagal, aplikasi otomatis memakai polling 45 detik, jadi tidak berbahaya, tetapi target ≤ 3 detik belum tercapai.
- **Latensi sinkronisasi belum diukur.** Perkiraan jalur: sinyal → jeda gabung 0,8 dtk → `ping` → muat ulang bagian yang berubah. Ukur sebelum mengklaim ≤ 3 detik. Jalur polling jelas tidak memenuhi target itu.
- **`supabase/setup-cli` v3 + CLI 2.121.0 belum dicoba di runner GitHub.** Tag `@v1` yang dipakai sebelumnya tidak ada lagi di repositori action; kemungkinan alur deploy lama sudah gagal sebelum perubahan ini. Jalankan sekali di staging.
- **Migrasi 0026 hanya diuji di Postgres biasa** (CI memakai harness `auth` palsu). Belum diuji: publikasi `supabase_realtime`, RLS pada Realtime nyata, `pg_cron`.
- **Beban trigger stok** (satu sinyal per outlet per 2 detik, satu baca-indeks per baris saldo yang berubah) belum diukur pada penjualan serentak. Load test (Medium #4) akan sekaligus memeriksa ini.
- **Definisi error rate:** "sesi bergalat / sesi yang melapor". Sesi yang crash sebelum sempat mengirim `boot`, atau perangkat yang selalu offline, tidak terhitung. Angkanya batas bawah, bukan angka pasti.

## D. Perubahan perilaku yang perlu diinformasikan ke tim
- PIN baru atau PIN yang diganti: minimal **8 angka** (10 maksimal). PIN 6 angka lama tetap bisa dipakai login sampai diganti.
- Kasir yang memakai versi lama aplikasi di cache akan tetap berjalan; banner "Muat ulang" muncul untuk 2.5.2.
- Layar Diagnostik menampilkan status sinkronisasi dan ringkasan galat 7 hari (Owner/Admin/Auditor).

## E. Medium #2–#4 (dikerjakan di v2.5.4) dan sisanya
- **#2 selesai:** laporan `stok_minimum` (stockout rate dari ledger) dan `lead_transfer` (migrasi 0027, tes SQL 006).
- **#3 selesai sebagian:** laporan `durasi_shift` (lama buka kasir, trx/jam, shift menggantung). Lama proses tutup kasir di layar belum terukur; butuh instrumentasi klien.
- **#4 selesai di sandbox 1 inti:** `tests/load/` dan `docs/LOAD-TEST.md`. Belum dibuktikan di Supabase/PostgREST (lihat C).
- **Cacat ditemukan dan diperbaiki oleh load test:** 0028 (penjualan terblokir setelah ke-999/hari/outlet) dan 0029 (seq scan di `sync_signal`, throughput turun ~12x pada 400 ribu baris). **Terapkan 0028 segera.**
- Tes SQL kini 8 rangkaian (006-008 baru); adapter 113; npm run check hijau.
5. ~~Telaah pemakaian `innerHTML`~~ selesai, lihat `docs/AUDIT-INNERHTML.md` (tidak ada input tanpa `esc()`; belum ada tes DOM otomatis). **Masih tersisa:** turunkan baseline 119 galat tipe dan 17 peringatan lint.

## F. Rekomendasi Strategic yang belum dikerjakan
1. Partisi/arsip `audit_logs`, `stock_movements`, `sales`, `sale_items`; pantau batas 500 MB paket gratis (tabel `client_errors` dan `sync_events` sudah dibatasi retensi).
2. Paket Supabase berbayar bila outlet > 5–10 atau perlu SLA (PITR, tanpa auto-pause): satu-satunya jalur ke uptime 99,9% yang bisa dipertanggungjawabkan.
3. Modul promo terpusat, kloning pengaturan antar-outlet, status pembayaran `pending/confirmed` (dicatat belum selesai di README F-10).
4. Instrumentasi adopsi (login, transaksi per kasir, waktu per transaksi) dan survei SUS per outlet.
5. Baseline biaya kertas, selisih kas, dan waktu rekonsiliasi untuk menghitung ROI/payback.
