# Pemantauan (v2.5.2)

## 1. Uptime (gratis): `.github/workflows/uptime.yml`
Tiap ~5 menit: panggil `rpc_schema_version` (API + database) dan `SITE_URL` (GitHub Pages). Tiga percobaan, jeda 15 detik; gagal = run merah (email GitHub) + Telegram bila diisi. Pemanggilan rutin juga menjaga proyek Supabase Free tidak di-pause.

Pengaturan satu kali (Settings → Secrets and variables → Actions):
| Jenis | Nama | Nilai |
|---|---|---|
| Variable | `SUPABASE_KEY` | publishable key (sudah ada untuk deploy) |
| Variable | `SUPABASE_URL` | opsional (bawaan dari `web/js/config.js`) |
| Variable | `SITE_URL` | mis. `https://akun.github.io/duado-pos/` |
| Secret | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | opsional: buat bot lewat @BotFather, ambil chat id dari `getUpdates` |

Batas yang perlu diketahui: jadwal GitHub dapat tertunda saat padat (bukan jaminan 5 menit tepat); repo publik tanpa aktivitas 60 hari menonaktifkan jadwal otomatis; ini mengukur ketersediaan dari luar, bukan kesehatan transaksi di tiap outlet. WhatsApp tidak dipakai karena API resminya berbayar; Telegram gratis.

Menghitung uptime bulanan: Actions → Uptime → jumlah run sukses / total run bulan itu (perkiraan kasar).

## 2. Galat klien
Menu → Diagnostik → "Sinkronisasi dan kesehatan aplikasi" (Owner/Admin/Auditor). SQL langsung (SQL Editor):
```sql
select kind, left(message, 80), count(*) n, count(distinct session_id) sesi, max(created_at)
from app.client_errors where created_at > now() - interval '7 days' and kind in ('error','promise')
group by 1, 2 order by n desc limit 20;
```

## 3. Realtime
Diagnostik menampilkan "Realtime tersambung" atau "Polling". Bila terus Polling: periksa Supabase → Realtime aktif, publikasi `supabase_realtime` memuat `public.sync_events` (`select * from pg_publication_tables where pubname = 'supabase_realtime'`), dan CSP `wss://*.supabase.co` ada di `web/index.html`.
