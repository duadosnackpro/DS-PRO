# DUADO POS — backend Supabase (v2.5.6, multi-outlet)

Implementasi PRD "v2.0.0 → Multi-Outlet Ready", Fase 1–2 (+ pondasi Fase 4–5). Satu database melayani semua outlet; isolasi ditegakkan di database.

## Isi
| Berkas | Isi |
|---|---|
| `migrations/0001` | organisasi, **outlet** (toko/dapur), profil, **membership** (role per outlet), pengaturan, audit (immutable) |
| `0002` | katalog global, harga channel + override per outlet, **saldo per outlet**, **ledger stok immutable** |
| `0003` | penjualan, item (snapshot harga/HPP), pembayaran, **sesi kasir**, kas, biaya, impor |
| `0004` | pembelian, produksi + biaya (snapshot), **transfer stok** |
| `0005` | helper privat `app.*`: otorisasi, idempotensi, `stock_apply` (satu-satunya jalur ubah saldo) |
| `0006` | `sale_create` / `sale_batch` / `sale_return`, buka-tutup kasir, kas, biaya — **atomik + idempoten** |
| `0007` | administrasi outlet, anggota, opname, pembelian, produksi atomik, siklus transfer |
| `0008` | bootstrap/ping/stok/riwayat, pengaturan, laporan per outlet + konsolidasi, rekonsiliasi |
| `0009` | RLS, hak kolom (biaya disembunyikan), audit master, pembungkus `rpc_*`, `bootstrap_owner` |
| `0010`–`0012` | `transfer_create` dengan kunci idempoten opsional; **`dashboard`, `report_legacy` (8 jenis laporan, kecuali `hpp`), `production_list`, `recipe_save`** (keluaran berbentuk sama dengan UI v2.0.0); pengerasan `search_path` |
| `0022` | (menggantikan 0010–0011 yang hilang; diberi nomor baru agar bisa dipasang di database yang sudah di 0021) `dashboard`, `report_legacy` (8 jenis termasuk `hpp`), `production_list`, `recipe_save`; kontrak = indeks kolom di `web/js/modules.js` |
| `0021` | buka kasir wajib (default), modal awal saat BUKA, `sale_reject_log` (audit), penguncian akun (`hook_password_verification_attempt`), `user_unlock` |
| `0013` | `recipe_copy`: salin resep beserta bahannya secara atomik (owner/admin) |
| `0014` | membuang `rpc_report_products` (duplikat `report_legacy`) |
| `0015` | SKU otomatis, produk tambahan, saran overhead, impor Shopee |
| `0016` | `rpc_schema_version()`: versi skema untuk pemeriksaan deploy dan klien (P0-3) |
| `0017` | hash idempotensi `sale` mengabaikan `client_ts`+`kasir_id`; `app.purge_idempotency()` + jadwal `pg_cron`; persetujuan diskon dari server (`rpc_approval_issue`, `sale_create` menerima `approval_id`) |
| `0018` | pembatasan laju Edge Function (`rpc_admin_rate_hit`, hanya `service_role`) |
| `0026` | galat klien (`rpc_client_error_log`, `rpc_client_error_report`), tabel sinyal `sync_events` + trigger + publikasi Realtime (v2.5.2) |
| `functions/admin-users` | Edge Function pembuat akun PIN (satu-satunya pemakai `service_role`) |
| `tests/` | tes SQL (PRD §14.2) + `run.sh` |

## Pasang (staging dulu)
1. Buat proyek Supabase (staging). `supabase link`, lalu `supabase db push` (atau jalankan `migrations/*.sql` berurutan) dan `psql -f seed.sql`.
2. Auth: akun dibuat Edge Function dengan `email_confirm`, jadi konfirmasi email tidak dipakai. Atur panjang password minimum = 6 (PIN 6 angka) dan pastikan rate limit login aktif.
3. Buat owner pertama di Auth (`owner@users.duado.local`, password = PIN 6 angka), lalu: `select app.bootstrap_owner('<uuid>', 'owner', 'Nama Owner');`
4. `supabase functions deploy admin-users`.
5. Repo → Settings → Variables: `SUPABASE_KEY` (**publishable/anon, bukan service_role**); `SUPABASE_URL` opsional (default di `web/js/config.js`). Push ke `main`.
6. Isi katalog lewat menu aplikasi (bandingkan dengan `supabase/controls.sql` bila perlu), isi saldo pembukaan per outlet lewat Stok → Penyesuaian.

## Migrasi lewat pipeline (P0-3)
`.github/workflows/deploy.yml` menjalankan: uji → **migrasi staging** (bila environment `staging` ada) → **migrasi produksi** + `functions deploy admin-users` → `tools/verify_schema.js` → baru situs terbit. Bila migrasi atau verifikasi gagal, situs tidak terbit.
Klien (`sb-adapter.js`) memeriksa `rpc_schema_version` saat login/bootstrap: database lebih lama dari `MIN_SCHEMA` => aplikasi berhenti dengan pesan jelas; database mensyaratkan klien lebih baru (`min_client`) => minta pembaruan.

**Aturan saat menambah migrasi:** berkas baru `supabase/migrations/<timestamp>_nama.sql`; naikkan `MIN_SCHEMA` di `web/js/sb-adapter.js` bila klien baru membutuhkannya; naikkan `min_client` di `rpc_schema_version` (lewat `create or replace` di migrasi itu) bila klien lama jadi rusak. `tests/release_check.js` menjaga `MIN_SCHEMA` tetap menunjuk migrasi yang ada.

**Sekali saja untuk proyek yang dipasang manual** (SQL editor atau `psql`, bukan `db push`): riwayat migrasi Supabase masih kosong, sehingga `db push` mencoba memasang ulang semuanya dan gagal. Tandai yang sudah terpasang, sesuaikan daftar dengan isi `migrations/`:
```bash
supabase link --project-ref <ref>
supabase migration repair --status applied 20261027000001 20261027000002 ... 20261028000015   # semua kecuali 0016
supabase migration list                                                                      # lokal dan remote harus sejajar
```
Setelah itu push ke `main` akan memasang 0016 dan memverifikasinya. Secrets/variabel yang dibutuhkan ada di kepala `deploy.yml`.

## Cadangan dan pemulihan (P0-4)
Lihat **`docs/BACKUP-RESTORE.md`**: PITR/backup Supabase (diaktifkan di dasbor), dump terenkripsi harian (`.github/workflows/backup.yml`), prosedur pemulihan, dan tabel catatan uji pemulihan kuartalan.

## Tambah outlet (tanpa coding)
Menu → **Outlet** → Tambah (kode unik tak bisa dipakai ulang, tidak bisa dihapus bila dipakai) → Menu → Pengguna untuk menugaskan kasir → isi stok awal. Outlet nonaktif menolak transaksi baru; histori tetap terbaca.

## Tes
```bash
supabase start && DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres supabase/tests/run.sh   # Supabase lokal
PLAIN_PG=1 DATABASE_URL=postgresql://... supabase/tests/run.sh                                                    # Postgres biasa (CI memakai ini)
```
Jangan arahkan ke database berisi data. Tes memakai `rpc_*` sebagai pengguna `authenticated` sungguhan (RLS aktif).

## Catatan keamanan
- Klien hanya SELECT (dibatasi RLS). Tulis lewat RPC. `avg_cost`, `hpp_snapshot`, `unit_cost` tidak dapat dibaca langsung (hak kolom) → `select=*` pada tabel itu ditolak; adapter memilih kolom eksplisit.
- Setelah membuat tabel baru, jalankan ulang blok `revoke/grant` di 0009 (Data API Supabase bisa memberi grant otomatis).
- Menonaktifkan pengguna berlaku pada request berikutnya (RLS/RPC memeriksa status tiap kali), walau JWT lama belum kedaluwarsa.

## Pemetaan aksi UI → database (`web/js/sb-adapter.js`)
| Aksi UI | Dilayani oleh |
|---|---|
| `dashboard.get` | `rpc_dashboard` |
| `report.get` | `rpc_report_legacy` (jenis `hpp` belum tersedia; UI menampilkan pesannya) |
| `production.list` | `rpc_production_list` |
| `recipe.save` | `rpc_recipe_save`, lalu bahan dibaca ulang dari `recipe_items` (fungsi hanya mengembalikan header resep; `patchRecipe` di UI memerlukan `items`) |
| `recipe.copy` | `rpc_recipe_copy` |
| `master.list` (biaya) | REST `expenses` untuk outlet aktif (owner/admin/supervisor/auditor, sesuai RLS) |
| `stock.audit` | `rpc_stock_reconcile` + nama item dari `bootstrap` |
| `stock.reconcile` | sengaja ditolak: saldo selalu ditulis bersama ledger, jadi koreksi dilakukan lewat opname agar tercatat |

Aksi yang memang masih stub (jangan dianggap fitur): `sku.auto` (tidak dipanggil UI; SKU otomatis dibuat di klien), `archive.*`, dan laporan jenis `hpp`. Aksi yang sebelumnya tercatat "belum dipetakan" kini dilayani adapter: `setting.logo`, `produk.foto`, `addon.create`, `overhead.saran`, `shopee.import`; tambahan v2.3.2: `sale.lookup`, `override.grant` jenis `diskon`, `master.remove` (hapus sungguhan untuk harga channel).

## Operasi (v2.4.0)
**Retensi (P1-1).** `app.purge_idempotency(30)` menghapus `idempotency_keys` dan `approvals` lebih tua dari 30 hari (jendela transaksi offline hanya 72 jam). Dijadwalkan `pg_cron` 03:15 harian bila ekstensi tersedia; di Supabase aktifkan *Database → Extensions → pg_cron* lalu cek `select * from cron.job`. Tanpa `pg_cron`, jalankan fungsinya manual/terjadwal dari luar. `audit_logs` dan `stock_movements` sengaja tidak dipurge (jejak keuangan); pantau ukurannya: `select relname, pg_size_pretty(pg_total_relation_size(oid)) from pg_class where relname in ('audit_logs','stock_movements','sales','sale_items')`. Rencanakan partisi bulanan atau arsip ke tabel dingin bila salah satunya melewati beberapa juta baris.

**Antrean offline dan idempotensi (P1-2).** Hash `sale` tidak memuat `client_ts` dan `kasir_id`, jadi kiriman ulang Owner (ambil-alih) memperoleh hasil lama. Isi berbeda dengan `request_id` sama tetap ditolak (23505) secara sengaja: menjawab "sukses" akan menghilangkan transaksi kedua tanpa jejak. Klien memeriksa `sale.lookup` dulu pada 23505; bila transaksinya sudah ada, antrean dianggap selesai.

**Persetujuan diskon (P1-5).** Supervisor/owner memasukkan PIN di perangkat kasir; PIN diverifikasi Auth, server menerbitkan `approvals` (terikat `request_id` dan nominal, sekali pakai, berlaku 72 jam) dan token penyetuju langsung dibuang. Antrean hanya menyimpan id persetujuan, tidak ada JWT. Token `sbov:` dari versi lama otomatis dibuang dari antrean tersimpan; transaksi lama itu akan masuk "perlu ditinjau" bila diskonnya melebihi batas.

**Sesi dan token di klien (P1-4).** Refresh token ada di `localStorage` (`sb_rt`), access token di IndexedDB; token tidak lagi dijurnal ke `localStorage`. Logout menghapus `sb_rt`, `sb_outlet`, token, cache data; kotak "Perangkat bersama" di layar masuk juga menghapus nama pengguna terakhir dan preferensi (antrean TIDAK dihapus). Yang perlu Anda atur di dasbor Supabase (*Authentication → Sessions*): masa berlaku JWT pendek (mis. 3600 dtk), **Refresh token rotation** aktif, dan *time-box*/*inactivity timeout* sesuai kebutuhan (fitur plan tertentu).
*Perangkat hilang:* (1) Menu → Pengguna → nonaktifkan akun (memblokir refresh token lewat `ban_duration` dan menolak RPC pada permintaan berikutnya), (2) bila perlu *Authentication → Users → Sign out* pada akun itu, (3) ganti PIN, (4) transaksi yang masih di antrean perangkat itu tidak hilang dari server bila sudah terkirim; yang belum terkirim ada di perangkat.

**Edge Function `admin-users` (P1-6).** Impor memakai `npm:@supabase/supabase-js@2.45.4`. CORS: `supabase secrets set ALLOWED_ORIGINS=https://<akun>.github.io` (tanpa nilai ini tetap `*`). Batas 30 permintaan/menit per pemanggil (HTTP 429). `update` menerima `role`, `pin`, `status`, `nama` dalam satu permintaan; peran diterapkan lewat `rpc_membership_set` dengan JWT pemanggil. Tes: `deno test supabase/functions/admin-users/` (atau `node --experimental-strip-types --test supabase/functions/admin-users/authz_test.ts`).

## Penguncian akun (0021, F8) dan kata sandi Owner/Admin
Aktifkan sekali di dasbor: *Authentication -> Hooks -> Password verification* -> pilih fungsi `public.hook_password_verification_attempt`. Ketersediaan hook ini bergantung pada paket Supabase Anda; tanpa hook, penguncian tidak aktif (hanya rate limit Auth). 5 salah dalam 15 menit mengunci 15 menit (memanjang bila berulang); Owner/Admin membuka kunci di Menu -> Pengguna. Owner/Admin/Auditor wajib kata sandi >= 10 karakter (huruf+angka) lewat Edge Function; peran operasional tetap PIN 6-10 angka. Atur panjang password minimum di Auth ke 6 (PIN) dan biarkan Edge Function yang memperketat.

## Perubahan v2.4.0 (P0 hasil analisis v2.3.2)
Migrasi `20261030000023`: retur memakai sesi kasir + persetujuan sekali pakai (F-03); retur wajib memilih kembali-stok/rusak-dibuang dan kerugian persediaan masuk laba rugi (F-02/F-01, tabel `inventory_losses`); transaksi offline tertunda diterima dengan tanda `review_flag` dan hapus-antrean butuh persetujuan (F-04); kas keluar laci berkategori dan menjadi biaya (F-05); kategori `kategori_masuk_hpp` tidak dikurangkan lagi dari laba (F-06); `rpc_report_konsolidasi` untuk laporan semua outlet (F-07). Panduan konfigurasi: `docs/GO-LIVE-OUTLET-2.md`. `min_client` = 2.4.0.

## Perubahan v2.5.0 (P1 hasil analisis v2.3.2)
Migrasi `20261031000024` (min_client 2.5.0). Pengaturan baru (Menu → Pengaturan → Kontrol data): `opname_ambang_nilai` (bawaan 500000, kosong = nonaktif), `transfer_ambang_nilai` (kosong = nonaktif), `bayar_referensi_min` (kosong = referensi opsional). Kunci periode (khusus Owner) lewat `rpc_period_lock_set`; tidak dapat diubah lewat `settings_set`.

| Temuan | Perubahan |
|---|---|
| F-08 | Beranda menampilkan peringatan HPP kosong (`peringatan` berupa `{aksi, teks}`); produksi menolak bahan HPP 0 (supervisor/owner dapat melanjutkan dengan `izinkan_bahan_tanpa_harga`); `rpc_hpp_backfill` (pratinjau lalu terapkan; Owner/Admin; ditolak di periode terkunci; diaudit) |
| F-09 | Laporan Penjualan per produk: diskon dan PPN inklusif dialokasikan proporsional per baris (total = omzet laba rugi, termasuk data lama) |
| F-10 | `sale_create` menerima `referensi_bayar` (transfer/QRIS); referensi ganda menandai transaksi "perlu ditinjau"; laporan **Pembayaran per metode** |
| F-11 | Produksi lintas outlet butuh owner/admin/supervisor di outlet tujuan |
| F-12 | Laporan **Dalam perjalanan**; pemohon tidak boleh menyetujui sendiri transfer di atas `transfer_ambang_nilai` (selisih terima sudah menjadi kerugian sejak P0) |
| F-13 | Ambang opname bawaan; mengubah HPP yang sudah ada hanya supervisor/owner (saldo awal dan pengisian HPP kosong tetap boleh); laporan **Penyesuaian stok** per pelaku |
| F-14 | Zona waktu outlet untuk `price_of`, tanggal bawaan laporan/biaya, kas, `bootstrap.server_time`. Laporan lintas outlet memakai Asia/Jakarta untuk tanggal bawaan |
| F-15 | `client_ts` dipercaya hanya bila klien mengirim `offline: true` (percobaan ulang atau menunggu > 90 dtk); waktu tidak mendahului buka kasir; periode terkunci menolak biaya/impor Shopee dan menggeser transaksi tertunda ke waktu server (ditandai) |
| F-16 | `rpc_expense_void` (baris pembalik, tidak ada yang dihapus; biaya dari kas laci tidak bisa dibatalkan) dan `rpc_purchase_cancel` (stok dikurangi kembali, HPP dihitung ulang; ditolak bila bahan sudah terpakai) |
| F-17 | `rpc_cash_approve` terhubung (catatan wajib bila selisih; tidak boleh sesi sendiri), `rpc_shift_list` (nama kasir, sisa laci shift sebelumnya, status tinjauan), laporan **Selisih kas** |

**Belum dikerjakan dari F-10:** status pembayaran `pending/confirmed` masih bawaan `confirmed` (hanya referensi dan laporan rekonsiliasi). Tes SQL baru: `tests/003_p1_kontrol.test.sql` (jalankan lewat `run.sh` di staging).

## Perubahan v2.5.1: reset data transaksi per outlet
Migrasi `20261031000025`. `rpc_data_reset` (aksi klien `data.reset`) khusus Owner dan hanya berlaku untuk outlet aktif. Tanpa `terapkan` fungsi ini hanya menghitung (pratinjau). Untuk menghapus: `terapkan=true`, `konfirmasi` = kode outlet, `alasan` minimal 3 huruf, `request_id`, dan `stok` = `nol` (bawaan) atau `pertahankan` (jumlah dan HPP tetap, ditulis ulang sebagai mutasi `opening`).
Dihapus: penjualan, pembayaran, impor Shopee, sesi dan mutasi kas, biaya outlet, pembelian, produksi, transfer yang menyentuh outlet, kerugian persediaan, ledger stok, penghitung nomor struk, persetujuan diskon. Tetap: master data, pengguna, pengaturan, `audit_logs` (reset dicatat di sana) dan kunci idempotensi.
Ditolak bila ada transfer berjalan (submitted/approved/sent) atau periode terkunci. Trigger anti-hapus pada `stock_movements` dan `inventory_losses` dimatikan hanya di dalam transaksi fungsi ini. Layar: Menu, Hati-hati, Reset data transaksi.

## Perubahan v2.5.2: observabilitas, Realtime, pengerasan operasional
Migrasi `20261031000026` (tidak menaikkan `min_client`; klien lama tetap berjalan).

**Galat klien (KPI error rate).** Klien melapor `error`/`promise` tak tertangani, `boot` (awal sesi) dan `rt` (Realtime putus) lewat `rpc_client_error_log` (maks 20 per panggilan, 60 per pengguna per menit, pesan dipotong 300 karakter, stack 1000). Tidak dihitung sebagai galat sesi: galat printer/foto, penolakan bisnis dari server, jaringan putus. Retensi 30 hari (pembersihan oportunistik + `pg_cron` bila ada). Owner/Admin/Auditor melihat ringkasan 7 hari di Menu → Diagnostik (`rpc_client_error_report`: sesi, sesi bergalat, persen, galat teratas). Target < 0,1% sesi.

**Realtime.** Klien mendengarkan INSERT pada `public.sync_events` saja (id, outlet_id, kind `cat`/`stock`, waktu; tanpa data bisnis) dan menjalankan `ping` versi yang sudah ada, lalu memuat ulang bagian yang berubah. Tabel bisnis sengaja TIDAK dipublikasikan: Realtime tidak menghormati hak kolom sehingga `avg_cost` (HPP) akan terkirim ke kasir. Sinyal dibuat trigger pada `products`, `product_variants`, `channels`, `channel_prices`, `outlet_prices`, `settings` (kind `cat`, semua outlet) dan `inventory_balances` (kind `stock`, per outlet, digabung per 2 detik, insert-only supaya penjualan serentak tidak saling mengunci). Cadangan: bila Realtime tidak tersambung, polling 45 detik; bila tersambung, jaring pengaman 3 menit. Matikan dengan `CONFIG.REALTIME = false`. CSP `connect-src` menambah `wss://*.supabase.co`. Di dasbor Supabase pastikan *Database → Replication/Realtime* tidak menonaktifkan publikasi `supabase_realtime`; migrasi menambahkan `sync_events` otomatis.

**Edge Function `admin-users`.** (1) `ALLOWED_ORIGINS` WAJIB: kosong = semua permintaan ber-Origin ditolak 403 (sebelumnya `*`). `deploy.yml` mengisinya dari Variable repo `ALLOWED_ORIGINS` dan menggagalkan deploy produksi bila kosong. (2) PIN akun operasional minimal 8 angka (bawaan; ubah lewat secret/Variable `PIN_MIN_LENGTH` 6-10). PIN 6 angka lama tetap bisa login; aturan baru berlaku saat PIN dibuat/diganti. Ini kompensasi bila hook penguncian akun (0021) tidak tersedia di paket Anda.

**CI/CD.** Semua action dipin ke SHA commit; Supabase CLI dipin `2.121.0` lewat `supabase/setup-cli` v3 (tag `v1` yang dipakai sebelumnya tidak ada lagi di repositori action). Workflow baru `uptime.yml` (lihat `docs/MONITORING.md`). CI kini juga menjalankan `test:rt` dan `test:bt`.
