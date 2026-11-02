# Cadangan dan pemulihan (P0-4)

Sistem ini menyimpan ledger keuangan dan stok. Tiga lapis, dari yang tercepat sampai yang paling independen:

| Lapis | Apa | Pemulihan | Siapa mengaktifkan |
|---|---|---|---|
| 1. PITR Supabase | Pemulihan ke titik waktu mana pun (add-on berbayar, plan Pro ke atas) | menit–jam, ke titik sebelum kejadian | **Anda, di dasbor** (Project Settings → Add-ons → Point in Time Recovery) |
| 2. Backup harian Supabase | Snapshot harian (retensi tergantung plan) | restore dari dasbor | otomatis di plan Pro; cek **Database → Backups** |
| 3. Dump terenkripsi di luar Supabase | `.github/workflows/backup.yml` memanggil `tools/backup.sh`, harian 03:00 WIB, 30 hari di GitHub Artifacts (+ S3 opsional). Berisi dump, **manifest total kendali**, dan **foto produk** | `tools/restore.sh` (di bawah), diverifikasi sampai sen | secrets pada environment `production` (atau `staging` untuk latihan) |

Lapis 1 dan 2 tidak bisa diaktifkan dari repo; **centang di bawah setelah dikerjakan**. Lapis 3 sudah ada di repo, tetapi baru bekerja setelah secrets diisi.

## Daftar tugas satu kali
- [ ] PITR atau backup harian aktif di proyek **produksi** (catat tanggal dan plan: ________)
- [ ] Secrets `BACKUP_DATABASE_URL` (koneksi **langsung** port 5432 atau session pooler; **bukan** pooler mode transaksi 6543, snapshot tidak jalan di sana) dan `BACKUP_PASSPHRASE` diisi di environment `production`; passphrase disalin ke pengelola kata sandi
- [ ] Variable `SUPABASE_URL` (mis. `https://xxxx.supabase.co`) diisi. **Wajib bila ada foto produk**: bila kosong sementara bucket berisi foto, cadangan sengaja GAGAL (lebih baik gagal keras daripada diam-diam tanpa foto)
- [ ] Migrasi `0033` terpasang di produksi (tanpa itu cadangan gagal karena fungsi manifest belum ada, dan Diagnostik menampilkan "belum tersedia")
- [ ] `Actions → Backup → Run workflow` berhasil sekali; unduh artifact `duado-backup` (**tiga berkas**: `.dump.gpg`, `.manifest.json.gpg`, `.photos.tar.gpg` bila ada foto)
- [ ] **Uji pemulihan pertama** dijalankan lewat `Actions → Restore test → Run workflow` (memulihkan ke Postgres sementara di runner GitHub; hanya butuh `BACKUP_PASSPHRASE`). Tempel barisnya ke tabel catatan di bawah. **Sebelum impor katalog pertama di produksi** (Fase 4), harus ada uji yang SAH. Langkah lengkap, termasuk latihan di staging dulu: `docs/STAGING-FASE-1-2.md`

## Apa yang dijamin oleh satu cadangan
- **Satu snapshot.** Dump, manifest, daftar foto, dan hasil `integrity_check` dibaca dari keadaan database yang sama (transaksi `REPEATABLE READ` + `pg_dump --snapshot`). Penjualan yang masuk saat cadangan berjalan tidak membuat manifest dan dump saling berbeda.
- **Manifest** (`.manifest.json.gpg`, ikut terenkripsi karena memuat total keuangan): jumlah baris dan **hash isi** tiap tabel `public`/`app`, **total kendali** (penjualan, item penjualan, pembayaran, nilai persediaan, kuantitas dan nilai ledger per jenis, pembelian, biaya produksi, kas, biaya), sidik jari **hak akses dan RLS**, sidik jari **struktur** (konstrain termasuk FK/CHECK/UNIQUE, indeks, trigger, kolom, isi fungsi), versi migrasi, hasil `integrity_check` semua outlet, dan sha256 tiap foto. Angka uang disimpan sebagai teks dan dibandingkan sebagai desimal exact.
- **Uji dekripsi otomatis** sebelum cadangan dinyatakan berhasil, dan **status** (waktu, ukuran, jumlah tabel/foto, temuan integritas) dicatat di database; muncul di Menu → Diagnostik dengan peringatan merah bila lebih dari 36 jam atau percobaan terakhir gagal.

## Pulihkan ke staging (satu perintah) dan verifikasi
Lakukan ke proyek/DB **staging atau kosong**, jangan menimpa produksi.
```bash
export TARGET_DATABASE_URL='postgresql://...staging...'   # koneksi langsung
export BACKUP_PASSPHRASE='...'
# berkas duado-XXXX.manifest.json.gpg (dan .photos.tar.gpg) harus di folder yang sama dengan dump
tools/restore.sh --konfirmasi NAMA_DATABASE_STAGING duado-XXXX.dump.gpg
```
Skrip menolak bila: `--konfirmasi` tidak sama dengan nama database target, target sama dengan `BACKUP_DATABASE_URL`, manifest tidak ada, atau target sudah berisi penjualan (pakai `--timpa` bila sengaja). Opsi: `--semua-skema` (juga pulihkan `auth` dan `supabase_migrations`; untuk Postgres kosong/lokal), `--foto` (unggah foto; butuh `TARGET_SUPABASE_URL` dan `TARGET_SERVICE_KEY` milik proyek **target**), `--stub-auth` (buat akun pengganti di `auth.users` agar FK `profiles` terbentuk; lihat di bawah), `--buat-peran` (buat peran NOLOGIN yang disebut dump, untuk Postgres uji/CI), `--ketat` (lihat di bawah).

Pemulihan dinyatakan **sah hanya bila verifikasi (`tools/restore_verify.sh`) lolos**, bukan karena `pg_restore` tidak mengeluh. Verifikasi membandingkan target dengan manifest: baris dan hash isi tiap tabel, tiap total kendali (selisih Rp 0,01 pun gagal), hak akses/RLS, struktur (FK, indeks, trigger, kolom, fungsi), lalu menjalankan `integrity_check` di target. Putusannya:
- **SAH (bersih)**: semuanya cocok dan `integrity_check` nol temuan.
- **SAH, dengan N temuan integritas bawaan sumber (bukan bersih)**: semuanya cocok, tetapi sumber sendiri sudah punya N temuan saat dicadangkan (mis. saldo impor lama tanpa ledger). Pemulihan tidak menambah temuan. Ini bukan klaim bahwa datanya bersih; selesaikan temuannya di sumber. Pakai `--ketat` bila Anda hanya menerima nol mutlak.
- **TIDAK SAH**: ada selisih; daftar selisih dicetak. Jangan pakai database itu.
Skrip mencetak satu baris siap tempel untuk tabel catatan di bawah.

**Akun dan `--stub-auth`.** `public.profiles.id` berelasi ke `auth.users`. Bila target tidak memuat akun yang sama dengan sumber (staging atau Postgres kosong), FK itu gagal dibuat saat pemulihan: baris dan uang tampak sama, tetapi struktur tidak utuh. Verifikasi menandainya **TIDAK SAH** (sidik jari struktur berbeda); ini sengaja, karena versi sebelumnya meloloskan kasus itu. Tambahkan `--stub-auth` untuk membuat baris `auth.users` pengganti (id + email palsu `pemulihan-<id>@invalid.invalid`, tanpa kata sandi) bagi tiap id profil di dump. Akun pengganti tidak bisa dipakai login dan **tidak boleh** dipakai pada proyek berisi akun asli. Bila target sudah memuat akun yang sama, tidak perlu opsi ini.

Verifikasi ulang kapan saja pada database yang sudah dipulihkan: `TARGET_DATABASE_URL=... tools/restore_verify.sh manifest.json --skema public,app` (manifest = hasil dekripsi `.manifest.json.gpg` dengan `gpg -d`).

Pemulihan manual (tanpa skrip) tetap mungkin: `gpg -d` lalu `pg_restore --no-owner --clean --if-exists --schema=public --schema=app --dbname "$TARGET_DATABASE_URL"`. Hak akses ikut tersimpan di dump; **jangan** tambahkan `--no-privileges`, karena hak tabel/fungsi dan RLS yang hilang tidak terlihat dari jumlah baris (verifikasi akan menandainya). Cadangan lama yang dibuat sebelum v2.5.9 memakai `--no-privileges` dan tidak punya manifest, sehingga tidak dapat diverifikasi dengan skrip ini.

Setelah pulih: `supabase functions deploy admin-users`, arahkan `SUPABASE_URL`/`SUPABASE_KEY` hanya bila proyek berbeda, lalu login dan cek satu transaksi terakhir.

## Sasaran dan pembatasan
- RPO: dump harian = kehilangan sampai 24 jam data **bila hanya lapis 3**; dengan PITR mendekati nol.
- Transaksi yang masih antre di perangkat kasir (offline) tidak ada di database mana pun. Diagnostik menampilkan jumlahnya; jangan hapus data aplikasi atau berpindah perangkat sebelum nol. Transaksi **tidak** dapat dipulihkan dari aplikasi: memasukkan ulang penjualan atau ledger lewat UI melanggar aturan ledger hanya-menambah dan idempotensi.
- **Foto produk** kini ikut dicadangkan (bucket publik `product-photos`, diunduh lewat `SUPABASE_URL`) dan dapat dipulihkan dengan `--foto`.
- **Belum teruji di Supabase sungguhan:** pemulihan skema `auth` ke proyek yang sudah berisi akun (karena itu bawaan `restore.sh` hanya `public` dan `app`; akun PIN perlu dibuat ulang atau dipulihkan lewat PITR/backup Supabase), unggah foto ke Storage nyata, dan koneksi pooler. `--stub-auth` pada `auth.users` Supabase asli (kolom wajib bisa berbeda antar versi) juga belum teruji; jalur yang dianjurkan adalah workflow **Restore test** (Postgres sementara). Yang sudah diuji hanya Postgres 16 lokal dan server Storage tiruan (`tests/backup_e2e.sh`).

## Catatan uji pemulihan (isi setiap kuartal)
Tempel baris yang dicetak `tools/restore.sh`.
| Tanggal | Sumber (PITR / backup / dump) | Target | Hasil (putusan; selisih uang terbesar) | Durasi | Oleh |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

## Uji otomatis (CI)
`tests/backup_e2e.sh` (job `db`) membuktikan pada Postgres sungguhan: cadangan saat ada penulisan serentak tetap konsisten; pemulihan ke DB kosong dan ke DB bergaya Supabase SAH dengan selisih Rp 0; empat belas jenis kerusakan pada hasil pemulihan (selisih Rp 0,01 dengan jumlah baris sama, baris hilang, nama berubah, kuantitas ledger 0,0001, saldo rusak, hak dicabut, RLS dimatikan, kebijakan hilang, tabel asing, FK hilang, CHECK hilang, indeks hilang, trigger hilang, kolom ekstra, fungsi diubah) semuanya terdeteksi; target yang akunnya berbeda dinyatakan TIDAK SAH tanpa `--stub-auth` dan SAH dengan `--stub-auth`; peran yang hilang di target dinyatakan TIDAK SAH tanpa `--buat-peran`; pengaman menolak target/passphrase/dump yang salah; foto kembali byte demi byte. Ini **bukan** pengganti uji pemulihan ke staging Supabase Anda.
