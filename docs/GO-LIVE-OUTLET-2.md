# Go-live outlet kedua (v2.4.0): konfigurasi P0

Dokumen ini melengkapi migrasi `20261030000023_p0_kontrol_laba_kas.sql`. Bagian 1 adalah item P0 "1 supervisor per outlet" (konfigurasi, bukan kode).

## 1. Satu supervisor per outlet
Tujuan: Owner tidak lagi menjadi satu-satunya penyetuju diskon/retur/hapus-antrean, dan kata sandi Owner tidak diketik di perangkat kasir.

1. Menu → Pengguna → **Tambah pengguna**. Peran `supervisor`, username unik (mis. `spv.out2`), PIN/kata sandi sesuai aturan aplikasi.
2. Pastikan outlet aktif di pemilih outlet adalah outlet yang dituju (peran dibuat untuk outlet aktif).
3. Supervisor dapat: menyetujui diskon di atas batas, retur, dan penghapusan transaksi antrean (PIN-nya di perangkat kasir); menerima transfer; menandai transaksi "perlu ditinjau" sebagai sudah ditinjau. Supervisor **tidak** melihat HPP/laba dan tidak membuka laporan Semua outlet.
4. Verifikasi (SQL Editor, hanya membaca): outlet aktif tanpa supervisor/admin/owner-outlet:
```sql
select o.code from public.outlets o
where o.status = 'active' and o.kind = 'store'
  and not exists (select 1 from public.memberships m join public.profiles p on p.id = m.user_id
                  where m.status = 'active' and p.status = 'active' and m.role = 'supervisor' and m.outlet_id = o.id);
```
Hasil harus kosong.

## 2. Keputusan kebijakan biaya vs HPP (F-06): sudah diterapkan, periksa pengaturan Anda
Kebijakan yang dipilih: **biaya pada kategori yang tercantum di Pengaturan → "Kategori biaya yang SUDAH masuk HPP" tidak dikurangkan lagi dari laba** (Beranda, Laba rugi, laporan Semua outlet). Ini sesuai janji teks di layar Pengaturan.
- Bila overhead/tenaga kerja **sudah dimasukkan ke resep/overhead produksi**, isi kategori itu di pengaturan tersebut (mis. `Listrik, Gas, Gaji/Tenaga kerja`). Biayanya tetap tercatat dan tampil di laporan Biaya, tetapi tidak mengurangi laba lagi.
- Bila TIDAK ingin memasukkan biaya ke HPP, kosongkan pengaturan itu **dan** jangan isi overhead/tenaga kerja di resep/pengaturan overhead.
- Jangan campur: satu jenis biaya harus masuk HPP **atau** biaya periode, bukan keduanya.

## 3. Pengaturan yang disarankan sebelum outlet kedua beroperasi
| Pengaturan | Nilai | Alasan |
|---|---|---|
| `retur_kasir` | `false` (bawaan) | Retur kasir wajib persetujuan supervisor/owner |
| `wajib_buka_kasir` | `true` (bawaan) | Retur dan penjualan tercatat pada laci yang benar |
| `tolak_selisih_total` | `true` (bawaan) | Transaksi online yang salah total tetap ditolak; transaksi offline tertunda diterima dengan tanda |

## 4. Perilaku baru yang perlu diketahui kasir dan Owner
- **Retur:** setiap item wajib dipilih "Baik, kembali ke stok" atau "Rusak / dibuang". Yang dibuang tidak menambah stok dan nilainya masuk **Kerugian persediaan** di Laba rugi.
- **Retur oleh kasir** memakai PIN Owner/Supervisor, tetapi uangnya tercatat di **laci kasir** (bukan sesi penyetuju).
- **Kas keluar laci** wajib pilih kategori dan otomatis menjadi biaya.
- **Transaksi offline** yang harga/stoknya berubah di server tidak lagi buntu: tercatat dengan harga server dan ditandai **Perlu ditinjau** (Riwayat → "Tandai ditinjau"; Beranda menampilkan jumlahnya). Selisih uang fisik vs sistem untuk transaksi itu terlihat di tutup kasir; total di struk tersimpan di `sales.client_total`.
- **Menghapus transaksi antrean** oleh kasir wajib PIN Owner/Supervisor dan dicatat di audit beserta penyetujunya.
- **Laporan → Semua outlet** (Owner/Admin/Auditor global): laba rugi per outlet berdampingan + biaya pusat, dan nilai stok semua outlet. Biaya pusat dibuat di Menu → Master → Biaya → "Dicatat pada: Pusat".

## 5. Urutan deploy
1. Backup/PITR aktif. 2. Jalankan migrasi `20261030000023` di staging, lalu `supabase/tests/run.sh` (memuat tes baru `002_p0_kontrol.test.sql`). 3. Produksi: pasang migrasi **sebelum** menerbitkan klien 2.4.0 (klien baru menolak berjalan pada skema lama; klien lama < 2.4.0 diminta memperbarui). 4. Opsional: `supabase/optional/backfill_kas_keluar_ke_biaya.sql`.
