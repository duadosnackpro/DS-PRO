-- Angka kontrol data: jalankan di SQL Editor Supabase untuk memeriksa jumlah baris per tabel.
select 'sale' as k, count(*) filter (where kind = 'sale') as n, count(*) filter (where kind = 'return') as retur, sum(total) as total_bersih from public.sales where legacy_id is not null
union all select 'opening_produk', count(*), null, round(sum(value)) from public.stock_movements where movement_type = 'opening' and item_type = 'variant' and reference_type = 'migration'
union all select 'opening_bahan', count(*), null, round(sum(value)) from public.stock_movements where movement_type = 'opening' and item_type = 'material' and reference_type = 'migration'
union all select 'biaya', count(*), null, sum(amount) from public.expenses where legacy_id is not null;
-- Rekonsiliasi saldo vs ledger: jalankan sebagai owner di aplikasi/API:  select public.rpc_stock_reconcile('{}');  (harus 'jumlah': 0)
