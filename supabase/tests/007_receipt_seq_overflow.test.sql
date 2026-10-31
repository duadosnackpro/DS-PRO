-- Tes migrasi 0028: nomor struk tidak boleh bentrok setelah urutan ke-999 dalam sehari (lpad memotong). Dijalankan setelah 001-006.
\set ON_ERROR_STOP on

do $$ begin
  perform t.ok(app.seq_text(7) = '007' and app.seq_text(99) = '099' and app.seq_text(999) = '999', 'seq_text: < 1000 diberi nol di depan 3 digit');
  perform t.ok(app.seq_text(1000) = '1000' and app.seq_text(1001) = '1001' and app.seq_text(12345) = '12345', 'seq_text: >= 1000 tidak dipotong');
end $$;

-- Perilaku nyata: outlet baru dengan counter 998 -> tiga penjualan = 999, 1000, 1001 (sebelum perbaikan, yang kedua gagal 'sales_receipt_key').
do $$
declare o uuid; org uuid; tz text; n1 text; n2 text; n3 text; n4 text; day_ date; k uuid := gen_random_uuid();
begin
  select id into org from public.organizations limit 1;
  insert into public.outlets (organization_id, code, name) values (org, 'OUT-SQ', 'Seq Overflow') returning id into o;
  select timezone into tz from public.outlets where id = o; day_ := (now() at time zone tz)::date;
  insert into public.inventory_balances (outlet_id, variant_id, quantity, avg_cost) values (o, t.id('v1'), 1000, 6000);
  insert into app.outlet_counters (outlet_id, kind, day, last_seq) values (o, 'sale', day_, 998);
  insert into auth.users (id, email) values (k, 'sq@t');
  insert into public.profiles (id, username, full_name) values (k, 'kasir.sq', 'Kasir SQ');
  insert into public.memberships (user_id, outlet_id, role) values (k, o, 'kasir');
  insert into public.cash_sessions (outlet_id, cashier_id, opening_cash, status) values (o, k, 0, 'open');

  perform t.login(k);
  n1 := (public.rpc_sale_create(jsonb_build_object('outlet_id', o, 'request_id', 'req-seq-0001', 'channel_id', t.id('ch'), 'metode_bayar', 'tunai',
          'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 1)))) -> 'sale' ->> 'nomor');
  n2 := (public.rpc_sale_create(jsonb_build_object('outlet_id', o, 'request_id', 'req-seq-0002', 'channel_id', t.id('ch'), 'metode_bayar', 'tunai',
          'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 1)))) -> 'sale' ->> 'nomor');
  n3 := (public.rpc_sale_create(jsonb_build_object('outlet_id', o, 'request_id', 'req-seq-0003', 'channel_id', t.id('ch'), 'metode_bayar', 'tunai',
          'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 1)))) -> 'sale' ->> 'nomor');
  -- percobaan ulang dengan request_id sama tetap idempoten (hasil lama, bukan nomor baru)
  n4 := (public.rpc_sale_create(jsonb_build_object('outlet_id', o, 'request_id', 'req-seq-0003', 'channel_id', t.id('ch'), 'metode_bayar', 'tunai',
          'items', jsonb_build_array(jsonb_build_object('variant_id', t.id('v1'), 'qty', 1)))) -> 'sale' ->> 'nomor');
  perform t.logout();
  perform t.ok(n1 like '%-999' and n2 like '%-1000' and n3 like '%-1001', 'nomor 999, 1000, 1001 berurutan dan berbeda: ' || n1 || ' ' || n2 || ' ' || n3);
  perform t.ok(n4 = n3, 'percobaan ulang idempoten: ' || n4);
  perform t.ok((select count(distinct receipt_no) from public.sales where outlet_id = o) = 3, 'tiga nomor struk unik tersimpan');
  perform t.ok((select last_seq from app.outlet_counters where outlet_id = o and kind = 'sale' and day = day_) = 1001, 'counter maju terus ke 1001');
end $$;

-- Penjaga regresi: tidak boleh ada fungsi di skema app yang membentuk nomor dengan lpad(v_seq...) dan fungsi terdampak kini memakai seq_text.
do $$
declare bad text; users int;
begin
  select string_agg(p.proname, ', ') into bad from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'app' and p.prokind = 'f' and pg_get_functiondef(p.oid) like '%lpad(v_seq::text, 3%';
  perform t.ok(bad is null, 'tidak ada fungsi yang memotong nomor urut dengan lpad: ' || coalesce(bad, '-'));
  select count(*) into users from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'app' and p.prokind = 'f' and pg_get_functiondef(p.oid) like '%app.seq_text(v_seq)%';
  perform t.ok(users >= 4, 'sale_create, sale_return, transfer_create, shopee_import memakai seq_text (ditemukan ' || users || ')');
  -- fungsi di skema app yang memakai next_seq tetapi bukan lewat seq_text/lpad lain tidak ada (pola lpad(<apa pun>::text, 3 yang memotong)
  select string_agg(p.proname, ', ') into bad from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'app' and p.prokind = 'f' and p.proname <> 'seq_text' and pg_get_functiondef(p.oid) ~* 'lpad\(\s*v_seq';
  perform t.ok(bad is null, 'tidak ada lpad(v_seq ...) dalam bentuk lain: ' || coalesce(bad, '-'));
end $$;

select 'Tes nomor urut struk selesai' as hasil;
