# Cadangan dan pemulihan (P0-4)

Sistem ini menyimpan ledger keuangan dan stok. Tiga lapis, dari yang tercepat sampai yang paling independen:

| Lapis | Apa | Pemulihan | Siapa mengaktifkan |
|---|---|---|---|
| 1. PITR Supabase | Pemulihan ke titik waktu mana pun (add-on berbayar, plan Pro ke atas) | menit–jam, ke titik sebelum kejadian | **Anda, di dasbor** (Project Settings → Add-ons → Point in Time Recovery) |
| 2. Backup harian Supabase | Snapshot harian (retensi tergantung plan) | restore dari dasbor | otomatis di plan Pro; cek **Database → Backups** |
| 3. Dump terenkripsi di luar Supabase | `.github/workflows/backup.yml`, harian 03:00 WIB, 30 hari di GitHub Artifacts (+ S3 opsional) | restore manual (di bawah) | secrets pada environment `production` |

Lapis 1 dan 2 tidak bisa diaktifkan dari repo; **centang di bawah setelah dikerjakan**. Lapis 3 sudah ada di repo, tetapi baru bekerja setelah secrets diisi.

## Daftar tugas satu kali
- [ ] PITR atau backup harian aktif di proyek **produksi** (catat tanggal dan plan: ________)
- [ ] Secrets `BACKUP_DATABASE_URL` dan `BACKUP_PASSPHRASE` diisi di environment `production`; passphrase disalin ke pengelola kata sandi
- [ ] `Actions → Backup → Run workflow` berhasil sekali, artifact `duado-backup` terunduh
- [ ] **Uji pemulihan pertama** dilakukan dan dicatat di tabel bawah

## Pulihkan dari dump terenkripsi
Lakukan ke proyek/DB **kosong** (proyek Supabase staging, atau Postgres lokal), jangan menimpa produksi sebelum yakin.
```bash
# 1. Unduh artifact duado-backup (Actions → run → Artifacts), lalu dekripsi
gpg --batch --pinentry-mode loopback --passphrase "$BACKUP_PASSPHRASE" -o duado.dump -d duado-XXXX.dump.gpg
# 2. Daftar isi (uji keterbacaan)
pg_restore --list duado.dump | head
# 3. Pulihkan. Pada Supabase, skema auth/storage sudah ada: pulihkan data, jangan buat ulang skema bawaan.
pg_restore --no-owner --no-privileges --clean --if-exists --dbname "$TARGET_DATABASE_URL" duado.dump
# 4. Jalankan ulang blok revoke/grant di migrations/*_rls_grants.sql bila hak tabel berubah
# 5. Periksa: jumlah baris dan versi skema
psql "$TARGET_DATABASE_URL" -c "select count(*) from public.sales" -c "select count(*) from public.stock_movements" -c "select public.rpc_schema_version()"
```
Setelah pulih: `supabase functions deploy admin-users`, arahkan `SUPABASE_URL`/`SUPABASE_KEY` hanya bila proyek berbeda, lalu login dan cek satu transaksi terakhir.
Pemulihan `auth.users` ke proyek Supabase yang sudah punya data auth dapat bentrok; uji prosedur ini di staging sebelum perlu.

## Sasaran dan pembatasan
- RPO: dump harian = kehilangan sampai 24 jam data **bila hanya lapis 3**; dengan PITR mendekati nol.
- Transaksi yang masih antre di perangkat kasir (offline) tidak ada di database mana pun; jangan hapus data aplikasi di perangkat sebelum antrean kosong.
- Dump tidak berisi berkas di Supabase Storage (foto produk). Foto dapat diunggah ulang dari menu; bila penting, salin bucket secara terpisah.

## Catatan uji pemulihan (isi setiap kuartal)
| Tanggal | Sumber (PITR / backup / dump) | Target | Hasil (baris sales/ledger cocok?) | Durasi | Oleh |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
