-- Tes migrasi 0032 (integrity_check, aturan A7). Dijalankan setelah 001-010.
-- Skenario bersih dibuat lewat RPC ASLI (pembelian, produksi, penjualan) di outlet baru; lalu diperiksa bahwa
--   (1) data bersih lolos termasuk selisih pembulatan 4 desimal yang sah, (2) akses dibatasi, (3) lima mutasi sengaja terdeteksi pada kode yang tepat.
\set ON_ERROR_STOP on

create table if not exists t.ic (k text primary key, v uuid);
do $$
declare org uuid; o uuid; ch uuid; pr uuid; vk uuid; ma uuid; mb uuid; mc uuid; rid uuid; po jsonb; r jsonb; owner_ uuid := t.id('owner'); sr jsonb;
begin
  select id into org from public.organizations limit 1;
  insert into public.outlets (organization_id, code, name, kind) values (org, 'ICK-001', 'Outlet Integritas', 'store') returning id into o;
  insert into public.channels (name) values ('Kasir Integritas') returning id into ch;
  insert into public.products (name, category) values ('ZZ Integritas', 'Uji') returning id into pr;
  insert into public.product_variants (product_id, sku) values (pr, 'ZZIC-1') returning id into vk;
  insert into public.channel_prices (variant_id, channel_id, price) values (vk, ch, 12345);
  insert into public.materials (name, unit) values ('ZZ Bahan A', 'kg') returning id into ma;
  insert into public.materials (name, unit) values ('ZZ Bahan B', 'kg') returning id into mb;
  insert into public.materials (name, unit) values ('ZZ Bahan C', 'kg') returning id into mc;
  insert into public.recipes (variant_id, name, standard_yield, kind, labor_cost) values (vk, 'ZZ Resep Integritas', 20, 'batch', 0) returning id into rid;
  insert into public.recipe_items (recipe_id, material_id, qty) values (rid, ma, 1), (rid, mb, 0.5);
  insert into t.ic values ('o', o), ('ch', ch), ('vk', vk), ('ma', ma), ('mb', mb), ('mc', mc), ('rid', rid);

  perform t.login(owner_);
  -- Pembelian 1: ongkir dialokasikan (3 x 5000 + 7 x 3000, ongkir 10000)
  perform public.rpc_purchase_create(jsonb_build_object('outlet_id', o, 'request_id', 'req-ic-0001', 'ongkir', 10000, 'items', jsonb_build_array(
    jsonb_build_object('material_id', ma, 'qty', 3, 'harga_satuan', 5000), jsonb_build_object('material_id', mb, 'qty', 7, 'harga_satuan', 3000))));
  -- Pembelian 2: harga lain, tanpa ongkir (rata-rata tertimbang)
  perform public.rpc_purchase_create(jsonb_build_object('outlet_id', o, 'request_id', 'req-ic-0002', 'ongkir', 0, 'items', jsonb_build_array(
    jsonb_build_object('material_id', ma, 'qty', 2.5, 'harga_satuan', 5200))));
  -- Pembelian 3: ongkir TIDAK dialokasikan
  perform public.rpc_purchase_create(jsonb_build_object('outlet_id', o, 'request_id', 'req-ic-0003', 'ongkir', 700, 'alokasi_ongkir', false, 'items', jsonb_build_array(
    jsonb_build_object('material_id', mb, 'qty', 1, 'harga_satuan', 3100))));
  -- Pembelian 4: qty pecahan 4 desimal, harga 4 desimal, ongkir tidak habis dibagi (kasus pembulatan terburuk)
  perform public.rpc_purchase_create(jsonb_build_object('outlet_id', o, 'request_id', 'req-ic-0004', 'ongkir', 1234, 'items', jsonb_build_array(
    jsonb_build_object('material_id', ma, 'qty', 0.3333, 'harga_satuan', 7777.7777), jsonb_build_object('material_id', mb, 'qty', 2.1111, 'harga_satuan', 4444.4444),
    jsonb_build_object('material_id', mc, 'qty', 5, 'harga_satuan', 999.9999))));
  -- Produksi: 2 batch, hasil aktual 19 (beda dari standar 40), tenaga kerja dan overhead pecahan
  po := public.rpc_production_create(jsonb_build_object('kitchen_outlet_id', o, 'output_outlet_id', o, 'recipe_id', rid, 'jumlah_batch', 2));
  r := public.rpc_production_complete(jsonb_build_object('id', po ->> 'id', 'qty_hasil', 19, 'tenaga_kerja', 1234.56, 'overhead', 789.01));
  -- Penjualan: 3 x 12345 dengan diskon 500 (kasir wajib buka sesi lebih dulu)
  perform public.rpc_cash_open(jsonb_build_object('outlet_id', o, 'modal_awal', 50000));
  sr := public.rpc_sale_create(jsonb_build_object('outlet_id', o, 'request_id', 'req-ic-0005', 'channel_id', ch, 'metode_bayar', 'tunai',
    'items', jsonb_build_array(jsonb_build_object('variant_id', vk, 'qty', 3)), 'diskon', 500, 'total_klien', 36535, 'amount_received', 40000));
  -- Retur sebagian (1 unit, kembali ke stok) dan penjualan kedua yang diretur seluruhnya (tanpa restock): jalur bertanda negatif harus ikut lolos K2 dan K3
  perform public.rpc_sale_return(jsonb_build_object('outlet_id', o, 'request_id', 'req-ic-0006', 'id', sr -> 'sale' ->> 'id', 'alasan', 'salah input', 'restock', true,
    'items', jsonb_build_array(jsonb_build_object('variant_id', vk, 'qty', 1))));
  sr := public.rpc_sale_create(jsonb_build_object('outlet_id', o, 'request_id', 'req-ic-0007', 'channel_id', ch, 'metode_bayar', 'tunai',
    'items', jsonb_build_array(jsonb_build_object('variant_id', vk, 'qty', 2)), 'total_klien', 24690, 'amount_received', 25000));
  perform public.rpc_sale_return(jsonb_build_object('outlet_id', o, 'request_id', 'req-ic-0008', 'id', sr -> 'sale' ->> 'id', 'alasan', 'produk basi', 'restock', false, 'semua', true));
  perform t.logout();
end $$;

-- ===== Akses =====
do $$ declare e text; o uuid := (select v from t.ic where k = 'o'); begin
  perform t.logout();
  e := t.err('rpc_integrity_check', jsonb_build_object('outlet_id', o));
  perform t.ok(e like '28000%', 'tanpa sesi ditolak: ' || coalesce(e, 'NULL'));
  perform t.login(t.id('ka'));
  e := t.err('rpc_integrity_check', jsonb_build_object('outlet_id', t.id('o1')));
  perform t.ok(e like '42501%', 'kasir tidak boleh menjalankan pemeriksaan integritas: ' || coalesce(e, 'NULL'));
  perform t.logout(); perform t.login(t.id('ks'));
  e := t.err('rpc_integrity_check', jsonb_build_object('outlet_id', t.id('o1')));
  perform t.ok(e like '42501%', 'peran stok tidak boleh: ' || coalesce(e, 'NULL'));
  perform t.logout();
end $$;

-- ===== Data bersih lolos (termasuk selisih pembulatan yang sah) =====
do $$ declare r jsonb; o uuid := (select v from t.ic where k = 'o'); c jsonb; begin
  perform t.login(t.id('owner'));
  r := public.rpc_integrity_check(jsonb_build_object('outlet_id', o));
  perform t.logout();
  perform t.ok((r ->> 'ok')::boolean, 'data bersih lolos semua pemeriksaan: ' || (r -> 'pemeriksaan')::text);
  perform t.ok((r ->> 'total_pelanggaran')::int = 0, 'nol pelanggaran');
  for c in select * from jsonb_array_elements(r -> 'pemeriksaan') loop
    perform t.ok((c ->> 'diperiksa')::int > 0, 'pemeriksaan ' || (c ->> 'kode') || ' benar-benar memeriksa baris (diperiksa > 0)');
  end loop;
  perform t.ok(jsonb_array_length(r -> 'pemeriksaan') = 5, 'lima pemeriksaan K1..K5');
end $$;

-- ===== Lima mutasi sengaja harus terdeteksi pada kode yang tepat =====
create or replace function t.ic_run(mut text) returns jsonb language plpgsql as $$
declare o uuid := (select v from t.ic where k = 'o'); r jsonb; res jsonb;
begin
  begin
    execute 'set local session_replication_role = replica';   -- melewati trigger pelindung ledger hanya untuk menyuntikkan kerusakan di tes
    execute mut;
    execute 'set local session_replication_role = origin';
    perform t.login(t.id('owner'));
    r := public.rpc_integrity_check(jsonb_build_object('outlet_id', o));
    perform t.logout();
    res := r;
    raise exception 'undo';
  exception when others then
    if sqlerrm <> 'undo' then raise; end if;
  end;
  return res;
end $$;

do $$ declare r jsonb; o uuid := (select v from t.ic where k = 'o'); ma uuid := (select v from t.ic where k = 'ma'); function_ok boolean;
  procedure_dummy int;
begin
  r := t.ic_run(format($m$update public.inventory_material_balances set quantity = quantity + 1 where outlet_id = %L and material_id = %L$m$, o, ma));
  perform t.ok(not (r ->> 'ok')::boolean and (select (c ->> 'pelanggaran')::int from jsonb_array_elements(r -> 'pemeriksaan') c where c ->> 'kode' = 'K1') >= 1, 'M1 saldo diubah => K1 terdeteksi');

  r := t.ic_run(format($m$update public.stock_movements set value = value + 5 where id = (select max(id) from public.stock_movements where outlet_id = %L and movement_type = 'purchase')$m$, o));
  perform t.ok((select (c ->> 'pelanggaran')::int from jsonb_array_elements(r -> 'pemeriksaan') c where c ->> 'kode' = 'K2') >= 1, 'M2 nilai ledger diubah => K2 terdeteksi');

  r := t.ic_run(format($m$update public.sales set subtotal = subtotal + 100 where outlet_id = %L$m$, o));
  perform t.ok((select (c ->> 'pelanggaran')::int from jsonb_array_elements(r -> 'pemeriksaan') c where c ->> 'kode' = 'K3') >= 1, 'M3 subtotal penjualan diubah => K3 terdeteksi');

  r := t.ic_run(format($m$update public.purchase_items set effective_cost = effective_cost + 1 where id = (select i.id from public.purchase_items i join public.purchases p on p.id = i.purchase_id where p.outlet_id = %L limit 1)$m$, o));
  perform t.ok((select (c ->> 'pelanggaran')::int from jsonb_array_elements(r -> 'pemeriksaan') c where c ->> 'kode' = 'K4') >= 1, 'M4a biaya per satuan pembelian diubah => K4 terdeteksi');
  r := t.ic_run(format($m$update public.purchases set total = total + 50 where id = (select id from public.purchases where outlet_id = %L limit 1)$m$, o));
  perform t.ok((select (c ->> 'pelanggaran')::int from jsonb_array_elements(r -> 'pemeriksaan') c where c ->> 'kode' = 'K4') >= 1, 'M4b total pembelian diubah => K4 terdeteksi');

  r := t.ic_run(format($m$update public.production_costs set total = total + 10 where production_id in (select id from public.production_orders where kitchen_outlet_id = %L)$m$, o));
  perform t.ok((select (c ->> 'pelanggaran')::int from jsonb_array_elements(r -> 'pemeriksaan') c where c ->> 'kode' = 'K5') >= 1, 'M5 biaya produksi diubah => K5 terdeteksi');

  -- Setelah semua mutasi dibatalkan (subtransaksi), data kembali bersih
  perform t.login(t.id('owner'));
  r := public.rpc_integrity_check(jsonb_build_object('outlet_id', o));
  perform t.logout();
  perform t.ok((r ->> 'ok')::boolean, 'mutasi dibatalkan: data kembali bersih');
end $$;
select 'Tes integrity_check selesai' as hasil;
