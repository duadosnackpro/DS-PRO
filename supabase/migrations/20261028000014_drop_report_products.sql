-- 0014 Membuang rpc_report_products: laporan per produk/channel sudah dilayani rpc_report_legacy (0011), jadi fungsi ini hanya duplikat.
-- Aman dijalankan di database yang tidak pernah memilikinya.
drop function if exists public.rpc_report_products(jsonb);
drop function if exists app.report_products(jsonb);
