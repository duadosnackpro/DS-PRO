-- Pemeriksaan konsistensi sesudah beban: tidak ada update stok yang hilang, nomor struk unik, tidak ada penjualan "perlu ditinjau" tak terduga.
-- Saldo awal tiap (outlet, varian) = 10.000.000 (setup.sql). Berhasil bila tiap saldo = 10.000.000 - total qty terjual outlet tsb.
\set ON_ERROR_STOP on
with x as (select b.outlet_id, b.variant_id from public.inventory_balances b join public.outlets o on o.id = b.outlet_id and o.code like 'LD-%'
      left join (select s.outlet_id, i.variant_id, sum(i.qty) as q from public.sale_items i join public.sales s on s.id = i.sale_id group by 1, 2) t
        on t.outlet_id = b.outlet_id and t.variant_id = b.variant_id
      where b.quantity <> 10000000 - coalesce(t.q, 0))
select case when count(*) = 0 then 'OK saldo stok = awal - qty terjual untuk semua outlet/varian beban'
            else 'GAGAL ' || count(*) || ' saldo tidak cocok, contoh outlet: ' || min(outlet_id::text) end as stok from x;
select case when (select count(*) from (select outlet_id, receipt_no from public.sales group by 1, 2 having count(*) > 1) d) = 0
            then 'OK nomor struk unik per outlet' else 'GAGAL ada nomor struk ganda' end as struk;
select case when (select count(*) from public.sales where review_flag) = 0 then 'OK tidak ada penjualan bertanda review'
            else 'PERHATIAN ' || (select count(*) from public.sales where review_flag) || ' penjualan bertanda review' end as review;
select case when (select count(*) from public.sales s where s.kind = 'sale' and not exists (select 1 from public.payments p where p.sale_id = s.id)) = 0
            then 'OK setiap penjualan punya pembayaran' else 'GAGAL penjualan tanpa pembayaran' end as bayar;
select 'penjualan total: ' || count(*) || ', baris ledger sale: ' || (select count(*) from public.stock_movements where movement_type = 'sale') as ringkas from public.sales;
