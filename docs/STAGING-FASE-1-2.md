# Panduan staging Fase 1 + Fase 2 (GitHub Desktop)

Tujuan: memasang Fase 1 (`integrity_check`, vektor uang) dan Fase 2 (cadangan + pemulihan terverifikasi) ke **staging** dulu, membuktikan cadangan bisa dipulihkan, baru ke produksi.

**Aturan keselamatan, baca sekali:**
- Push ke `main` otomatis menjalankan Deploy: staging, lalu **produksi**, lalu terbit situs. Jangan commit atau push langsung ke `main`; lewat Pull Request setelah staging lolos.
- Menjalankan Deploy manual dari cabang lain hanya menyentuh staging, **asal berkas `deploy.yml` di cabang itu sudah yang baru** (ada baris `if: github.ref == 'refs/heads/main'` pada job `migrate` dan `deploy`). Karena itu `deploy.yml` baru harus sudah ter-push di cabang sebelum Deploy dijalankan (langkah A).
- Bila job **Pasang migrasi ... di produksi** muncul berjalan atau meminta persetujuan saat Anda menguji dari cabang: **Reject/Cancel**, jangan disetujui.

## Prasyarat yang sudah Anda penuhi
Environment `staging` memiliki variabel `SUPABASE_PROJECT_REF`, `SUPABASE_URL`, `SUPABASE_KEY` dan secrets `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, terhubung ke proyek Supabase **terpisah** dari produksi.

## Sebelum mulai: periksa deployment produksi yang merah
Di halaman repo tertera **production** dengan tanda X merah. Buka **Actions → Deploy**, cari jalan terakhir yang gagal, dan baca job mana serta pesan galatnya (umumnya `ALLOWED_ORIGINS` kosong, secret production kurang, atau migrasi gagal). Perbaiki penyebabnya **sebelum** merge ke `main`, karena merge akan menjalankan job yang sama lagi. Bila tidak jelas, kirim pesan galatnya.

## A. Siapkan cabang (GitHub Desktop)
1. Buka GitHub Desktop, pilih repositori **DS-PRO**. Klik **Fetch origin**.
2. **Current Branch → ux-p1-p2**. Menu **Branch → Update from main** (cabang ini tertinggal 1 commit). Selesaikan bila ada konflik. Lalu tab **History** dan lihat berkas apa yang diubah commit dari `main` itu; catat, dipakai di langkah 5.
3. **Current Branch → New Branch**, nama `fase-1-2`, basis `ux-p1-p2`. **Create Branch**. (Cabang baru menjaga `ux-p1-p2` tetap bersih.)
4. **Repository → Show in Explorer**. Aktifkan **View → Show → Hidden items** (folder `.github` tersembunyi; bila tidak ikut tersalin, workflow tidak terpasang). Ekstrak `DS-PRO-v2_5_9-F1F2-overlay.zip`, salin **isi** zip (folder `.github`, `docs`, `src`, `supabase`, `tests`, `tools`, `web`, dan `package.json`) ke folder repo, pilih **Replace the files in the destination**.
5. Kembali ke GitHub Desktop, tab **Changes**. Harus tampak tepat 32 berkas, termasuk `.github/workflows/restore-test.yml`, `supabase/migrations/20261101000032_integrity_check.sql` dan `20261101000033_backup_manifest_status.sql`. Bila commit dari `main` (langkah 2) mengubah salah satu berkas yang juga ada di daftar ini, klik berkas itu dan pastikan perubahan dari `main` tidak hilang; bila ragu, kirim daftarnya.
6. Isi Summary: `Fase 1+2: integrity_check, vektor uang, cadangan dan pemulihan terverifikasi (v2.5.9)`. Klik **Commit to fase-1-2**, lalu **Publish branch**.
7. Di GitHub: **Actions → CI**, jalan untuk cabang `fase-1-2`. Job `check` dan `db` harus **hijau**. Bila merah, buka job yang gagal dan kirim barisnya.

## B. Pasang ke staging
1. **Actions → Deploy → Run workflow**, **Branch: fase-1-2** → Run workflow.
2. Hasil yang benar: `test` ✓, `migrate-staging` ✓, dan `migrate` serta `deploy` berstatus **skipped** (abu-abu). Bila `migrate` berjalan: batalkan.
3. Periksa di Supabase staging (**SQL Editor**):
   ```sql
   select max(version) from supabase_migrations.schema_migrations;   -- harus 20261101000033
   select proname from pg_proc where proname in ('rpc_integrity_check','rpc_backup_manifest','rpc_backup_status');   -- 3 baris
   ```
4. Staging **harus punya satu owner aktif** (pengguna dengan peran `owner` berstatus aktif di `memberships`). Tanpa itu `integrity_check` tidak dapat berjalan dan pemulihan dinyatakan TIDAK SAH dengan alasan "tidak ada owner aktif". Itu bukan kerusakan cadangan.

## C. Cadangan staging + uji pemulihan
1. Supabase staging → **Connect** → **Session pooler** (port **5432**). Salin connection string: `postgresql://postgres.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres`. Karakter khusus pada password harus di-URL-encode (`@` jadi `%40`, `#` jadi `%23`). Jangan pakai pooler mode transaksi (6543). Koneksi langsung (`db.<ref>.supabase.co`) memakai IPv6 dan biasanya tidak terjangkau dari runner GitHub.
2. GitHub → **Settings → Environments → staging → Add environment secret**: `BACKUP_DATABASE_URL` (string di atas) dan `BACKUP_PASSPHRASE` (frasa panjang acak; **simpan salinannya di pengelola kata sandi**, tanpa ini cadangan tidak bisa dibuka).
3. **Actions → Backup → Run workflow**, Branch `fase-1-2`, `lingkungan` = **staging**, centang **uji_pemulihan** → Run.
4. Hasil yang benar: job `dump` ✓ (artefak `duado-backup` berisi `.dump.gpg` dan `.manifest.json.gpg`), job `uji-pemulihan` ✓. Buka ringkasan job tersebut: harus ada baris `PUTUSAN: SAH (bersih)` atau `SAH, dengan N temuan integritas bawaan sumber`, dan `Selisih uang terbesar: Rp 0`.
5. Bila `dump` gagal soal foto: isi Variable `SUPABASE_URL` pada environment staging (sudah ada untuk Deploy). Bila gagal soal koneksi atau snapshot: kirim pesannya; jangan ganti ke port 6543.
6. Bila `uji-pemulihan` TIDAK SAH, **itu informasi, bukan kegagalan alat**: daftar `SELISIH` menyebut persis apa yang berbeda. Kirimkan.

## D. Ke produksi (setelah B dan C lolos, dan deployment produksi merah sudah dipahami)
1. GitHub Desktop: **Branch → Create Pull Request** (basis `main`, pembanding `fase-1-2`). Tunggu CI hijau, lalu **Merge**.
2. Merge menjalankan Deploy otomatis: staging, produksi, terbit. Pantau di **Actions**. Migrasi 0032 dan 0033 hanya menambah (tidak mengubah tabel lama), rollback ada di laporan fase.
3. Isi secrets `BACKUP_DATABASE_URL` dan `BACKUP_PASSPHRASE` di environment **production** (session pooler proyek produksi), dan pastikan Variable `SUPABASE_URL` ada.
4. **Actions → Backup → Run workflow**, `lingkungan` = production, centang **uji_pemulihan**. Cadangan produksi hanya membaca data (menulis satu baris status di `app.backup_runs`). Data hanya ada di runner sementara.
5. Tempel baris dari ringkasan (`| tanggal | dump ... |`) ke tabel catatan di `docs/BACKUP-RESTORE.md`. **Itu menutup kriteria Fase 2.** Sesudahnya baru Fase 3.

## Yang tidak dibuktikan oleh alur ini
Foto produk (tidak ikut diuji pulih di workflow; butuh Storage target), login akun asli (akun pengganti tanpa kata sandi), dan pemulihan penuh ke proyek Supabase. Untuk kecelakaan sungguhan, lapis PITR/backup Supabase tetap jalur utama (lihat `docs/BACKUP-RESTORE.md`).
