-- Tes migrasi 0029: app.sync_signal tidak boleh memakai kondisi yang mematikan indeks (fungsi volatile / IS NOT DISTINCT FROM). Dijalankan setelah 001-007.
\set ON_ERROR_STOP on
do $$
declare src text := pg_get_functiondef('app.sync_signal(uuid,text)'::regprocedure); n1 bigint; n2 bigint; n3 bigint; o uuid := t.id('o1');
begin
  perform t.ok(src !~* 'created_at\s*>\s*clock_timestamp\(\)', 'sync_signal: tidak membandingkan created_at langsung dengan clock_timestamp() (volatile = seq scan)');
  perform t.ok(src !~* 'is not distinct from', 'sync_signal: tanpa IS NOT DISTINCT FROM (tidak bisa memakai indeks btree)');
  -- perilaku tetap: satu sinyal per outlet per jenis per 2 detik, outlet berbeda dan outlet null terpisah
  delete from public.sync_events;
  perform app.sync_signal(o, 'stock'); perform app.sync_signal(o, 'stock'); perform app.sync_signal(o, 'stock');
  select count(*) into n1 from public.sync_events where outlet_id = o and kind = 'stock';
  perform t.ok(n1 = 1, 'tiga panggilan beruntun => satu sinyal stok: ' || n1);
  perform app.sync_signal(t.id('o2'), 'stock');
  select count(*) into n2 from public.sync_events where kind = 'stock';
  perform t.ok(n2 = 2, 'outlet lain mendapat sinyal sendiri: ' || n2);
  perform app.sync_signal(null, 'cat'); perform app.sync_signal(null, 'cat');
  select count(*) into n3 from public.sync_events where kind = 'cat' and outlet_id is null;
  perform t.ok(n3 = 1, 'sinyal katalog (outlet null) digabung juga: ' || n3);
  update public.sync_events set created_at = clock_timestamp() - interval '3 seconds';
  perform app.sync_signal(o, 'stock');
  perform t.ok((select count(*) from public.sync_events where outlet_id = o and kind = 'stock') = 2, 'sesudah lewat 2 detik sinyal baru dibuat');
end $$;
select 'Tes indeks sync_signal selesai' as hasil;
