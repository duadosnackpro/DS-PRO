-- Tes P1 (migrasi 0024). Dijalankan setelah 001 dan 002 (memakai data uji t.ids). Gagal keras bila ekspektasi tidak terpenuhi.
\set ON_ERROR_STOP on
do $$ declare pr uuid := gen_random_uuid(); begin
  insert into auth.users (id, email) values (pr, 'pr@t');
  insert into public.profiles (id, username, full_name) values (pr, 'prod.a', 'Produksi A');
  insert into public.memberships (user_id, outlet_id, role) values (pr, t.id('kit'), 'produksi');
  insert into t.ids values ('pr', pr) on conflict (k) do update set v = excluded.v;
end $$;

-- ===== F-08 produksi menolak bahan tanpa harga =====
do $$ declare c jsonb; e text; rid uuid; begin
  select id into rid from public.recipes where name = 'Resep Basreng';
  perform t.login(t.id('owner'));
  c := public.rpc_production_create(jsonb_build_object('kitchen_outlet_id', t.id('o1'), 'output_outlet_id', t.id('o1'), 'recipe_id', rid, 'jumlah_batch', 1));
  e := t.err('rpc_production_complete', jsonb_build_object('id', c ->> 'id', 'qty_hasil', 10));
  perform t.ok(e like '%belum punya harga%', 'produksi dengan bahan HPP 0 ditolak: ' || coalesce(e, 'NULL'));
  e := t.err('rpc_production_complete', jsonb_build_object('id', c ->> 'id', 'qty_hasil', 10, 'izinkan_bahan_tanpa_harga', true));
  perform t.ok(e is null or e not like '%belum punya harga%', 'owner boleh melewati larangan bahan tanpa harga: ' || coalesce(e, 'NULL'));
  perform t.logout();
end $$;

-- ===== F-11 produksi lintas outlet butuh wewenang di outlet tujuan =====
do $$ declare e text; rid uuid; begin
  select id into rid from public.recipes where name = 'Resep Basreng';
  perform t.login(t.id('pr'));
  e := t.err('rpc_production_create', jsonb_build_object('kitchen_outlet_id', t.id('kit'), 'output_outlet_id', t.id('o1'), 'recipe_id', rid, 'jumlah_batch', 1));
  perform t.ok(e like '42501%', 'produksi ke outlet lain tanpa wewenang ditolak: ' || coalesce(e, 'NULL'));
  perform t.logout();
end $$;

-- ===== Normalisasi stok untuk tes berikutnya =====
-- 002 sengaja membuat stok v1 di o1 minus (uji "stok kurang diterima"); block_negative_stock bawaan = true, jadi penjualan v1 di bawah akan ditolak
-- dan penyesuaian oleh peran 'stok' kena ambang nilai opname. Owner memulihkan stok ke angka wajar (v1 = 50 persis, agar selisih ks di F-13 nol).
do $$ begin
  perform t.login(t.id('owner'));
  perform public.rpc_stock_adjust(jsonb_build_object('outlet_id', t.id('o1'), 'tipe', 'varian', 'id', t.id('v1'), 'stok_baru', 50, 'hpp', 6000, 'alasan', 'pulihkan stok uji P1'));
  perform public.rpc_stock_adjust(jsonb_build_object('outlet_id', t.id('o1'), 'tipe', 'varian', 'id', t.id('v2'), 'stok_baru', 100, 'hpp', 5000, 'alasan', 'pulihkan stok uji P1'));
  perform t.logout();
end $$;

-- ===== F-13 mengubah HPP yang sudah ada perlu supervisor =====
do $$ declare e text; begin
  perform t.login(t.id('ks'));
  e := t.err('rpc_stock_adjust', jsonb_build_object('outlet_id', t.id('o1'), 'tipe', 'varian', 'id', t.id('v1'), 'stok_baru', 50, 'hpp', 9999, 'alasan', 'ubah hpp'));
  perform t.ok(e like '42501%' and e like '%HPP%', 'peran stok tidak boleh mengubah HPP yang ada: ' || coalesce(e, 'NULL'));
  perform t.logout();
end $$;

-- ===== F-10 referensi pembayaran + F-15 waktu server =====
do $$ declare e text; r jsonb; r2 jsonb; ses uuid; lr jsonb; begin
  perform t.login(t.id('owner'));
  perform public.rpc_settings_set(jsonb_build_object('values', jsonb_build_object('bayar_referensi_min', 1000)));
  perform t.logout();
  perform t.login(t.id('ka'));
  begin perform public.rpc_cash_open(jsonb_build_object('outlet_id', t.id('o1'), 'modal_awal', 0)); exception when others then null; end;
  e := t.err('rpc_sale_create', jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-p1-q0001', 'channel_id', t.id('ch'), 'metode_bayar', 'qris',
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 1))));
  perform t.ok(e like '%referensi%', 'QRIS tanpa referensi ditolak: ' || coalesce(e, 'NULL'));
  r := public.rpc_sale_create(jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-p1-q0002', 'channel_id', t.id('ch'), 'metode_bayar', 'qris', 'referensi_bayar', 'QR-123',
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 1))));
  perform t.ok((select reference from public.payments where sale_id = (r -> 'sale' ->> 'id')::uuid) = 'QR-123', 'referensi tersimpan di payments');
  r2 := public.rpc_sale_create(jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-p1-q0003', 'channel_id', t.id('ch'), 'metode_bayar', 'qris', 'referensi_bayar', 'QR-123',
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 1))));
  perform t.ok((r2 ->> 'review')::boolean, 'referensi ganda ditandai perlu ditinjau');
  -- client_ts lama TANPA bendera offline diabaikan (waktu server); dengan bendera offline dipakai
  r := public.rpc_sale_create(jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-p1-t0001', 'channel_id', t.id('ch'), 'metode_bayar', 'tunai',
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 1)), 'client_ts', (extract(epoch from now() - interval '5 hours') * 1000)::bigint));
  perform t.ok((select sold_at from public.sales where id = (r -> 'sale' ->> 'id')::uuid) > now() - interval '1 minute', 'client_ts tanpa bendera offline diabaikan');
  perform t.logout();
  perform t.login(t.id('owner'));
  lr := public.rpc_report_legacy(jsonb_build_object('outlet_id', t.id('o1'), 'type', 'metode', 'from', current_date - 1, 'to', current_date + 1));
  perform t.ok(lr::text like '%QRIS%', 'laporan Pembayaran per metode memuat QRIS');
  perform public.rpc_settings_set(jsonb_build_object('values', jsonb_build_object('bayar_referensi_min', '')));
  perform t.logout();
end $$;

-- ===== F-09 omzet per produk = omzet laba rugi (diskon dialokasikan) =====
do $$ declare pj jsonb; lb jsonb; a numeric; b numeric; begin
  perform t.login(t.id('ka'));
  perform public.rpc_sale_create(jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-p1-d0001', 'channel_id', t.id('ch'), 'metode_bayar', 'tunai', 'diskon', 1000,
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 2), jsonb_build_object('variant_id', t.id('v2'), 'qty', 1)), 'amount_received', 100000));
  perform t.logout();
  perform t.login(t.id('owner'));
  pj := public.rpc_report_legacy(jsonb_build_object('outlet_id', t.id('o1'), 'type', 'penjualan', 'from', current_date - 1, 'to', current_date + 1));
  lb := public.rpc_report_legacy(jsonb_build_object('outlet_id', t.id('o1'), 'type', 'labarugi', 'from', current_date - 1, 'to', current_date + 1));
  select coalesce(sum((x ->> 3)::numeric), 0) into a from jsonb_array_elements(pj -> 'rows') x;
  select (x ->> 1)::numeric into b from jsonb_array_elements(lb -> 'rows') x where x ->> 0 like 'Omzet%' limit 1;
  perform t.ok(abs(a - b) < 1, 'omzet per produk (' || a || ') = omzet laba rugi (' || b || ')');
  perform t.logout();
end $$;

-- ===== F-16 batalkan biaya + F-15 kunci periode =====
do $$ declare x jsonb; e text; begin
  perform t.login(t.id('owner'));
  x := public.rpc_expense_create(jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-p1-x0001', 'kategori', 'Gas', 'nominal', 15000));
  e := t.err('rpc_expense_void', jsonb_build_object('id', x ->> 'id', 'alasan', 'x'));
  perform t.ok(e like '%Alasan%', 'pembatalan biaya tanpa alasan ditolak');
  perform public.rpc_expense_void(jsonb_build_object('id', x ->> 'id', 'alasan', 'salah ketik'));
  e := t.err('rpc_expense_void', jsonb_build_object('id', x ->> 'id', 'alasan', 'sekali lagi'));
  perform t.ok(e like '%sudah dibatalkan%', 'biaya tidak dapat dibatalkan dua kali: ' || coalesce(e, 'NULL'));
  perform t.ok((select sum(amount) from public.expenses where id = (x ->> 'id')::uuid or void_of = (x ->> 'id')::uuid) = 0, 'biaya asal + pembalik = 0 (netto)');
  -- kunci periode: biaya bertanggal di periode terkunci ditolak; hanya Owner yang boleh mengunci
  perform public.rpc_period_lock_set(jsonb_build_object('sampai', to_char(current_date, 'YYYY-MM-DD'), 'alasan', 'uji kunci'));
  e := t.err('rpc_expense_create', jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-p1-x0002', 'kategori', 'Gas', 'nominal', 1000, 'tanggal', to_char(current_date, 'YYYY-MM-DD')));
  perform t.ok(e like '%dikunci%', 'biaya pada periode terkunci ditolak: ' || coalesce(e, 'NULL'));
  e := t.err('rpc_settings_set', jsonb_build_object('values', jsonb_build_object('kunci_periode_sampai', '')));
  perform t.ok(e like '42501%', 'kunci periode tidak bisa diubah lewat settings_set');
  perform public.rpc_period_lock_set(jsonb_build_object('sampai', '', 'alasan', 'uji selesai'));
  perform t.logout();
end $$;

-- ===== F-16 batalkan pembelian =====
do $$ declare pu jsonb; q0 numeric; q1 numeric; e text; begin
  perform t.login(t.id('owner'));
  select coalesce(quantity, 0) into q0 from public.inventory_material_balances where outlet_id = t.id('o1') and material_id = t.id('m1');
  pu := public.rpc_purchase_create(jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-p1-b0001', 'items', jsonb_build_array(jsonb_build_object('material_id', t.id('m1'), 'qty', 5, 'harga_satuan', 2000))));
  perform public.rpc_purchase_cancel(jsonb_build_object('id', pu ->> 'id', 'alasan', 'salah supplier'));
  select quantity into q1 from public.inventory_material_balances where outlet_id = t.id('o1') and material_id = t.id('m1');
  perform t.ok(q1 = q0, 'stok bahan kembali setelah pembelian dibatalkan');
  e := t.err('rpc_purchase_cancel', jsonb_build_object('id', pu ->> 'id', 'alasan', 'ulang'));
  perform t.ok(e like '%sudah dibatalkan%', 'pembelian tidak dapat dibatalkan dua kali');
  perform t.logout();
end $$;

-- ===== F-17 tinjau selisih kas =====
do $$ declare e text; c jsonb; sid uuid; l jsonb; begin
  perform t.login(t.id('ka'));
  c := public.rpc_cash_close(jsonb_build_object('uang_fisik', 1, 'catatan', 'uji selisih'));
  sid := (c ->> 'id')::uuid;
  e := t.err('rpc_cash_approve', jsonb_build_object('id', sid));
  perform t.ok(e like '42501%', 'kasir tidak boleh meninjau sesinya sendiri');
  perform t.logout();
  perform t.login(t.id('owner'));
  e := t.err('rpc_cash_approve', jsonb_build_object('id', sid));
  perform t.ok(e like '%catatan%', 'tinjauan sesi berselisih wajib bercatatan: ' || coalesce(e, 'NULL'));
  perform public.rpc_cash_approve(jsonb_build_object('id', sid, 'catatan', 'dikonfirmasi kasir'));
  l := public.rpc_shift_list(jsonb_build_object('outlet_id', t.id('o1')));
  perform t.ok(exists (select 1 from jsonb_array_elements(l) x where x ->> 'id' = sid::text and (x ->> 'disetujui')::boolean and x ->> 'kasir' = 'Kasir A'), 'shift_list memuat nama kasir dan status tinjauan');
  perform t.logout();
end $$;
\echo 'Tes P1 selesai'
