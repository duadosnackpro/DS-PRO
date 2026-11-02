-- Tes reset data transaksi per outlet (migrasi 0025). Dijalankan setelah 001-003 (memakai data uji t.ids). Gagal keras bila ekspektasi tidak terpenuhi.
\set ON_ERROR_STOP on

create table if not exists t.snap (k text primary key, v numeric);
truncate t.snap;

-- ===== Hak akses: hanya Owner =====
do $$ declare e text; begin
  perform t.login(t.id('ka'));
  e := t.err('rpc_data_reset', jsonb_build_object('outlet_id', t.id('o1')));
  perform t.ok(e like '42501%', 'kasir tidak boleh melihat pratinjau reset: ' || coalesce(e, 'NULL'));
  e := t.err('rpc_data_reset', jsonb_build_object('outlet_id', t.id('o1'), 'terapkan', true, 'konfirmasi', 'x', 'alasan', 'coba', 'request_id', 'req-rst-0001'));
  perform t.ok(e like '42501%', 'kasir tidak boleh menjalankan reset: ' || coalesce(e, 'NULL'));
  perform t.logout();
end $$;

-- ===== Pratinjau tidak mengubah apa pun =====
do $$ declare r jsonb; n0 bigint; n1 bigint; begin
  select count(*) into n0 from public.sales where outlet_id = t.id('o1');
  perform t.ok(n0 > 0, 'o1 punya penjualan dari tes sebelumnya');
  perform t.login(t.id('owner'));
  r := public.rpc_data_reset(jsonb_build_object('outlet_id', t.id('o1')));
  perform t.logout();
  perform t.ok((r ->> 'terapkan')::boolean = false, 'pratinjau: terapkan = false');
  perform t.ok((r -> 'jumlah' ->> 'penjualan')::bigint = n0, 'pratinjau menghitung penjualan o1');
  select count(*) into n1 from public.sales where outlet_id = t.id('o1');
  perform t.ok(n1 = n0, 'pratinjau tidak menghapus apa pun');
end $$;

-- ===== Catat kondisi outlet LAIN (o2) sebelum reset =====
do $$ begin
  insert into t.snap values
    ('o2_sales',  (select count(*) from public.sales where outlet_id = t.id('o2'))),
    ('o2_moves',  (select count(*) from public.stock_movements where outlet_id = t.id('o2'))),
    ('o2_bal',    (select coalesce(sum(quantity), 0) from public.inventory_balances where outlet_id = t.id('o2'))),
    ('central_exp', (select count(*) from public.expenses where outlet_id is null)),
    ('variants',  (select count(*) from public.product_variants)),
    ('audit_n',   (select count(*) from public.audit_logs));
end $$;

-- ===== Validasi sisi server =====
do $$ declare e text; begin
  perform t.login(t.id('owner'));
  e := t.err('rpc_data_reset', jsonb_build_object('outlet_id', t.id('o1'), 'terapkan', true, 'konfirmasi', 'SALAH', 'alasan', 'bersihkan data uji', 'request_id', 'req-rst-0002'));
  perform t.ok(e like '22023%' and e like '%konfirmasi%', 'kode konfirmasi salah ditolak: ' || coalesce(e, 'NULL'));
  e := t.err('rpc_data_reset', jsonb_build_object('outlet_id', t.id('o1'), 'terapkan', true, 'konfirmasi', (select code from public.outlets where id = t.id('o1')), 'alasan', 'a', 'request_id', 'req-rst-0003'));
  perform t.ok(e like '22023%' and e like '%Alasan%', 'alasan terlalu pendek ditolak: ' || coalesce(e, 'NULL'));
  e := t.err('rpc_data_reset', jsonb_build_object('outlet_id', t.id('o1'), 'terapkan', true, 'konfirmasi', (select code from public.outlets where id = t.id('o1')), 'alasan', 'bersihkan data uji'));
  perform t.ok(e like '22023%' and e like '%request_id%', 'tanpa request_id ditolak: ' || coalesce(e, 'NULL'));
  e := t.err('rpc_data_reset', jsonb_build_object('outlet_id', t.id('o1'), 'stok', 'acak'));
  perform t.ok(e like '22023%', 'pilihan stok tidak dikenal ditolak: ' || coalesce(e, 'NULL'));
  perform t.logout();
  perform t.ok((select count(*) from public.sales where outlet_id = t.id('o1')) > 0, 'penolakan tidak menghapus data');
end $$;

-- ===== Penjaga: periode terkunci dan transfer berjalan =====
do $$ declare e text; r jsonb; begin
  perform t.login(t.id('owner'));
  perform public.rpc_period_lock_set(jsonb_build_object('sampai', to_char(current_date, 'YYYY-MM-DD'), 'alasan', 'uji reset'));
  r := public.rpc_data_reset(jsonb_build_object('outlet_id', t.id('o1')));
  perform t.ok(r ->> 'blokir' like '%dikunci%', 'pratinjau memberi tahu periode terkunci');
  e := t.err('rpc_data_reset', jsonb_build_object('outlet_id', t.id('o1'), 'terapkan', true, 'konfirmasi', (select code from public.outlets where id = t.id('o1')), 'alasan', 'bersihkan data uji', 'request_id', 'req-rst-0004'));
  perform t.ok(e like 'P0001%' and e like '%dikunci%', 'reset ditolak saat periode terkunci: ' || coalesce(e, 'NULL'));
  perform public.rpc_period_lock_set(jsonb_build_object('sampai', '', 'alasan', 'uji reset selesai'));
  perform t.logout();

  insert into public.stock_transfers (number, from_outlet_id, to_outlet_id, status, requested_by)
  values ('TRF-RESET-1', t.id('o1'), t.id('o2'), 'sent', t.id('owner'));
  perform t.login(t.id('owner'));
  e := t.err('rpc_data_reset', jsonb_build_object('outlet_id', t.id('o1'), 'terapkan', true, 'konfirmasi', (select code from public.outlets where id = t.id('o1')), 'alasan', 'bersihkan data uji', 'request_id', 'req-rst-0005'));
  perform t.ok(e like 'P0001%' and e like '%transfer%', 'reset ditolak saat ada transfer berjalan: ' || coalesce(e, 'NULL'));
  perform t.logout();
  update public.stock_transfers set status = 'cancelled' where number = 'TRF-RESET-1';
end $$;

-- ===== Reset sungguhan, stok dikosongkan =====
do $$ declare r jsonb; code text; begin
  select o.code into code from public.outlets o where o.id = t.id('o1');
  perform t.login(t.id('owner'));
  r := public.rpc_data_reset(jsonb_build_object('outlet_id', t.id('o1'), 'terapkan', true, 'konfirmasi', lower(code), 'alasan', 'bersihkan data uji', 'request_id', 'req-rst-0006'));
  perform t.logout();
  perform t.ok((r ->> 'terapkan')::boolean and r ->> 'stok' = 'nol', 'reset selesai (stok nol)');
  perform t.ok((r -> 'jumlah' ->> 'penjualan')::bigint > 0, 'hasil melaporkan jumlah yang dihapus');
end $$;

do $$ declare k text; n bigint; begin
  foreach k in array array['sales', 'sale_items', 'payments', 'cash_sessions', 'cash_movements', 'purchases', 'stock_movements', 'inventory_losses', 'external_orders', 'import_batches'] loop
    execute format('select count(*) from public.%I where outlet_id = $1', k) into n using t.id('o1');
    perform t.ok(n = 0, 'o1 kosong: ' || k || ' = ' || n);
  end loop;
  perform t.ok((select count(*) from public.expenses where outlet_id = t.id('o1')) = 0, 'biaya o1 kosong');
  perform t.ok((select count(*) from public.stock_transfers where from_outlet_id = t.id('o1') or to_outlet_id = t.id('o1')) = 0, 'transfer o1 kosong');
  perform t.ok((select count(*) from public.production_orders where kitchen_outlet_id = t.id('o1') or output_outlet_id = t.id('o1')) = 0, 'produksi o1 kosong');
  perform t.ok((select count(*) from app.outlet_counters where outlet_id = t.id('o1')) = 0, 'penghitung nomor struk o1 kosong');
  perform t.ok((select coalesce(sum(abs(quantity)) + sum(avg_cost), 0) from public.inventory_balances where outlet_id = t.id('o1')) = 0, 'saldo stok varian o1 nol');
  perform t.ok((select coalesce(sum(abs(quantity)) + sum(avg_cost), 0) from public.inventory_material_balances where outlet_id = t.id('o1')) = 0, 'saldo stok bahan o1 nol');
  perform t.ok((select count(*) from public.inventory_balances where outlet_id = t.id('o1')) > 0, 'baris saldo (dan batas stok minimum) tetap ada');
end $$;

-- ===== Outlet lain, master data, dan jejak audit tidak tersentuh =====
do $$ begin
  perform t.ok((select count(*) from public.sales where outlet_id = t.id('o2')) = (select v from t.snap where k = 'o2_sales'), 'penjualan o2 utuh');
  perform t.ok((select count(*) from public.stock_movements where outlet_id = t.id('o2')) = (select v from t.snap where k = 'o2_moves'), 'ledger stok o2 utuh');
  perform t.ok((select coalesce(sum(quantity), 0) from public.inventory_balances where outlet_id = t.id('o2')) = (select v from t.snap where k = 'o2_bal'), 'saldo o2 utuh');
  perform t.ok((select count(*) from public.expenses where outlet_id is null) = (select v from t.snap where k = 'central_exp'), 'biaya pusat utuh');
  perform t.ok((select count(*) from public.product_variants) = (select v from t.snap where k = 'variants'), 'master produk utuh');
  perform t.ok((select count(*) from public.audit_logs) > (select v from t.snap where k = 'audit_n'), 'audit_logs tidak berkurang, bertambah satu catatan reset');
  perform t.ok(exists (select 1 from public.audit_logs where action = 'data_reset' and outlet_id = t.id('o1')), 'reset tercatat di audit_logs');
end $$;

-- ===== Perlindungan anti-hapus menyala lagi =====
do $$ declare e text; begin
  begin delete from public.stock_movements where outlet_id = t.id('o2'); e := null; exception when others then e := sqlstate; end;
  perform t.ok(e = '23000' or (select count(*) from public.stock_movements where outlet_id = t.id('o2')) = 0, 'trigger anti-hapus ledger menyala lagi: ' || coalesce(e, 'NULL'));
  begin delete from public.inventory_losses; e := null; exception when others then e := sqlstate; end;
  perform t.ok(e = '23000' or (select count(*) from public.inventory_losses) = 0, 'trigger anti-hapus kerugian menyala lagi: ' || coalesce(e, 'NULL'));
end $$;

-- ===== request_id yang sama tidak menjalankan reset dua kali =====
do $$ declare r jsonb; code text; begin
  select o.code into code from public.outlets o where o.id = t.id('o1');
  perform t.login(t.id('owner'));
  r := public.rpc_data_reset(jsonb_build_object('outlet_id', t.id('o1'), 'terapkan', true, 'konfirmasi', lower(code), 'alasan', 'bersihkan data uji', 'request_id', 'req-rst-0006'));
  perform t.logout();
  perform t.ok((r ->> 'duplicate')::boolean, 'request_id sama mengembalikan hasil lama');
end $$;

-- ===== Mode "pertahankan stok": jumlah dan HPP tetap, ledger cocok dengan saldo =====
do $$ declare s jsonb; r jsonb; code text; q numeric; c numeric; led numeric; begin
  select o.code into code from public.outlets o where o.id = t.id('o1');
  update public.settings set value = 'false' where key = 'wajib_buka_kasir' and outlet_id is null;
  perform t.login(t.id('owner'));
  perform public.rpc_stock_adjust(jsonb_build_object('outlet_id', t.id('o1'), 'tipe', 'varian', 'id', t.id('v1'), 'stok_baru', 40, 'hpp', 6000, 'alasan', 'stok awal uji reset'));
  s := public.rpc_sale_create(jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-rst-s0001', 'channel_id', t.id('ch'), 'metode_bayar', 'tunai',
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 3)), 'amount_received', 100000));
  perform t.logout();
  select quantity, avg_cost into q, c from public.inventory_balances where outlet_id = t.id('o1') and variant_id = t.id('v1');
  perform t.ok(q = 37, 'stok sebelum reset = 37, dapat ' || q);
  perform t.login(t.id('owner'));
  r := public.rpc_data_reset(jsonb_build_object('outlet_id', t.id('o1'), 'terapkan', true, 'konfirmasi', code, 'alasan', 'bersihkan data uji', 'stok', 'pertahankan', 'request_id', 'req-rst-0007'));
  perform t.logout();
  perform t.ok(r ->> 'stok' = 'pertahankan', 'reset mode pertahankan selesai');
  perform t.ok((select count(*) from public.sales where outlet_id = t.id('o1')) = 0, 'penjualan o1 terhapus');
  perform t.ok((select quantity from public.inventory_balances where outlet_id = t.id('o1') and variant_id = t.id('v1')) = 37, 'jumlah stok dipertahankan');
  perform t.ok((select avg_cost from public.inventory_balances where outlet_id = t.id('o1') and variant_id = t.id('v1')) = c, 'HPP rata-rata dipertahankan');
  select coalesce(sum(quantity_delta), 0) into led from public.stock_movements where outlet_id = t.id('o1') and item_type = 'variant' and item_id = t.id('v1');
  perform t.ok(led = 37, 'ledger = saldo setelah reset, dapat ' || led);
  perform t.ok((select count(*) from public.stock_movements where outlet_id = t.id('o1') and movement_type <> 'opening') = 0, 'ledger hanya berisi mutasi pembukaan');
  update public.settings set value = 'true' where key = 'wajib_buka_kasir' and outlet_id is null;
end $$;

select 'Tes reset data selesai' as hasil;
