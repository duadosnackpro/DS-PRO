-- Tes migrasi 0027 (laporan stok minimum/stockout, lead time transfer, durasi shift). Dijalankan setelah 001-005 (memakai t.ids).
-- Data dibuat langsung sebagai superuser dengan waktu terkontrol supaya angka bisa diperiksa dengan hitungan tangan.
-- Tiap skenario memakai outlet baru agar tidak tercampur data tes lain.
\set ON_ERROR_STOP on

-- ===== Akses dan validasi =====
do $$ declare e text; begin
  perform t.logout();
  e := t.err('rpc_report_ops', jsonb_build_object('type', 'stok_minimum', 'outlet_id', t.id('o1')));
  perform t.ok(e like '28000%', 'tanpa sesi ditolak: ' || coalesce(e, 'NULL'));
  perform t.login(t.id('ka'));
  e := t.err('rpc_report_ops', jsonb_build_object('type', 'stok_minimum', 'outlet_id', t.id('o1')));
  perform t.ok(e like '42501%', 'kasir tidak boleh membuka stok minimum: ' || coalesce(e, 'NULL'));
  e := t.err('rpc_report_ops', jsonb_build_object('type', 'durasi_shift', 'outlet_id', t.id('o1')));
  perform t.ok(e like '42501%', 'kasir tidak boleh membuka durasi shift: ' || coalesce(e, 'NULL'));
  perform t.logout();
  perform t.login(t.id('ks'));   -- peran stok: boleh stok_minimum dan lead_transfer, tidak boleh durasi_shift
  e := t.err('rpc_report_ops', jsonb_build_object('type', 'stok_minimum', 'outlet_id', t.id('o1')));
  perform t.ok(e is null, 'peran stok boleh stok minimum: ' || coalesce(e, 'NULL'));
  e := t.err('rpc_report_ops', jsonb_build_object('type', 'lead_transfer', 'outlet_id', t.id('o1')));
  perform t.ok(e is null, 'peran stok boleh lead time: ' || coalesce(e, 'NULL'));
  e := t.err('rpc_report_ops', jsonb_build_object('type', 'durasi_shift', 'outlet_id', t.id('o1')));
  perform t.ok(e like '42501%', 'peran stok tidak boleh durasi shift: ' || coalesce(e, 'NULL'));
  e := t.err('rpc_report_ops', jsonb_build_object('type', 'stok_minimum', 'outlet_id', t.id('o2')));
  perform t.ok(e like '42501%', 'peran stok outlet lain ditolak: ' || coalesce(e, 'NULL'));
  perform t.logout();
  perform t.login(t.id('owner'));
  e := t.err('rpc_report_ops', jsonb_build_object('type', 'sembarang', 'outlet_id', t.id('o1')));
  perform t.ok(e like '22023%', 'jenis tak dikenal ditolak: ' || coalesce(e, 'NULL'));
  e := t.err('rpc_report_ops', jsonb_build_object('type', 'lead_transfer', 'outlet_id', t.id('o1'), 'from', '2020-01-01', 'to', '2026-12-31'));
  perform t.ok(e like '22023%', 'rentang > 400 hari ditolak: ' || coalesce(e, 'NULL'));
  e := t.err('rpc_report_ops', jsonb_build_object('type', 'lead_transfer', 'outlet_id', t.id('o1'), 'from', '2026-02-02', 'to', '2026-02-01'));
  perform t.ok(e like '22023%', 'rentang terbalik ditolak: ' || coalesce(e, 'NULL'));
  perform t.logout();
end $$;

-- ===== Stockout: garis waktu saldo dari ledger =====
-- Rentang 10 hari (hari ini - 9 .. hari ini). t0 = awal hari pertama (zona outlet). Item X:
--   t0-2h  : saldo awal 10 (sebelum rentang)       -> aman
--   t0+1d  : jual 10  -> 0   (HABIS #1)
--   t0+3d  : produksi +20 -> 20                    (habis tepat 2 hari)
--   t0+5d  : jual 25 -> -5   (HABIS #2, minus)
--   t0+6d  : penyesuaian +30 -> 25                 (habis tepat 1 hari)  => total habis 3 hari, 2 kejadian
do $$
declare o uuid; pr uuid; vx uuid; vy uuid; vz uuid; m2 uuid; tz text; t0 timestamptz; r jsonb; rw jsonb; mon numeric; ex numeric;
begin
  select id into o from public.outlets where code = 'OUT-001';
  select timezone into tz from public.outlets where id = o;
  t0 := ((now() at time zone tz)::date - 9)::timestamp at time zone tz;
  insert into public.products (name, category) values ('ZZStock', 'Uji') returning id into pr;
  insert into public.product_variants (product_id, sku) values (pr, 'X') returning id into vx;
  insert into public.product_variants (product_id, sku) values (pr, 'Y') returning id into vy;
  insert into public.product_variants (product_id, sku) values (pr, 'Z') returning id into vz;
  insert into public.materials (name, unit, min_stock) values ('ZZBahanMin', 'kg', 10) returning id into m2;

  insert into public.inventory_balances (outlet_id, variant_id, quantity, min_qty) values (o, vx, 25, 0), (o, vy, 3, 5), (o, vz, 0, 0);
  insert into public.inventory_material_balances (outlet_id, material_id, quantity) values (o, m2, 4);

  insert into public.stock_movements (outlet_id, item_type, item_id, movement_type, quantity_delta, balance_after, created_at) values
    (o, 'variant', vx, 'opening',       10, 10, t0 - interval '2 hours'),
    (o, 'variant', vx, 'sale',         -10,  0, t0 + interval '1 day'),
    (o, 'variant', vx, 'production_in', 20, 20, t0 + interval '3 days'),
    (o, 'variant', vx, 'sale',         -25, -5, t0 + interval '5 days'),
    (o, 'variant', vx, 'adjustment',    30, 25, t0 + interval '6 days'),
    -- Y: dipakai tetapi tidak pernah habis; sekarang di bawah minimum (3 <= 5)
    (o, 'variant', vy, 'opening',       10, 10, t0 - interval '2 hours'),
    (o, 'variant', vy, 'sale',          -7,  3, t0 + interval '2 days'),
    -- Z: habis sejak t0+8d sampai sekarang (belum terisi)
    (o, 'variant', vz, 'opening',        4,  4, t0 - interval '2 hours'),
    (o, 'variant', vz, 'sale',          -4,  0, t0 + interval '8 days');

  perform t.login(t.id('owner'));
  r := public.rpc_report_ops(jsonb_build_object('type', 'stok_minimum', 'outlet_id', o, 'from', ((now() at time zone tz)::date - 9)::text, 'to', (now() at time zone tz)::date::text));
  perform t.logout();
  perform t.ok(r ->> 'type' = 'stok_minimum' and jsonb_array_length(r -> 'columns') = jsonb_array_length(r -> 'fmt'), 'bentuk keluaran sama dengan laporan lain');

  -- X
  select e into rw from jsonb_array_elements(r -> 'rows') e where e ->> 1 = 'ZZStock X';
  perform t.ok(rw is not null, 'baris X ada (pernah habis walau kini aman): ' || (r -> 'rows')::text);
  perform t.ok(rw ->> 5 = 'Aman', 'X berstatus Aman sekarang: ' || (rw ->> 5));
  perform t.ok((rw ->> 6)::int = 2, 'X: dua kejadian habis (termasuk yang minus): ' || (rw ->> 6));
  perform t.ok((rw ->> 7)::numeric = 3.0, 'X: lama habis tepat 3 hari: ' || (rw ->> 7));
  mon := extract(epoch from (now() - t0));
  ex := round(3 * 86400 / mon * 100, 1);
  perform t.ok((rw ->> 8)::numeric = ex, 'X: waktu habis = 3 hari / waktu terpantau (' || ex || '): ' || (rw ->> 8));
  -- Y
  select e into rw from jsonb_array_elements(r -> 'rows') e where e ->> 1 = 'ZZStock Y';
  perform t.ok(rw ->> 5 = 'Di bawah minimum' and (rw ->> 6)::int = 0 and (rw ->> 7)::numeric = 0, 'Y: di bawah minimum, tidak pernah habis: ' || rw::text);
  -- Z
  select e into rw from jsonb_array_elements(r -> 'rows') e where e ->> 1 = 'ZZStock Z';
  perform t.ok(rw ->> 5 = 'Habis' and (rw ->> 6)::int = 1, 'Z: habis dengan 1 kejadian: ' || rw::text);
  perform t.ok((rw ->> 7)::numeric between 0.9 and 2.1, 'Z: lama habis = sejak t0+8d sampai sekarang (kira-kira 1-2 hari): ' || (rw ->> 7));
  -- Bahan tanpa mutasi keluar: tidak dipantau tetapi tetap muncul karena di bawah minimum
  select e into rw from jsonb_array_elements(r -> 'rows') e where e ->> 1 = 'ZZBahanMin';
  perform t.ok(rw ->> 5 = 'Di bawah minimum' and rw ->> 8 is null, 'bahan di bawah minimum muncul tanpa angka stockout: ' || coalesce(rw::text, 'NULL'));
  -- Ringkasan
  perform t.ok((select (s ->> 'value')::numeric from jsonb_array_elements(r -> 'summary') s where s ->> 'label' = 'Item dipantau') >= 3, 'ringkasan: minimal X, Y, Z dipantau');
  perform t.ok((select (s ->> 'value')::numeric from jsonb_array_elements(r -> 'summary') s where s ->> 'label' like 'Stockout rate%') between 0 and 100, 'stockout rate 0..100');
  perform t.ok((select (s ->> 'value')::numeric from jsonb_array_elements(r -> 'summary') s where s ->> 'label' = 'Item habis sekarang') >= 1, 'ringkasan: Z habis sekarang');
  perform t.ok((select (s ->> 'value')::numeric from jsonb_array_elements(r -> 'summary') s where s ->> 'label' = 'Item di bawah minimum') >= 2, 'ringkasan: Y dan bahan di bawah minimum');
  perform t.ok(r ->> 'peringatan' like '%jam kalender%', 'ada catatan definisi stockout rate');
end $$;

-- Rentang yang seluruhnya sesudah semua kejadian tidak menghitung habis X lama (X habis hanya di hari ke-2..3 dan 6..7)
do $$
declare o uuid; tz text; r jsonb; rw jsonb;
begin
  select id into o from public.outlets where code = 'OUT-001'; select timezone into tz from public.outlets where id = o;
  perform t.login(t.id('owner'));
  -- Rentang hari ke-8..hari ini: titik awal X = saldo 25 (aman). Z mulai habis di dalam rentang.
  r := public.rpc_report_ops(jsonb_build_object('type', 'stok_minimum', 'outlet_id', o, 'from', ((now() at time zone tz)::date - 1)::text, 'to', (now() at time zone tz)::date::text));
  perform t.logout();
  select e into rw from jsonb_array_elements(r -> 'rows') e where e ->> 1 = 'ZZStock X';
  perform t.ok(rw is null, 'X tidak muncul pada rentang tanpa kejadian habis (saldo awal rentang 25): ' || coalesce(rw::text, 'NULL'));
end $$;

-- ===== Lead time transfer =====
-- Outlet baru L1 -> L2. Tiga transfer diterima (lama di jalan 24, 12, 100 jam) dan satu masih di jalan.
do $$
declare l1 uuid; l2 uuid; org uuid; r jsonb; tid uuid; s jsonb;
begin
  select id into org from public.organizations limit 1;
  insert into public.outlets (organization_id, code, name) values (org, 'OUT-L1', 'Lead Satu') returning id into l1;
  insert into public.outlets (organization_id, code, name) values (org, 'OUT-L2', 'Lead Dua') returning id into l2;
  insert into public.stock_transfers (number, from_outlet_id, to_outlet_id, status, requested_by, created_at, sent_at, received_at) values
    ('TL-0001', l1, l2, 'received', t.id('owner'), now() - interval '40 hours', now() - interval '30 hours', now() - interval '6 hours') returning id into tid;
  insert into public.stock_transfer_items (transfer_id, item_type, item_id, qty_requested, qty_sent, qty_received) values
    (tid, 'variant', t.id('v1'), 10, 10, 8), (tid, 'variant', t.id('v2'), 5, 5, 5);   -- satu item selisih
  insert into public.stock_transfers (number, from_outlet_id, to_outlet_id, status, requested_by, created_at, sent_at, received_at) values
    ('TL-0002', l2, l1, 'received', t.id('owner'), now() - interval '20 hours', now() - interval '16 hours', now() - interval '4 hours'),
    ('TL-0003', l1, l2, 'received', t.id('owner'), now() - interval '130 hours', now() - interval '120 hours', now() - interval '20 hours');
  insert into public.stock_transfers (number, from_outlet_id, to_outlet_id, status, requested_by, created_at, sent_at) values
    ('TL-0004', l1, l2, 'sent', t.id('owner'), now() - interval '5 hours', now() - interval '3 hours');
  -- transfer di antara outlet lain tidak ikut terhitung
  insert into public.stock_transfers (number, from_outlet_id, to_outlet_id, status, requested_by, created_at, sent_at, received_at) values
    ('TL-0005', t.id('o1'), t.id('o2'), 'received', t.id('owner'), now() - interval '9 hours', now() - interval '8 hours', now() - interval '1 hour');

  perform t.login(t.id('owner'));
  r := public.rpc_report_ops(jsonb_build_object('type', 'lead_transfer', 'outlet_id', l1));
  perform t.logout();
  perform t.ok(jsonb_array_length(r -> 'rows') = 3, 'tiga transfer diterima pada outlet L1: ' || jsonb_array_length(r -> 'rows'));
  perform t.ok((select (x ->> 'value')::numeric from jsonb_array_elements(r -> 'summary') x where x ->> 'label' = 'Transfer diterima') = 3, 'ringkasan: 3 transfer');
  perform t.ok((select (x ->> 'value')::numeric from jsonb_array_elements(r -> 'summary') x where x ->> 'label' like 'Rata-rata%') = 45.3, 'rata-rata (24+12+100)/3 = 45.3');
  perform t.ok((select (x ->> 'value')::numeric from jsonb_array_elements(r -> 'summary') x where x ->> 'label' like 'Median%') = 24, 'median 24');
  perform t.ok((select (x ->> 'value')::numeric from jsonb_array_elements(r -> 'summary') x where x ->> 'label' like 'P90%') = 84.8, 'P90 84.8');
  perform t.ok((select (x ->> 'value')::numeric from jsonb_array_elements(r -> 'summary') x where x ->> 'label' like 'Terlama%') = 100, 'terlama 100');
  perform t.ok((select (x ->> 'value')::numeric from jsonb_array_elements(r -> 'summary') x where x ->> 'label' like 'Lebih dari 72%') = 1, 'satu transfer > 72 jam');
  select e into s from jsonb_array_elements(r -> 'rows') e where e ->> 0 = 'TL-0001';
  perform t.ok((s ->> 5)::numeric = 24 and (s ->> 6)::numeric = 34 and (s ->> 7)::int = 2 and (s ->> 8)::int = 1, 'baris TL-0001: di jalan 24 jam, total 34 jam, 2 item, 1 selisih: ' || s::text);
  perform t.ok(r ->> 'peringatan' like '%1 transfer masih di jalan%', 'peringatan menyebut transfer yang masih di jalan: ' || (r ->> 'peringatan'));
  -- tanpa transfer: nol, bukan galat
  perform t.login(t.id('owner'));
  r := public.rpc_report_ops(jsonb_build_object('type', 'lead_transfer', 'outlet_id', t.id('kit')));
  perform t.logout();
  perform t.ok(jsonb_array_length(r -> 'rows') = 0 and (select (x ->> 'value')::numeric from jsonb_array_elements(r -> 'summary') x where x ->> 'label' = 'Transfer diterima') = 0, 'tanpa data: nol, bukan galat');
end $$;

-- ===== Durasi shift =====
-- Outlet baru S1, tiga kasir baru: shift 8 jam (40 trx), shift 10 jam tanpa transaksi (buka otomatis), shift masih buka 20 jam.
do $$
declare s1 uuid; org uuid; a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid();
        sa uuid; sb uuid; sc uuid; r jsonb; rw jsonb;
begin
  select id into org from public.organizations limit 1;
  insert into public.outlets (organization_id, code, name) values (org, 'OUT-S1', 'Shift Satu') returning id into s1;
  insert into auth.users (id, email) values (a, 'sa@t'), (b, 'sb@t'), (c, 'sc@t');
  insert into public.profiles (id, username, full_name) values (a, 'shift.a', 'Shift A'), (b, 'shift.b', 'Shift B'), (c, 'shift.c', 'Shift C');
  insert into public.cash_sessions (outlet_id, cashier_id, opened_at, closed_at, opening_cash, status, difference, actual_cash, expected_cash, auto_opened)
    values (s1, a, now() - interval '3 days', now() - interval '3 days' + interval '8 hours', 100000, 'closed', -5000, 295000, 300000, false) returning id into sa;
  insert into public.cash_sessions (outlet_id, cashier_id, opened_at, closed_at, opening_cash, status, difference, actual_cash, expected_cash, auto_opened)
    values (s1, b, now() - interval '2 days', now() - interval '2 days' + interval '10 hours', 0, 'closed', 0, 0, 0, true) returning id into sb;
  insert into public.cash_sessions (outlet_id, cashier_id, opened_at, opening_cash, status)
    values (s1, c, now() - interval '20 hours', 50000, 'open') returning id into sc;
  insert into public.sales (outlet_id, receipt_no, request_id, channel_id, cashier_id, cash_session_id, subtotal, total, payment_method, sold_at)
    select s1, 'S1-' || g, 'req-shift-' || g, t.id('ch'), a, sa, 10000, 10000, 'tunai', now() - interval '3 days' + interval '1 hour' from generate_series(1, 40) g;

  perform t.login(t.id('owner'));
  r := public.rpc_report_ops(jsonb_build_object('type', 'durasi_shift', 'outlet_id', s1));
  perform t.logout();
  perform t.ok(jsonb_array_length(r -> 'rows') = 3, 'tiga shift: ' || jsonb_array_length(r -> 'rows'));
  select e into rw from jsonb_array_elements(r -> 'rows') e where e ->> 0 = 'Shift A';
  perform t.ok((rw ->> 3)::numeric = 8.0 and (rw ->> 4)::int = 40 and (rw ->> 5)::numeric = 5.0 and (rw ->> 6)::numeric = 400000 and (rw ->> 7)::numeric = -5000,
               'Shift A: 8 jam, 40 trx, 5 trx/jam, omzet 400000, selisih -5000: ' || rw::text);
  select e into rw from jsonb_array_elements(r -> 'rows') e where e ->> 0 = 'Shift B';
  perform t.ok((rw ->> 3)::numeric = 10.0 and (rw ->> 4)::int = 0 and rw ->> 8 = 'ya', 'Shift B: 10 jam, 0 trx, buka otomatis: ' || rw::text);
  select e into rw from jsonb_array_elements(r -> 'rows') e where e ->> 0 = 'Shift C';
  perform t.ok(rw ->> 2 = 'masih buka' and (rw ->> 3)::numeric between 19.9 and 20.1 and rw -> 7 = 'null'::jsonb, 'Shift C masih buka ~20 jam, tanpa selisih: ' || rw::text);
  perform t.ok((select (x ->> 'value')::numeric from jsonb_array_elements(r -> 'summary') x where x ->> 'label' = 'Shift') = 3, 'ringkasan: 3 shift');
  perform t.ok((select (x ->> 'value')::numeric from jsonb_array_elements(r -> 'summary') x where x ->> 'label' like 'Rata-rata durasi%') = 9.0, 'rata-rata shift tertutup (8+10)/2 = 9.0 (yang masih buka tidak masuk)');
  perform t.ok((select (x ->> 'value')::numeric from jsonb_array_elements(r -> 'summary') x where x ->> 'label' = 'Shift > 16 jam') = 1, 'satu shift > 16 jam (yang masih buka)');
  perform t.ok((select (x ->> 'value')::numeric from jsonb_array_elements(r -> 'summary') x where x ->> 'label' = 'Shift tanpa transaksi') = 1, 'satu shift tertutup tanpa transaksi');
  perform t.ok((select (x ->> 'value')::numeric from jsonb_array_elements(r -> 'summary') x where x ->> 'label' = 'Dibuka otomatis') = 1, 'satu dibuka otomatis');
  perform t.ok(r ->> 'peringatan' like '%lupa ditutup%' and r ->> 'peringatan' like '%belum terukur%', 'peringatan: shift menggantung dan batas pengukuran: ' || (r ->> 'peringatan'));
end $$;

select 'Tes laporan operasional selesai' as hasil;
