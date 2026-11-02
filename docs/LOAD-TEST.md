# Load test `rpc_sale_create`

Harness: `tests/load/` (pgbench, tanpa dependensi npm). **Hanya untuk database uji kosong.**

```bash
createdb load
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/load
tests/load/prepare.sh                       # harness auth palsu + semua migrasi + seed + 10 outlet x 3 kasir x 30 varian
CLIENTS=12 ACTIVE_OUT=4 DURATION=15 tests/load/run.sh   # satu skenario -> satu baris JSON
psql "$DATABASE_URL" -f tests/load/integrity.sql         # konsistensi setelah beban
```
Variabel: `CLIENTS`, `ACTIVE_OUT` (outlet aktif), `PERCASH`, `NVAR` (varian; 1 = satu produk panas), `TRIGGERS=off` (matikan trigger sinyal),
`PREFILL_SYNC=N` (isi `sync_events` dengan N baris dahulu).

## Metode dan batas klaim
pgbench memanggil `rpc_sale_create` langsung di Postgres: transaksi, `set local role authenticated`, klaim JWT, dua baris keranjang.
Yang diukur adalah **waktu database**, bukan ujung-ke-ujung: tanpa PostgREST, jaringan, TLS, atau latensi perangkat.
Mesin uji: **1 inti CPU**, 4 GB RAM, Postgres 16 bawaan, dan pgbench berbagi inti yang sama. Angka absolut karenanya mendekati "server 1 inti yang jenuh";
Supabase paket gratis berbeda (2 vCPU berbagi, ARM), jadi **ulangi di staging sebelum memakai angka ini sebagai janji**.

## Hasil (15 dtk per skenario, trigger sinyal aktif, setelah perbaikan 0029)
| Klien | Outlet | tps | p50 ms | p95 ms | p99 ms | maks ms |
|---|---|---|---|---|---|---|
| 1 | 1 | 133 | 6,2 | 15,5 | 23,9 | 204 |
| 3 | 1 | 179 | 14,8 | 26,7 | 39,1 | 147 |
| 12 | 4 | 131 | 84 | 148 | 244 | 352 |
| 30 | 10 | 119 | 226 | 418 | 763 | 1119 |

- Kapasitas jenuh sekitar 120-180 penjualan/detik per inti. Dengan 1 inti dan 30 klien serempak, p99 masih < 1 dtk (maks 1,1 dtk). Beban nyata (satu kasir ~1 transaksi per beberapa detik) jauh di bawah ini.
- Antrean kunci terlihat saat beberapa kasir di satu outlet (baris counter nomor struk, `app.next_seq`): ada sesi menunggu `Lock`, tetapi latensinya tetap puluhan ms.
- Satu produk panas (`NVAR=1`) vs tersebar: tidak berbeda bermakna (143 vs 142 tps pada 12 klien).
- Trigger sinyal aktif vs nonaktif: tidak bisa dibedakan dari noise setelah 0029 (179 vs 166 tps, 3 klien). Putaran awal yang tampak "trigger 30% lebih lambat" ternyata noise/cache dingin; jangan dikutip.
- Integritas setelah 39.730 penjualan konkuren: saldo stok = awal - qty terjual untuk semua outlet/varian, nomor struk unik, semua penjualan berpembayaran.

## Temuan yang diperbaiki oleh load test
1. **0028 - penjualan terblokir setelah ke-999 per hari per outlet.** `lpad(v_seq::text, 3, '0')` memotong urutan >= 1000 (`1000` menjadi `100`) sehingga bentrok dengan struk ke-100; kegagalan permanen sampai tanggal lokal berganti (counter ikut rollback). Berlaku juga untuk retur, transfer, impor Shopee.
2. **0029 - `app.sync_signal` seq scan.** `clock_timestamp()` bersifat volatile sehingga kondisi waktu tidak bisa memakai indeks. Dengan 400 ribu baris `sync_events`: 14 tps (p50 205 ms) sebelum, 186 tps (p50 14 ms) sesudah.

## Yang belum diukur
Latensi ujung-ke-ujung lewat PostgREST/Supabase, beban di mesin Supabase sungguhan, dampak `pg_cron`/Realtime nyata, retur dan transfer di bawah beban, serta beban campuran (laporan berjalan saat penjualan).
