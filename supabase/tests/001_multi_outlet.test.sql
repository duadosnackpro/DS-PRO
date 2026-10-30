-- Tes integrasi database DUADO POS (PRD 14.2). Jalankan: supabase/tests/run.sh
-- Setiap blok DO gagal keras (raise exception) bila ekspektasi tidak terpenuhi.
\set ON_ERROR_STOP on
create schema if not exists t;
create or replace function t.ok(c boolean, m text) returns void language plpgsql as $$ begin if not coalesce(c, false) then raise exception 'GAGAL: %', m; end if; end $$;
create or replace function t.login(u uuid) returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claim.sub', u::text, true); execute 'set local role authenticated'; end $$;
create or replace function t.logout() returns void language plpgsql as $$ begin execute 'reset role'; perform set_config('request.jwt.claim.sub', '', true); end $$;
-- Menjalankan RPC dan menangkap pesan galat (NULL = berhasil)
create or replace function t.err(f text, p jsonb) returns text language plpgsql as $$ begin
  execute format('select public.%I($1)', f) using p; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
grant usage on schema t to public;
grant execute on all functions in schema t to public;

-- ===== Data uji (dibuat sebagai superuser) =====
create table if not exists t.ids (k text primary key, v uuid);
truncate t.ids;
do $$
declare owner_ uuid := gen_random_uuid(); ka uuid := gen_random_uuid(); kb uuid := gen_random_uuid(); ks uuid := gen_random_uuid();
  o1 uuid; o2 uuid; kit uuid; org uuid; ch uuid; pr uuid; v1 uuid; v2 uuid; m1 uuid;
begin
  insert into auth.users (id, email) values (owner_, 'owner@t'), (ka, 'ka@t'), (kb, 'kb@t'), (ks, 'ks@t');
  select id into org from public.organizations limit 1;
  select id into o1 from public.outlets where code = 'OUT-001';
  insert into public.outlets (organization_id, code, name) values (org, 'OUT-002', 'Outlet Dua') returning id into o2;
  insert into public.outlets (organization_id, code, name, kind) values (org, 'KTC-001', 'Dapur Pusat', 'kitchen') returning id into kit;
  perform app.bootstrap_owner(owner_, 'owner', 'Owner Uji');
  insert into public.profiles (id, username, full_name) values (ka, 'kasir.a', 'Kasir A'), (kb, 'kasir.b', 'Kasir B'), (ks, 'stok.a', 'Stok A');
  insert into public.memberships (user_id, outlet_id, role) values (ka, o1, 'kasir'), (kb, o2, 'kasir'), (ks, o1, 'stok');
  insert into public.channels (name) values ('Kasir Toko') returning id into ch;
  insert into public.products (name, category) values ('Basreng', 'Snack') returning id into pr;
  insert into public.product_variants (product_id, sku, size, spice_level) values (pr, 'BSR-100-L2', '100g', '2') returning id into v1;
  insert into public.product_variants (product_id, sku, size, spice_level) values (pr, 'BSR-200-L2', '200g', '2') returning id into v2;
  insert into public.channel_prices (variant_id, channel_id, price) values (v1, ch, 10000), (v2, ch, 18000);
  insert into public.materials (name, unit) values ('Tepung', 'kg') returning id into m1;
  insert into public.recipes (variant_id, name, standard_yield) values (v1, 'Resep Basreng', 10);
  insert into public.recipe_items (recipe_id, material_id, qty) select id, m1, 2 from public.recipes where name = 'Resep Basreng';
  insert into t.ids values ('owner', owner_), ('ka', ka), ('kb', kb), ('ks', ks), ('o1', o1), ('o2', o2), ('kit', kit), ('ch', ch), ('v1', v1), ('v2', v2), ('m1', m1);
end $$;
create or replace function t.id(k text) returns uuid language sql stable as $$ select v from t.ids where k = $1 $$;
grant select on t.ids to public;
-- Tes T1-T17 menjual tanpa membuka kasir (perilaku auto-buka). Default produksi kini wajib buka kasir (F4); T19 menguji default itu.
update public.settings set value = 'false' where key = 'wajib_buka_kasir' and outlet_id is null;

-- Saldo pembukaan oleh owner: outlet1 v1=5 v2=3 (HPP 6000/11000), outlet2 v1=2
do $$ begin
  perform t.login(t.id('owner'));
  perform public.rpc_stock_adjust(jsonb_build_object('outlet_id', t.id('o1'), 'tipe', 'varian', 'id', t.id('v1'), 'stok_baru', 5, 'hpp', 6000, 'alasan', 'saldo awal'));
  perform public.rpc_stock_adjust(jsonb_build_object('outlet_id', t.id('o1'), 'tipe', 'varian', 'id', t.id('v2'), 'stok_baru', 3, 'hpp', 11000, 'alasan', 'saldo awal'));
  perform public.rpc_stock_adjust(jsonb_build_object('outlet_id', t.id('o2'), 'tipe', 'varian', 'id', t.id('v1'), 'stok_baru', 2, 'hpp', 6000, 'alasan', 'saldo awal'));
  perform t.logout();
end $$;

-- ===== T1 penjualan atomik: stok, ledger, pembayaran, nomor struk =====
do $$ declare r jsonb; q numeric; begin
  perform t.login(t.id('ka'));
  r := public.rpc_sale_create(jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-00000001', 'channel_id', t.id('ch'), 'metode_bayar', 'tunai',
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 2)), 'total_klien', 20000, 'amount_received', 25000));
  perform t.logout();
  perform t.ok((r -> 'sale' ->> 'total')::numeric = 20000, 'total dihitung server');
  perform t.ok((r ->> 'kembalian')::numeric = 5000, 'kembalian 5000');
  perform t.ok((r -> 'sale' ->> 'nomor') ~ '^OUT-001-[0-9]{6}-001$', 'format nomor struk: ' || (r -> 'sale' ->> 'nomor'));
  select quantity into q from public.inventory_balances where outlet_id = t.id('o1') and variant_id = t.id('v1');
  perform t.ok(q = 3, 'stok outlet1 v1 = 3');
  perform t.ok((select quantity from public.inventory_balances where outlet_id = t.id('o2') and variant_id = t.id('v1')) = 2, 'stok outlet2 tidak berubah');
  perform t.ok((select count(*) from public.stock_movements where movement_type = 'sale' and outlet_id = t.id('o1')) = 1, 'ledger penjualan tercatat');
  perform t.ok((select hpp_snapshot from public.sale_items limit 1) = 6000, 'snapshot HPP tersimpan');
end $$;

-- ===== T2 rollback: item kedua kurang stok => tidak ada data parsial =====
do $$ declare e text; before_n int; q numeric; begin
  select count(*) into before_n from public.sales;
  perform t.login(t.id('ka'));
  e := t.err('rpc_sale_create', jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-00000002', 'channel_id', t.id('ch'), 'metode_bayar', 'qris',
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 1), jsonb_build_object('variant_id', t.id('v2'), 'qty', 99))));
  perform t.logout();
  perform t.ok(e is not null and e like '%tidak cukup%', 'ditolak karena stok: ' || coalesce(e, 'NULL'));
  select quantity into q from public.inventory_balances where outlet_id = t.id('o1') and variant_id = t.id('v1');
  perform t.ok(q = 3, 'stok v1 tidak berkurang (rollback)');
  perform t.ok((select count(*) from public.sales) = before_n, 'tidak ada penjualan parsial');
  perform t.ok(not exists (select 1 from app.idempotency_keys where key = 'req-00000002'), 'kunci idempotensi ikut rollback');
end $$;

-- ===== T3/T4 idempotensi =====
do $$ declare r1 jsonb; r2 jsonb; e text; p jsonb; begin
  p := jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-00000003', 'channel_id', t.id('ch'), 'metode_bayar', 'qris',
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 1)));
  perform t.login(t.id('ka'));
  r1 := public.rpc_sale_create(p); r2 := public.rpc_sale_create(p);
  e := t.err('rpc_sale_create', p || jsonb_build_object('diskon', 500));
  perform t.logout();
  perform t.ok((r2 ->> 'duplicate')::boolean, 'retry menandai duplicate');
  perform t.ok(r1 -> 'sale' ->> 'id' = r2 -> 'sale' ->> 'id', 'retry mengembalikan transaksi yang sama');
  perform t.ok((select count(*) from public.sales where request_id = 'req-00000003') = 1, 'hanya satu transaksi');
  perform t.ok((select quantity from public.inventory_balances where outlet_id = t.id('o1') and variant_id = t.id('v1')) = 2, 'stok berkurang sekali');
  perform t.ok(e like '23505%', 'kunci sama + payload beda ditolak: ' || coalesce(e, 'NULL'));
end $$;

-- ===== T6 isolasi outlet =====
do $$ declare e text; n int; begin
  perform t.login(t.id('ka'));   -- kasir outlet 1
  e := t.err('rpc_sale_create', jsonb_build_object('outlet_id', t.id('o2'), 'request_id', 'req-00000010', 'channel_id', t.id('ch'),
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 1))));
  perform t.ok(e like '42501%', 'kasir A tidak boleh jual di outlet 2: ' || coalesce(e, 'NULL'));
  select count(*) into n from public.inventory_balances where outlet_id = t.id('o2');
  perform t.ok(n = 0, 'kasir A tidak melihat saldo outlet 2');
  select count(*) into n from public.outlets;
  perform t.ok(n = 1, 'kasir A hanya melihat outletnya');
  e := t.err('rpc_stock_get', jsonb_build_object('outlet_id', t.id('o2')));
  perform t.ok(e like '42501%', 'stock_get outlet lain ditolak');
  e := t.err('rpc_outlet_create', jsonb_build_object('code', 'HACK-1', 'name', 'Hack'));
  perform t.ok(e like '42501%', 'kasir tidak bisa membuat outlet');
  begin insert into public.sales (outlet_id, receipt_no, request_id, channel_id, cashier_id, subtotal, total, payment_method)
        values (t.id('o1'), 'X', 'req-x', t.id('ch'), t.id('ka'), 1, 1, 'tunai'); perform t.ok(false, 'insert langsung harus ditolak');
  exception when insufficient_privilege then null; end;
  begin update public.inventory_balances set quantity = 999; perform t.ok(false, 'update saldo langsung harus ditolak');
  exception when insufficient_privilege then null; end;
  begin perform avg_cost from public.inventory_balances; perform t.ok(false, 'kolom biaya tidak boleh dibaca');
  exception when insufficient_privilege then null; end;
  perform t.logout();
  perform t.login(t.id('kb'));
  select count(*) into n from public.sales; perform t.ok(n = 0, 'kasir B tidak melihat penjualan outlet 1');
  perform t.logout();
end $$;

-- ===== T7 pengguna/outlet nonaktif =====
do $$ declare e text; begin
  perform t.login(t.id('owner'));
  perform public.rpc_profile_set_status(jsonb_build_object('user_id', t.id('kb'), 'status', 'inactive'));
  perform t.logout();
  perform t.login(t.id('kb'));
  e := t.err('rpc_sale_create', jsonb_build_object('outlet_id', t.id('o2'), 'request_id', 'req-00000020', 'channel_id', t.id('ch'),
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 1))));
  perform t.ok(e like '42501%', 'kasir nonaktif ditolak pada request berikutnya: ' || coalesce(e, 'NULL'));
  perform t.logout();
  perform t.login(t.id('owner'));
  perform public.rpc_profile_set_status(jsonb_build_object('user_id', t.id('kb'), 'status', 'active'));
  perform public.rpc_outlet_update(jsonb_build_object('id', t.id('o2'), 'status', 'inactive'));
  perform t.logout();
  perform t.login(t.id('kb'));
  e := t.err('rpc_sale_create', jsonb_build_object('outlet_id', t.id('o2'), 'request_id', 'req-00000021', 'channel_id', t.id('ch'),
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 1))));
  perform t.ok(e like '%tidak aktif%', 'outlet nonaktif menolak transaksi: ' || coalesce(e, 'NULL'));
  perform t.logout();
  perform t.login(t.id('owner'));
  perform public.rpc_outlet_update(jsonb_build_object('id', t.id('o2'), 'status', 'active'));
  perform t.logout();
end $$;

-- ===== T8 retur sebagian/penuh =====
do $$ declare s jsonb; r jsonb; e text; sid uuid; begin
  perform t.login(t.id('owner'));
  s := public.rpc_sale_create(jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-00000030', 'channel_id', t.id('ch'), 'metode_bayar', 'tunai',
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v2'), 'qty', 2)), 'diskon', 1000));
  sid := (s -> 'sale' ->> 'id')::uuid;
  r := public.rpc_sale_return(jsonb_build_object('request_id', 'req-ret-0001', 'id', sid, 'alasan', 'rusak', 'restock', true,
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v2'), 'qty', 1))));
  perform t.ok((r ->> 'refund')::numeric = 17500, 'refund proporsional 17500, dapat ' || (r ->> 'refund'));
  e := t.err('rpc_sale_return', jsonb_build_object('request_id', 'req-ret-0002', 'id', sid, 'alasan', 'lagi', 'restock', true,
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v2'), 'qty', 2))));
  perform t.ok(e like '%melebihi sisa%', 'retur berlebih ditolak: ' || coalesce(e, 'NULL'));
  r := public.rpc_sale_return(jsonb_build_object('request_id', 'req-ret-0003', 'id', sid, 'alasan', 'sisanya', 'semua', true, 'restock', true));
  perform t.ok((r ->> 'refund')::numeric = 17500, 'retur terakhir mengambil sisa nilai (total retur = 35000-1000)');
  perform t.ok((select sum(total) from public.sales where id = sid or ref_sale_id = sid) = 0, 'transaksi + retur = 0');
  perform t.ok((select quantity from public.inventory_balances where outlet_id = t.id('o1') and variant_id = t.id('v2')) = 3, 'stok kembali penuh');
  perform t.logout();
end $$;

-- ===== T9 tutup kasir =====
do $$ declare c jsonb; e text; begin
  perform t.login(t.id('ka'));
  e := t.err('rpc_cash_close', jsonb_build_object('uang_fisik', 1));
  perform t.ok(e like '%selisih%', 'selisih tanpa catatan ditolak: ' || coalesce(e, 'NULL'));
  c := public.rpc_cash_close(jsonb_build_object('uang_fisik', 20000 + 0, 'modal_awal', 0, 'catatan', 'uji selisih'));
  perform t.ok((c ->> 'jumlah_trx')::int = 2, 'dua transaksi pada sesi');
  perform t.ok((c ->> 'tunai_diharapkan')::numeric = 20000, 'tunai diharapkan = 20000 (QRIS tidak masuk laci)');
  perform t.ok((c ->> 'selisih_tunai')::numeric = 0, 'selisih 0');
  perform t.logout();
end $$;

-- ===== T10 transfer stok =====
do $$ declare tr jsonb; id_ uuid; e text; begin
  perform t.login(t.id('owner'));
  tr := public.rpc_transfer_create(jsonb_build_object('request_id', 'req-trf-0001', 'from_outlet_id', t.id('o1'), 'to_outlet_id', t.id('o2'), 'ajukan', true,
         'items', jsonb_build_array(jsonb_build_object('item_type', 'variant', 'item_id', t.id('v2'), 'qty', 2))));
  id_ := (tr ->> 'id')::uuid;
  e := t.err('rpc_transfer_action', jsonb_build_object('id', id_, 'action', 'send'));
  perform t.ok(e like '%belum disetujui%', 'kirim sebelum disetujui ditolak');
  perform public.rpc_transfer_action(jsonb_build_object('id', id_, 'action', 'approve'));
  perform public.rpc_transfer_action(jsonb_build_object('id', id_, 'action', 'send'));
  e := t.err('rpc_transfer_action', jsonb_build_object('id', id_, 'action', 'send'));
  perform t.ok(e like '%P0001%', 'kirim ganda ditolak');
  perform t.ok((select quantity from public.inventory_balances where outlet_id = t.id('o1') and variant_id = t.id('v2')) = 1, 'stok asal berkurang saat dikirim');
  perform public.rpc_transfer_action(jsonb_build_object('id', id_, 'action', 'receive',
          'items', jsonb_build_array(jsonb_build_object('item_type', 'variant', 'item_id', t.id('v2'), 'qty_received', 1))));
  perform t.ok((select quantity from public.inventory_balances where outlet_id = t.id('o2') and variant_id = t.id('v2')) = 1, 'stok tujuan bertambah sesuai diterima');
  perform t.ok((select variance from public.stock_transfer_items where transfer_id = id_) = 1, 'selisih transfer tercatat = 1');
  perform t.ok((select -sum(quantity_delta) from public.stock_movements where reference_type = 'transfer' and reference_id = id_) = 1, 'ledger: keluar-masuk = selisih');
  e := t.err('rpc_transfer_create', jsonb_build_object('from_outlet_id', t.id('o1'), 'to_outlet_id', t.id('o1'),
        'items', jsonb_build_array(jsonb_build_object('item_type', 'variant', 'item_id', t.id('v2'), 'qty', 1))));
  perform t.ok(e like '%tidak boleh sama%', 'asal = tujuan ditolak');
  perform t.logout();
end $$;

-- ===== T11 produksi atomik =====
do $$ declare po jsonb; e text; r jsonb; begin
  perform t.login(t.id('owner'));
  po := public.rpc_production_create(jsonb_build_object('kitchen_outlet_id', t.id('kit'), 'output_outlet_id', t.id('kit'),
        'recipe_id', (select id from public.recipes limit 1), 'jumlah_batch', 2));
  e := t.err('rpc_production_complete', jsonb_build_object('id', po ->> 'id', 'qty_hasil', 20));
  perform t.ok(e like '%belum punya harga%', 'bahan tanpa harga => produksi ditolak (P1 F-08): ' || coalesce(e, 'NULL'));
  e := t.err('rpc_production_complete', jsonb_build_object('id', po ->> 'id', 'qty_hasil', 20, 'izinkan_bahan_tanpa_harga', true));
  perform t.ok(e like '%tidak cukup%', 'bahan kurang => produksi gagal: ' || coalesce(e, 'NULL'));
  perform t.ok((select status from public.production_orders where id = (po ->> 'id')::uuid) = 'planned', 'status tetap planned');
  perform t.ok(not exists (select 1 from public.stock_movements where reference_type = 'production'), 'tidak ada mutasi parsial');
  perform public.rpc_purchase_create(jsonb_build_object('outlet_id', t.id('kit'), 'request_id', 'req-buy-0001', 'ongkir', 0,
        'items', jsonb_build_array(jsonb_build_object('material_id', t.id('m1'), 'qty', 10, 'harga_satuan', 5000))));
  r := public.rpc_production_complete(jsonb_build_object('id', po ->> 'id', 'qty_hasil', 20, 'tenaga_kerja', 0, 'overhead', 0));
  perform t.ok((r -> 'costs' ->> 'total')::numeric = 20000, 'biaya bahan 4kg x 5000 = 20000');
  perform t.ok((r -> 'variant' ->> 'stok')::numeric = 20, 'hasil masuk 20');
  e := t.err('rpc_production_complete', jsonb_build_object('id', po ->> 'id', 'qty_hasil', 20));
  perform t.ok(e like '%sudah berstatus%', 'tidak bisa selesai dua kali');
  perform t.logout();
end $$;

-- ===== T12 administrasi outlet =====
do $$ declare o jsonb; e text; begin
  perform t.login(t.id('owner'));
  o := public.rpc_outlet_create(jsonb_build_object('code', 'OUT-003', 'name', 'Outlet Tiga', 'request_id', 'req-out-0003'));
  e := t.err('rpc_outlet_create', jsonb_build_object('code', 'OUT-003', 'name', 'Lagi'));
  perform t.ok(e like '23505%', 'kode ganda ditolak');
  perform t.ok((select count(*) from public.inventory_balances where outlet_id = (o ->> 'id')::uuid) = 0, 'outlet baru tanpa stok');
  perform public.rpc_outlet_update(jsonb_build_object('id', o ->> 'id', 'name', 'Outlet Tiga B', 'code', 'HACK'));
  perform t.ok((select code from public.outlets where id = (o ->> 'id')::uuid) = 'OUT-003', 'kode tidak dapat diubah');
  perform t.logout();
  begin delete from public.outlets where code = 'OUT-003'; perform t.ok(false, 'hapus outlet harus ditolak');
  exception when sqlstate '23000' then null; end;
end $$;

-- ===== T13 ledger tetap, rekonsiliasi, laporan konsolidasi =====
do $$ declare rep jsonb; rec jsonb; sum_ numeric; begin
  begin update public.stock_movements set note = 'x'; perform t.ok(false, 'ledger harus tidak dapat diubah');
  exception when sqlstate '23000' then null; end;
  perform t.login(t.id('owner'));
  rec := public.rpc_stock_reconcile('{}'::jsonb);
  perform t.ok((rec ->> 'jumlah')::int = 0, 'saldo = ledger di semua lokasi: ' || rec::text);
  rep := public.rpc_report_sales(jsonb_build_object('from', current_date - 1, 'to', current_date + 1));
  select sum((x ->> 'penjualan_bersih')::numeric) into sum_ from jsonb_array_elements(rep -> 'per_outlet') x;
  perform t.ok(sum_ = (rep -> 'total' ->> 'penjualan_bersih')::numeric, 'total konsolidasi = jumlah outlet');
  perform t.logout();
  perform t.login(t.id('ka'));
  perform t.ok(t.err('rpc_report_sales', '{}'::jsonb) like '42501%', 'kasir tidak boleh laporan semua outlet');
  perform t.logout();
end $$;

-- ===== T14 SKU otomatis, produk tambahan, saran overhead, impor Shopee (migrasi 0015) =====
do $$ begin
  perform t.ok(app.sku_abbr('Makaroni Pedas') = 'MP' and app.sku_abbr('Basreng') = 'BSR' and app.sku_abbr('Kantong Kresek') = 'KK' and app.sku_abbr('') = 'PRD', 'singkatan nama produk');
  perform t.ok(app.sku_size('80 gr') = '80GR' and app.sku_size('1,5 kg') = '15KG' and app.sku_size('Besar') = 'B', 'singkatan ukuran');
  perform t.ok(app.sku_level('Level 3') = 'L3' and app.sku_level('03') = 'L3' and app.sku_level('') = '', 'singkatan level pedas');
end $$;
do $$ declare ch uuid; p1 uuid; a uuid; b uuid; r jsonb; ad jsonb; e text; n int; begin
  insert into public.channels (name, fee_percent) values ('Shopee', 10) returning id into ch;
  insert into public.channel_prices (variant_id, channel_id, price) values (t.id('v1'), ch, 12000);
  perform t.login(t.id('owner'));
  insert into public.products (name, category) values ('Makaroni Pedas', 'Snack') returning id into p1;
  insert into public.product_variants (product_id, sku, size, spice_level) values (p1, null, '80 gr', 'Level 3') returning id into a;
  insert into public.product_variants (product_id, sku, size, spice_level) values (p1, '', '80 gr', 'Level 3') returning id into b;
  perform t.ok((select sku from public.product_variants where id = a) = 'MP-80GR-L3', 'SKU kosong diisi otomatis');
  perform t.ok((select sku from public.product_variants where id = b) = 'MP-80GR-L3-2', 'SKU otomatis tidak bentrok (-2)');

  ad := public.rpc_addon_create(jsonb_build_object('outlet_id', t.id('o1'), 'nama', 'Kantong Kresek', 'harga', 500, 'hpp', 100, 'stok', 50));
  perform t.ok(ad ->> 'sku' = 'KK', 'SKU produk tambahan otomatis');
  perform t.ok((select category from public.products where id = (ad ->> 'product_id')::uuid) = 'Tambahan', 'kategori Tambahan');
  perform t.ok((select count(*) from public.channel_prices where variant_id = (ad ->> 'variant_id')::uuid) = (select count(*) from public.channels where active), 'harga untuk semua channel aktif');
  perform t.ok((select quantity from public.inventory_balances where outlet_id = t.id('o1') and variant_id = (ad ->> 'variant_id')::uuid) = 50, 'stok awal produk tambahan');
  perform t.ok(t.err('rpc_addon_create', jsonb_build_object('outlet_id', t.id('o1'), 'nama', 'X', 'harga', 1)) like '22023%', 'nama terlalu pendek ditolak');

  r := public.rpc_shopee_import(jsonb_build_object('outlet_id', t.id('o1'), 'abaikan_stok', true, 'orders', jsonb_build_array(
        jsonb_build_object('order_id', 'SP-1', 'tanggal', '2026-09-01 10:15:00', 'items', jsonb_build_array(
          jsonb_build_object('sku', 'bsr-100-l2', 'qty', 2, 'harga', 11000), jsonb_build_object('sku', 'KK', 'qty', 3, 'harga', ''))),
        jsonb_build_object('order_id', 'SP-2', 'items', jsonb_build_array(jsonb_build_object('sku', 'TIDAK-ADA', 'qty', 1))),
        jsonb_build_object('order_id', 'SP-1', 'items', jsonb_build_array(jsonb_build_object('sku', 'BSR-100-L2', 'qty', 1))))));
  perform t.ok((r ->> 'ok')::int = 1 and (r ->> 'duplikat')::int = 1 and jsonb_array_length(r -> 'gagal') = 1, 'impor: 1 masuk, 1 duplikat, 1 gagal: ' || r::text);
  perform t.ok(r -> 'gagal' -> 0 ->> 'order_id' = 'SP-2', 'pesanan gagal tidak membatalkan yang lain');
  perform t.ok((select total from public.sales where request_id = 'shopee:SP-1') = 22000 + 1500, 'total impor memakai harga berkas dan harga channel');
  perform t.ok((select (sold_at at time zone 'Asia/Jakarta')::text from public.sales where request_id = 'shopee:SP-1') = '2026-09-01 10:15:00', 'tanggal asli pesanan dipakai');
  perform t.ok((select cash_session_id from public.sales where request_id = 'shopee:SP-1') is null, 'impor tidak masuk sesi kasir');
  perform t.ok((select count(*) from public.sales where request_id = 'shopee:SP-2') = 0, 'pesanan gagal tidak tercatat');
  r := public.rpc_shopee_import(jsonb_build_object('outlet_id', t.id('o1'), 'orders', jsonb_build_array(jsonb_build_object('order_id', 'SP-1', 'items', jsonb_build_array(jsonb_build_object('sku', 'BSR-100-L2', 'qty', 1))))));
  perform t.ok((r ->> 'ok')::int = 0 and (r ->> 'duplikat')::int = 1, 'impor ulang aman');
  select count(*) into n from public.external_orders where source = 'shopee' and external_id = 'SP-1'; perform t.ok(n = 1, 'satu catatan pesanan eksternal');
  perform t.ok((select sum(quantity_delta) from public.stock_movements where reference_type = 'sale' and note = 'Impor Shopee SP-1' and item_id = t.id('v1')) = -2, 'stok terpotong sesuai impor');
  perform t.ok((public.rpc_overhead_saran(jsonb_build_object('outlet_id', t.id('o1'))) -> 'saran_per_unit') = 'null'::jsonb, 'saran overhead tanpa kategori => pesan, bukan angka');
  perform t.logout();

  perform t.login(t.id('ka'));
  e := t.err('rpc_shopee_import', jsonb_build_object('outlet_id', t.id('o1'), 'orders', jsonb_build_array(jsonb_build_object('order_id', 'SP-9', 'items', jsonb_build_array(jsonb_build_object('sku', 'BSR-100-L2', 'qty', 1))))));
  perform t.ok(e like '42501%', 'kasir tidak boleh impor Shopee: ' || coalesce(e, 'berhasil'));
  perform t.ok(t.err('rpc_addon_create', jsonb_build_object('outlet_id', t.id('o1'), 'nama', 'Kresek Lain', 'harga', 1)) like '42501%', 'kasir tidak boleh membuat produk tambahan');
  perform t.ok(t.err('rpc_overhead_saran', jsonb_build_object('outlet_id', t.id('o1'))) like '42501%', 'kasir tidak boleh melihat saran overhead');
  perform t.logout();
end $$;

-- ===== T15: versi skema (P0-3) =====
do $$
declare r jsonb;
begin
  perform t.login(t.id('ka'));
  r := public.rpc_schema_version();
  perform t.ok(r ? 'version' and r ? 'min_client', 'rpc_schema_version mengembalikan version dan min_client: ' || r::text);
  perform t.ok(r ->> 'min_client' ~ '^\d+\.\d+\.\d+$', 'min_client berformat semver: ' || (r ->> 'min_client'));
  perform t.ok(r ->> 'version' = 'unknown' or r ->> 'version' ~ '^\d{14}$', 'version = nomor migrasi 14 digit atau unknown (Postgres biasa tanpa CLI): ' || (r ->> 'version'));
  perform t.logout();
  perform t.ok(has_function_privilege('anon', 'public.rpc_schema_version(jsonb)', 'execute'), 'anon boleh memanggil rpc_schema_version (deploy memverifikasi tanpa login)');
  perform t.ok(has_function_privilege('authenticated', 'public.rpc_schema_version(jsonb)', 'execute'), 'authenticated boleh memanggil rpc_schema_version');
  perform t.ok(not has_function_privilege('anon', 'public.rpc_bootstrap(jsonb)', 'execute'), 'anon tetap TIDAK boleh memanggil rpc_bootstrap');
end $$;

-- ===== T16: idempotensi saat Owner mengambil alih, retensi, persetujuan diskon (P1-1, P1-2, P1-5) =====
do $$
declare r1 jsonb; r2 jsonb; e text; p jsonb; ap jsonb; n bigint; pa jsonb;
begin
  perform t.login(t.id('owner'));
  perform public.rpc_stock_adjust(jsonb_build_object('outlet_id', t.id('o1'), 'tipe', 'varian', 'id', t.id('v2'), 'stok_baru', 50, 'hpp', 11000, 'alasan', 'isi ulang T16'));
  perform public.rpc_stock_adjust(jsonb_build_object('outlet_id', t.id('o1'), 'tipe', 'varian', 'id', t.id('v1'), 'stok_baru', 50, 'hpp', 6000, 'alasan', 'isi ulang T16'));
  perform t.logout();

  -- P1-2: percobaan pertama oleh kasir (jawaban "hilang"), kiriman ulang oleh Owner atas nama kasir (kasir_id + client_ts berbeda) => hasil lama, bukan 23505
  p := jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-t16-0001', 'channel_id', t.id('ch'), 'metode_bayar', 'qris',
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 1)), 'client_ts', 1000);
  perform t.login(t.id('ka')); r1 := public.rpc_sale_create(p); perform t.logout();
  perform t.login(t.id('owner'));
  r2 := public.rpc_sale_create(p || jsonb_build_object('kasir_id', t.id('ka'), 'client_ts', 2000));
  perform t.ok((r2 ->> 'duplicate')::boolean and r1 -> 'sale' ->> 'id' = r2 -> 'sale' ->> 'id', 'ambil-alih Owner: kiriman ulang mengembalikan transaksi yang sama: ' || r2::text);
  e := t.err('rpc_sale_create', p || jsonb_build_object('kasir_id', t.id('ka'), 'diskon', 100));
  perform t.ok(e like '23505%', 'isi berbeda dengan request_id sama tetap ditolak 23505: ' || coalesce(e, 'berhasil'));
  perform t.ok((select count(*) from public.sales where request_id = 'req-t16-0001') = 1, 'hanya satu transaksi tercatat');
  perform t.logout();

  -- P1-5: diskon di atas batas (10% default) oleh kasir
  p := jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-t16-0002', 'channel_id', t.id('ch'), 'metode_bayar', 'qris',
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v2'), 'qty', 1)), 'diskon', 5000);
  perform t.login(t.id('ka'));
  e := t.err('rpc_sale_create', p); perform t.ok(e like 'P0001%' and e like '%Perlu supervisor/owner%', 'tanpa persetujuan: diskon besar ditolak: ' || coalesce(e, 'berhasil'));
  e := t.err('rpc_approval_issue', jsonb_build_object('outlet_id', t.id('o1'), 'kind', 'diskon', 'request_id', 'req-t16-0002', 'amount', 5000));
  perform t.ok(e like '42501%', 'kasir tidak boleh menerbitkan persetujuan: ' || coalesce(e, 'berhasil'));
  e := t.err('rpc_sale_create', p || jsonb_build_object('approval_id', gen_random_uuid()));
  perform t.ok(e like 'P0001%', 'approval_id palsu ditolak: ' || coalesce(e, 'berhasil'));
  perform t.logout();

  perform t.login(t.id('owner'));
  ap := public.rpc_approval_issue(jsonb_build_object('outlet_id', t.id('o1'), 'kind', 'diskon', 'request_id', 'req-t16-0002', 'amount', 5000));
  pa := public.rpc_approval_issue(jsonb_build_object('outlet_id', t.id('o1'), 'kind', 'diskon', 'request_id', 'req-t16-0003', 'amount', 100));
  perform t.logout();

  perform t.login(t.id('ka'));
  e := t.err('rpc_sale_create', jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-t16-0003', 'channel_id', t.id('ch'), 'metode_bayar', 'qris',
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v2'), 'qty', 1)), 'diskon', 5000, 'approval_id', pa ->> 'approval_id'));
  perform t.ok(e like 'P0001%', 'persetujuan dengan nominal lebih kecil dari diskon ditolak: ' || coalesce(e, 'berhasil'));
  e := t.err('rpc_sale_create', p || jsonb_build_object('request_id', 'req-t16-0009', 'approval_id', ap ->> 'approval_id'));
  perform t.ok(e like 'P0001%', 'persetujuan milik request_id lain ditolak: ' || coalesce(e, 'berhasil'));
  r1 := public.rpc_sale_create(p || jsonb_build_object('approval_id', ap ->> 'approval_id'));
  perform t.ok((r1 -> 'sale' ->> 'diskon')::numeric = 5000, 'dengan persetujuan server: diskon besar lolos tanpa token approver');
  perform t.logout();
  perform t.ok((select approved_by from public.sales where request_id = 'req-t16-0002') = t.id('owner'), 'approved_by mencatat penyetuju');
  perform t.ok((select used_at from app.approvals where request_id = 'req-t16-0002') is not null, 'persetujuan ditandai terpakai');
  perform t.login(t.id('ka'));
  r2 := public.rpc_sale_create(p || jsonb_build_object('approval_id', ap ->> 'approval_id'));
  perform t.ok((r2 ->> 'duplicate')::boolean, 'kiriman ulang dijawab idempoten (persetujuan tidak dipakai dua kali)');
  e := t.err('rpc_sale_create', p || jsonb_build_object('request_id', 'req-t16-0004', 'approval_id', ap ->> 'approval_id'));
  perform t.ok(e like 'P0001%', 'persetujuan sekali pakai: tidak bisa untuk transaksi lain: ' || coalesce(e, 'berhasil'));
  perform t.logout();

  -- P1-1: retensi
  insert into app.idempotency_keys (scope, key, request_hash, created_at) values ('sale', 'old-key-t16-1', 'x', now() - interval '45 days'), ('sale', 'new-key-t16-1', 'x', now() - interval '2 days');
  n := app.purge_idempotency(30);
  perform t.ok(n >= 1 and not exists (select 1 from app.idempotency_keys where key = 'old-key-t16-1') and exists (select 1 from app.idempotency_keys where key = 'new-key-t16-1'), 'purge menghapus kunci lama saja');
  begin perform app.purge_idempotency(1); perform t.ok(false, 'retensi 1 hari harus ditolak'); exception when sqlstate '22023' then null; end;
  perform t.ok(not has_function_privilege('authenticated', 'app.purge_idempotency(int)', 'execute'), 'authenticated tidak boleh menjalankan purge');
  perform t.ok(not has_table_privilege('authenticated', 'app.approvals', 'select'), 'authenticated tidak boleh membaca app.approvals');
end $$;

-- ===== T17: pembatasan laju admin-users (P1-6) =====
do $$
declare a int; b int; c int;
begin
  a := public.rpc_admin_rate_hit(jsonb_build_object('caller', t.id('owner')));
  b := public.rpc_admin_rate_hit(jsonb_build_object('caller', t.id('owner')));
  c := public.rpc_admin_rate_hit(jsonb_build_object('caller', t.id('ka')));
  perform t.ok(b = a + 1, 'hitungan naik per pemanggil dalam menit yang sama: ' || a || ' -> ' || b);
  perform t.ok(c = 1, 'pemanggil lain dihitung terpisah');
  perform t.ok(not has_function_privilege('authenticated', 'public.rpc_admin_rate_hit(jsonb)', 'execute') and not has_function_privilege('anon', 'public.rpc_admin_rate_hit(jsonb)', 'execute'), 'klien tidak boleh memanggil rpc_admin_rate_hit');
  perform t.ok(t.err('rpc_admin_rate_hit', '{}'::jsonb) is not null, 'caller kosong ditolak');
end $$;

-- ===== T18: kontrak fungsi baca yang dipanggil UI (F1) =====
do $$
declare r jsonb; ty text; i int; e text; rid uuid; rec jsonb;
begin
  perform t.login(t.id('owner'));
  r := public.rpc_dashboard(jsonb_build_object('outlet_id', t.id('o1'), 'period', 'hari'));
  perform t.ok(r ? 'cur' and r ? 'prev' and r ? 'laba_bersih' and jsonb_typeof(r -> 'series') = 'array' and jsonb_array_length(r -> 'series') >= 7, 'dashboard: bentuk keluaran sesuai UI');
  perform t.ok((r -> 'cur' ->> 'trx')::int >= 1 and (r -> 'cur' ->> 'omzet')::numeric > 0, 'dashboard: penjualan hari ini terbaca');
  foreach ty in array array['labarugi','penjualan','channel','hpp','stok','produksi','pembelian','pengeluaran'] loop
    r := public.rpc_report_legacy(jsonb_build_object('outlet_id', t.id('o1'), 'type', ty));
    perform t.ok(r ->> 'type' = ty and jsonb_array_length(r -> 'columns') = jsonb_array_length(r -> 'fmt'), 'laporan ' || ty || ': kolom dan format sejajar');
    for i in 0 .. jsonb_array_length(r -> 'rows') - 1 loop
      perform t.ok(jsonb_array_length(r -> 'rows' -> i) = jsonb_array_length(r -> 'columns'), 'laporan ' || ty || ': tiap baris selebar kolom');
    end loop;
  end loop;
  r := public.rpc_report_legacy(jsonb_build_object('outlet_id', t.id('o1'), 'type', 'penjualan'));
  perform t.ok(jsonb_array_length(r -> 'rows') >= 1 and (r -> 'rows' -> 0 ->> 5)::numeric > 0, 'penjualan: kolom 5 = HPP (dipakai UI untuk peringatan HPP)');
  perform t.ok(jsonb_typeof(public.rpc_production_list(jsonb_build_object('outlet_id', t.id('o1')))) = 'array', 'production_list: larik');
  rec := public.rpc_recipe_save(jsonb_build_object('variant_id', t.id('v2'), 'nama', 'Resep 200g', 'hasil_standar', 5, 'jenis', 'batch', 'tenaga_kerja', 1000,
          'items', jsonb_build_array(jsonb_build_object('material_id', t.id('m1'), 'qty', 1.5))));
  perform t.ok((rec -> 'recipe' ->> 'id') is not null and jsonb_array_length(rec -> 'items') = 1, 'recipe_save: header dan bahan kembali');
  rid := (rec -> 'recipe' ->> 'id')::uuid;
  rec := public.rpc_recipe_save(jsonb_build_object('id', rid, 'variant_id', t.id('v2'), 'nama', 'Resep 200g v2', 'hasil_standar', 6,
          'items', jsonb_build_array(jsonb_build_object('material_id', t.id('m1'), 'qty', 2), jsonb_build_object('material_id', t.id('m1'), 'qty', 1))));
  perform t.ok(jsonb_array_length(rec -> 'items') = 2 and (select count(*) from public.recipe_items where recipe_id = rid) = 2, 'recipe_save: ubah mengganti bahan lama, bukan menumpuk');
  e := t.err('rpc_recipe_save', jsonb_build_object('variant_id', t.id('v2'), 'nama', 'X', 'hasil_standar', 5, 'items', '[]'::jsonb));
  perform t.ok(e like '22023%', 'recipe_save: tanpa bahan ditolak: ' || coalesce(e, 'berhasil'));
  perform t.logout();
  perform t.login(t.id('ka'));
  e := t.err('rpc_report_legacy', jsonb_build_object('outlet_id', t.id('o1'), 'type', 'penjualan'));
  perform t.ok(e like '42501%', 'kasir tidak boleh membuka laporan: ' || coalesce(e, 'berhasil'));
  e := t.err('rpc_dashboard', jsonb_build_object('outlet_id', t.id('o1')));
  perform t.ok(e like '42501%', 'kasir tidak boleh membuka dashboard: ' || coalesce(e, 'berhasil'));
  e := t.err('rpc_recipe_save', jsonb_build_object('variant_id', t.id('v2'), 'nama', 'X', 'hasil_standar', 5, 'items', jsonb_build_array(jsonb_build_object('material_id', t.id('m1'), 'qty', 1))));
  perform t.ok(e like '42501%', 'kasir tidak boleh menyimpan resep: ' || coalesce(e, 'berhasil'));
  perform t.logout();
  perform t.login(t.id('ks'));
  r := public.rpc_report_legacy(jsonb_build_object('outlet_id', t.id('o1'), 'type', 'stok'));
  perform t.ok(r -> 'rows' -> 0 ->> 5 is null, 'peran stok tidak melihat HPP di laporan stok');
  perform t.logout();
end $$;

-- ===== T19: buka kasir wajib, modal ditetapkan saat buka (F4) =====
do $$
declare kc uuid := gen_random_uuid(); r jsonb; e text; o1 uuid := t.id('o1');
begin
  insert into auth.users (id, email) values (kc, 'kc@t');
  insert into public.profiles (id, username, full_name) values (kc, 'kasir.c', 'Kasir C');
  insert into public.memberships (user_id, outlet_id, role) values (kc, o1, 'kasir');
  insert into t.ids values ('kc', kc);
  update public.settings set value = 'true' where key = 'wajib_buka_kasir' and outlet_id is null;
  perform t.login(kc);
  e := t.err('rpc_sale_create', jsonb_build_object('outlet_id', o1, 'request_id', 'req-t19-0001', 'channel_id', t.id('ch'), 'metode_bayar', 'tunai',
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 1)), 'total_klien', 10000, 'amount_received', 10000));
  perform t.ok(e like 'P0001%', 'penjualan tanpa buka kasir ditolak saat wajib_buka_kasir aktif: ' || coalesce(e, 'berhasil'));
  r := public.rpc_cash_summary(jsonb_build_object('outlet_id', o1));
  perform t.ok(r ->> 'sesi' is null and (r ->> 'wajib_buka')::boolean, 'ringkasan tanpa sesi melaporkan wajib_buka');
  perform public.rpc_cash_open(jsonb_build_object('outlet_id', o1, 'modal_awal', 50000));
  perform public.rpc_cash_movement_add(jsonb_build_object('jenis', 'out', 'nominal', 5000, 'alasan', 'beli es batu', 'kategori', 'Transport'));
  r := public.rpc_cash_summary(jsonb_build_object('outlet_id', o1));
  perform t.ok((r ->> 'modal_awal')::numeric = 50000 and jsonb_array_length(r -> 'gerakan') = 1, 'ringkasan memuat modal awal dan gerakan kas sesi ini');
  r := public.rpc_cash_close(jsonb_build_object('uang_fisik', 45000, 'modal_awal', 0, 'kas_keluar', 99999));
  perform t.ok((r ->> 'modal_awal')::numeric = 50000 and (r ->> 'kas_keluar')::numeric = 5000 and (r ->> 'selisih_tunai')::numeric = 0,
    'tutup kasir mengabaikan modal_awal/kas_keluar dari klien: ' || r::text);
  perform t.logout();
  update public.settings set value = 'false' where key = 'wajib_buka_kasir' and outlet_id is null;
end $$;

-- ===== T20: pembuangan transaksi antrean tercatat di server (F3) =====
do $$
declare e text; o1 uuid := t.id('o1');
begin
  perform t.login(t.id('kc'));
  perform public.rpc_sale_reject_log(jsonb_build_object('outlet_id', o1, 'request_id', 'req-t20-0001', 'alasan', 'ditolak server: stok kurang', 'total', 20000, 'aksi', 'hapus'));
  perform t.logout();
  perform t.ok(exists (select 1 from public.audit_logs where action = 'sale_queue_hapus' and entity_id = 'req-t20-0001' and actor_id = t.id('kc')), 'pembuangan transaksi antrean tercatat di audit_logs dengan pelaku');
  perform t.login(t.id('kb'));
  e := t.err('rpc_sale_reject_log', jsonb_build_object('outlet_id', o1, 'request_id', 'req-t20-0002', 'alasan', 'x'));
  perform t.ok(e like '42501%', 'kasir outlet lain tidak boleh mencatat di outlet ini: ' || coalesce(e, 'berhasil'));
  e := t.err('rpc_sale_reject_log', jsonb_build_object('outlet_id', t.id('o2'), 'request_id', 'x'));
  perform t.ok(e like '22023%', 'request_id pendek ditolak: ' || coalesce(e, 'berhasil'));
  perform t.logout();
end $$;

-- ===== T21: penguncian akun dan buka kunci (F8) =====
do $$
declare u uuid := t.id('ka'); r jsonb; i int; e text;
begin
  for i in 1 .. 4 loop r := public.hook_password_verification_attempt(jsonb_build_object('user_id', u, 'valid', false)); end loop;
  perform t.ok(r ->> 'decision' = 'continue', '4 salah belum terkunci');
  r := public.hook_password_verification_attempt(jsonb_build_object('user_id', u, 'valid', false));
  r := public.hook_password_verification_attempt(jsonb_build_object('user_id', u, 'valid', true));
  perform t.ok(r ->> 'decision' = 'reject', 'setelah 5 salah, bahkan kata sandi benar ditolak saat terkunci');
  perform t.login(t.id('owner'));
  perform t.ok(exists (select 1 from jsonb_array_elements(public.rpc_user_locks('{}'::jsonb)) x where x ->> 'user_id' = u::text), 'owner melihat akun terkunci');
  perform public.rpc_user_unlock(jsonb_build_object('user_id', u));
  perform t.logout();
  r := public.hook_password_verification_attempt(jsonb_build_object('user_id', u, 'valid', true));
  perform t.ok(r ->> 'decision' = 'continue', 'setelah dibuka, masuk berhasil');
  perform t.login(t.id('ka'));
  e := t.err('rpc_user_unlock', jsonb_build_object('user_id', u));
  perform t.ok(e like '42501%', 'kasir tidak boleh membuka kunci: ' || coalesce(e, 'berhasil'));
  perform t.logout();
  perform t.ok(not has_function_privilege('authenticated', 'public.hook_password_verification_attempt(jsonb)', 'execute') and not has_function_privilege('anon', 'public.hook_password_verification_attempt(jsonb)', 'execute'), 'klien tidak boleh memanggil hook');
  perform t.ok(not has_table_privilege('authenticated', 'app.auth_failures', 'select'), 'klien tidak boleh membaca app.auth_failures');
end $$;

select 'SEMUA TES LULUS' as hasil;
