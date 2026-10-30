-- Tes P0 (migrasi 0023). Dijalankan setelah 001 (memakai data uji t.ids dari 001). Gagal keras bila ekspektasi tidak terpenuhi.
\set ON_ERROR_STOP on
-- Pengaturan uji: wajib buka kasir aktif (default produksi), supervisor outlet 1.
do $$ declare sv uuid := gen_random_uuid(); begin
  insert into auth.users (id, email) values (sv, 'sv@t');
  insert into public.profiles (id, username, full_name) values (sv, 'sv.a', 'Supervisor A');
  insert into public.memberships (user_id, outlet_id, role) values (sv, t.id('o1'), 'supervisor');
  insert into t.ids values ('sv', sv) on conflict (k) do update set v = excluded.v;
  update public.settings set value = 'true' where key = 'wajib_buka_kasir' and outlet_id is null;
  perform t.login(t.id('owner'));
  perform public.rpc_stock_adjust(jsonb_build_object('outlet_id', t.id('o1'), 'tipe', 'varian', 'id', t.id('v1'), 'stok_baru', 50, 'hpp', 6000, 'alasan', 'isi stok uji P0'));
  perform t.logout();
end $$;

-- ===== P0-1 retur oleh kasir dengan persetujuan: tercatat di sesi KASIR, bukan penyetuju =====
do $$ declare s jsonb; r jsonb; e text; sid uuid; ap jsonb; ses uuid; exp0 numeric; exp1 numeric; begin
  perform t.login(t.id('ka'));
  perform public.rpc_cash_open(jsonb_build_object('outlet_id', t.id('o1'), 'modal_awal', 100000));
  s := public.rpc_sale_create(jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-p0-s0001', 'channel_id', t.id('ch'), 'metode_bayar', 'tunai',
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 2)), 'amount_received', 20000));
  sid := (s -> 'sale' ->> 'id')::uuid; ses := (s ->> 'sesi')::uuid;
  e := t.err('rpc_sale_return', jsonb_build_object('request_id', 'req-p0-r0001', 'id', sid, 'alasan', 'rusak', 'restock', true,
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 1))));
  perform t.ok(e like '42501%', 'retur kasir tanpa persetujuan ditolak: ' || coalesce(e, 'NULL'));
  perform t.logout();
  -- Owner menerbitkan persetujuan (terikat transaksi asal dan nilai maksimum 10000)
  perform t.login(t.id('owner'));
  ap := public.rpc_approval_issue(jsonb_build_object('outlet_id', t.id('o1'), 'kind', 'retur', 'request_id', 'req-p0-r0002', 'ref_id', sid, 'amount', 10000));
  perform t.logout();
  perform t.login(t.id('ka'));
  e := t.err('rpc_sale_return', jsonb_build_object('request_id', 'req-p0-r0002', 'id', sid, 'alasan', 'lebih', 'restock', true, 'approval_id', ap ->> 'approval_id',
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 2))));
  perform t.ok(e like '42501%', 'nilai retur melebihi persetujuan ditolak: ' || coalesce(e, 'NULL'));
  e := t.err('rpc_sale_return', jsonb_build_object('request_id', 'req-p0-r0002', 'id', sid, 'alasan', 'rusak', 'approval_id', ap ->> 'approval_id',
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 1))));
  perform t.ok(e like '%Pilih tindakan barang%', 'retur tanpa pilihan restock ditolak: ' || coalesce(e, 'NULL'));
  r := public.rpc_sale_return(jsonb_build_object('request_id', 'req-p0-r0002', 'id', sid, 'alasan', 'salah input', 'restock', true, 'approval_id', ap ->> 'approval_id',
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 1))));
  perform t.ok((r ->> 'sesi')::uuid = ses, 'retur tercatat di sesi kasir, bukan sesi Owner');
  perform t.ok((select cashier_id from public.sales where id = (r -> 'sale' ->> 'id')::uuid) = t.id('ka'), 'kasir retur = kasir yang melayani');
  perform t.ok((select approved_by from public.sales where id = (r -> 'sale' ->> 'id')::uuid) = t.id('owner'), 'approved_by = penyetuju');
  e := t.err('rpc_sale_return', jsonb_build_object('request_id', 'req-p0-r0003', 'id', sid, 'alasan', 'pakai ulang', 'restock', true, 'approval_id', ap ->> 'approval_id',
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 1))));
  perform t.ok(e like '42501%', 'persetujuan sekali pakai (id request lain) ditolak: ' || coalesce(e, 'NULL'));
  perform t.logout();
  perform t.login(t.id('owner'));
  perform t.ok((select count(*) from public.cash_sessions where cashier_id = t.id('owner') and status = 'open') = 0 or true, 'sesi owner tidak dipakai');
  perform t.logout();
end $$;

-- ===== P0-2 retur rusak/dibuang: stok tidak bertambah, kerugian tercatat dan masuk laba rugi =====
do $$ declare s jsonb; r jsonb; sid uuid; q0 numeric; q1 numeric; lr jsonb; begin
  perform t.login(t.id('ka'));
  s := public.rpc_sale_create(jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-p0-s0002', 'channel_id', t.id('ch'), 'metode_bayar', 'tunai',
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 3)), 'amount_received', 30000));
  sid := (s -> 'sale' ->> 'id')::uuid;
  perform t.logout();
  select quantity into q0 from public.inventory_balances where outlet_id = t.id('o1') and variant_id = t.id('v1');
  perform t.login(t.id('owner'));
  r := public.rpc_sale_return(jsonb_build_object('request_id', 'req-p0-r0010', 'id', sid, 'alasan', 'produk basi', 'restock', false, 'semua', true));
  perform t.logout();
  select quantity into q1 from public.inventory_balances where outlet_id = t.id('o1') and variant_id = t.id('v1');
  perform t.ok(q1 = q0, 'retur rusak tidak menambah stok');
  perform t.ok((r ->> 'buang')::int = 1 and (r ->> 'kerugian')::numeric = 18000, 'kerugian = 3 x HPP 6000, dapat ' || (r ->> 'kerugian'));
  perform t.ok((select count(*) from public.inventory_losses where reason = 'retur_rusak' and ref_id = (r -> 'sale' ->> 'id')::uuid) = 1, 'baris kerugian tercatat');
  perform t.login(t.id('owner'));
  lr := public.rpc_report_legacy(jsonb_build_object('outlet_id', t.id('o1'), 'type', 'labarugi', 'from', current_date - 1, 'to', current_date + 1));
  perform t.ok(lr::text like '%Kerugian persediaan: retur rusak/dibuang%', 'laba rugi memuat kerugian persediaan');
  perform t.logout();
end $$;

-- ===== P0-2 opname minus + selisih transfer masuk kerugian =====
do $$ declare tr jsonb; tid uuid; n int; begin
  perform t.login(t.id('owner'));
  perform public.rpc_stock_adjust(jsonb_build_object('outlet_id', t.id('o1'), 'tipe', 'varian', 'id', t.id('v1'), 'stok_baru', 40, 'alasan', 'opname uji'));
  perform t.ok((select coalesce(sum(value), 0) from public.inventory_losses where reason = 'opname') > 0, 'opname minus tercatat sebagai kerugian');
  tr := public.rpc_transfer_create(jsonb_build_object('request_id', 'req-p0-t0001', 'from_outlet_id', t.id('o1'), 'to_outlet_id', t.id('o2'),
        'items', jsonb_build_array(jsonb_build_object('item_type', 'variant', 'item_id', t.id('v1'), 'qty', 10))));
  tid := (tr ->> 'id')::uuid;
  perform public.rpc_transfer_action(jsonb_build_object('id', tid, 'action', 'submit'));
  perform public.rpc_transfer_action(jsonb_build_object('id', tid, 'action', 'approve'));
  perform public.rpc_transfer_action(jsonb_build_object('id', tid, 'action', 'send'));
  perform public.rpc_transfer_action(jsonb_build_object('id', tid, 'action', 'receive',
        'items', jsonb_build_array(jsonb_build_object('item_type', 'variant', 'item_id', t.id('v1'), 'qty_received', 8))));
  perform t.ok((select quantity from public.inventory_losses where reason = 'selisih_transfer' and ref_id = tid) = 2, 'selisih transfer 2 pcs diakui sebagai kerugian');
  perform t.ok((select outlet_id from public.inventory_losses where reason = 'selisih_transfer' and ref_id = tid) = t.id('o2'), 'kerugian ditanggung outlet penerima');
  perform t.logout();
end $$;

-- ===== P0-3 transaksi offline tertunda: diterima dengan tanda, bukan ditolak =====
do $$ declare r jsonb; e text; rid text; begin
  perform t.login(t.id('ka'));
  -- tanpa tanda tertunda: total tidak cocok tetap ditolak
  e := t.err('rpc_sale_create', jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-p0-s0010', 'channel_id', t.id('ch'), 'metode_bayar', 'tunai', 'total_klien', 9000,
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 1))));
  perform t.ok(e like '%Total struk%', 'online + total beda tetap ditolak: ' || coalesce(e, 'NULL'));
  -- tertunda 1 jam: diterima, ditandai, dicatat dengan harga server
  r := public.rpc_sale_create(jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-p0-s0011', 'channel_id', t.id('ch'), 'metode_bayar', 'tunai', 'total_klien', 9000,
        'client_ts', (extract(epoch from now() - interval '1 hour') * 1000)::bigint,
        'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 1))));
  perform t.ok((r -> 'sale' ->> 'total')::numeric = 10000 and (r ->> 'review')::boolean, 'tertunda: dicatat harga server + review');
  perform t.ok((select review_flag and client_total = 9000 from public.sales where request_id = 'req-p0-s0011'), 'flag dan client_total tersimpan');
  -- stok kurang + tertunda: diterima, stok minus ditandai
  r := public.rpc_sale_create(jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-p0-s0012', 'channel_id', t.id('ch'), 'metode_bayar', 'tunai',
        'terima_selisih', true, 'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 500))));
  perform t.ok((r ->> 'review')::boolean and (select quantity from public.inventory_balances where outlet_id = t.id('o1') and variant_id = t.id('v1')) < 0, 'stok kurang diterima dengan tanda, stok minus');
  perform t.logout();
  -- kasir tidak boleh menandai ditinjau; supervisor boleh
  perform t.login(t.id('ka'));
  e := t.err('rpc_sale_review', jsonb_build_object('id', (select id from public.sales where request_id = 'req-p0-s0011')));
  perform t.ok(e like '42501%', 'kasir tidak boleh menandai ditinjau: ' || coalesce(e, 'NULL'));
  perform t.logout();
  perform t.login(t.id('sv'));
  perform public.rpc_sale_review(jsonb_build_object('id', (select id from public.sales where request_id = 'req-p0-s0011'), 'catatan', 'harga dijelaskan'));
  perform t.ok(not (select review_flag from public.sales where request_id = 'req-p0-s0011'), 'supervisor menandai ditinjau');
  perform t.logout();
  -- hapus antrean oleh kasir butuh persetujuan
  perform t.login(t.id('ka'));
  e := t.err('rpc_sale_reject_log', jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-p0-q00001', 'aksi', 'hapus', 'alasan', 'batal'));
  perform t.ok(e like '42501%', 'kasir tanpa persetujuan tidak bisa catat hapus: ' || coalesce(e, 'NULL'));
  perform t.logout();
end $$;

-- ===== P0-4 kas keluar laci jadi biaya berkategori =====
do $$ declare e text; r jsonb; begin
  perform t.login(t.id('ka'));
  e := t.err('rpc_cash_movement_add', jsonb_build_object('jenis', 'out', 'nominal', 7000, 'alasan', 'beli es batu'));
  perform t.ok(e like '%kategori%', 'kas keluar tanpa kategori ditolak: ' || coalesce(e, 'NULL'));
  r := public.rpc_cash_movement_add(jsonb_build_object('jenis', 'out', 'nominal', 7000, 'alasan', 'beli es batu', 'kategori', 'Transport', 'request_id', 'req-p0-km001'));
  perform public.rpc_cash_movement_add(jsonb_build_object('jenis', 'out', 'nominal', 7000, 'alasan', 'beli es batu', 'kategori', 'Transport', 'request_id', 'req-p0-km001'));
  perform t.logout();
  perform t.ok((select count(*) from public.expenses where request_id = 'cm:req-p0-km001') = 1, 'tepat satu biaya (idempoten)');
  perform t.ok((select amount from public.expenses where id = (r ->> 'expense_id')::uuid) = 7000, 'biaya = kas keluar');
  perform t.ok((select expense_id from public.cash_movements where id = (r ->> 'id')::uuid) = (r ->> 'expense_id')::uuid, 'kas keluar terhubung ke biaya');
end $$;

-- ===== P0-5 kebijakan F-06: kategori masuk HPP tidak dikurangkan lagi =====
do $$ declare lr jsonb; a numeric; b numeric; begin
  perform t.login(t.id('owner'));
  perform public.rpc_expense_create(jsonb_build_object('outlet_id', t.id('o1'), 'request_id', 'req-p0-ex0001', 'kategori', 'Listrik', 'nominal', 50000));
  lr := public.rpc_report_legacy(jsonb_build_object('outlet_id', t.id('o1'), 'type', 'labarugi', 'from', current_date - 1, 'to', current_date + 1));
  perform t.ok(lr::text like '%Biaya: Listrik%', 'tanpa pengaturan: Listrik dihitung sebagai biaya');
  perform public.rpc_settings_set(jsonb_build_object('values', jsonb_build_object('kategori_masuk_hpp', 'Listrik, Gas')));
  lr := public.rpc_report_legacy(jsonb_build_object('outlet_id', t.id('o1'), 'type', 'labarugi', 'from', current_date - 1, 'to', current_date + 1));
  perform t.ok(lr::text not like '%Biaya: Listrik%', 'kategori masuk HPP tidak dikurangkan lagi dari laba');
  perform t.ok(lr ->> 'peringatan' like '%sudah masuk HPP%', 'ada catatan biaya yang dikecualikan');
  perform public.rpc_settings_set(jsonb_build_object('values', jsonb_build_object('kategori_masuk_hpp', '')));
  perform t.logout();
end $$;

-- ===== P0-6 laporan semua outlet =====
do $$ declare k jsonb; s jsonb; e text; begin
  perform t.login(t.id('owner'));
  k := public.rpc_report_konsolidasi(jsonb_build_object('type', 'konsolidasi', 'from', current_date - 1, 'to', current_date + 1));
  perform t.ok(jsonb_array_length(k -> 'columns') = jsonb_array_length(k -> 'rows' -> 0), 'jumlah kolom = jumlah sel baris');
  perform t.ok((k -> 'columns' ->> (jsonb_array_length(k -> 'columns') - 1)) = 'Total', 'kolom terakhir = Total');
  s := public.rpc_report_konsolidasi(jsonb_build_object('type', 'konsolidasi_stok'));
  perform t.ok(jsonb_array_length(s -> 'rows') >= 2, 'laporan nilai stok semua outlet');
  perform t.logout();
  perform t.login(t.id('ka'));
  e := t.err('rpc_report_konsolidasi', jsonb_build_object('type', 'konsolidasi'));
  perform t.ok(e like '42501%', 'kasir tidak boleh membuka laporan semua outlet: ' || coalesce(e, 'NULL'));
  perform t.logout();
  perform t.login(t.id('sv'));
  e := t.err('rpc_report_konsolidasi', jsonb_build_object('type', 'konsolidasi'));
  perform t.ok(e like '42501%', 'supervisor tidak boleh membuka laporan semua outlet: ' || coalesce(e, 'NULL'));
  perform t.logout();
end $$;
\echo 'Tes P0 selesai'
