-- Tes migrasi 0026 (galat klien + sinyal sinkronisasi). Dijalankan setelah 001-004 (memakai data uji t.ids). Gagal keras bila ekspektasi tidak terpenuhi.
\set ON_ERROR_STOP on

-- ===== Pelaporan galat klien =====
do $$ declare r jsonb; e text; n0 bigint; begin
  -- tanpa login ditolak
  perform t.logout();
  e := t.err('rpc_client_error_log', '{"events":[]}'::jsonb);
  perform t.ok(e like '28000%' or e like '42501%', 'laporan galat tanpa sesi ditolak: ' || coalesce(e, 'NULL'));

  perform t.login(t.id('ka'));
  r := public.rpc_client_error_log(jsonb_build_object('outlet_id', t.id('o1'), 'events', jsonb_build_array(
        jsonb_build_object('kind', 'boot', 'session_id', 'sess-aaaa-0001', 'app_version', '2.5.2', 'online', true),
        jsonb_build_object('kind', 'error', 'session_id', 'sess-aaaa-0001', 'message', repeat('x', 500), 'stack', repeat('y', 3000), 'app_version', '2.5.2'),
        jsonb_build_object('kind', 'boot', 'session_id', 'sess-bbbb-0002', 'app_version', '2.5.2'),
        jsonb_build_object('kind', 'sembarang', 'session_id', 'sess-cccc-0003'),
        jsonb_build_object('kind', 'error', 'session_id', 'pendek'))));
  perform t.ok((r ->> 'diterima')::int = 3, 'hanya kejadian valid diterima (3 dari 5): ' || r::text);
  perform t.logout();
  perform t.ok((select max(length(message)) from app.client_errors) = 300 and (select max(length(stack)) from app.client_errors) = 1000, 'pesan dan stack dipotong');
  perform t.login(t.id('ka'));
  -- payload tidak berbentuk larik tidak melempar galat
  r := public.rpc_client_error_log('{"events":"bukan larik"}'::jsonb);
  perform t.ok((r ->> 'diterima')::int = 0, 'events bukan larik diabaikan tanpa galat');
  -- outlet tak berhak disimpan sebagai null, bukan galat
  r := public.rpc_client_error_log(jsonb_build_object('outlet_id', gen_random_uuid(), 'events', jsonb_build_array(jsonb_build_object('kind', 'boot', 'session_id', 'sess-dddd-0004'))));
  perform t.logout();
  perform t.ok((select outlet_id is null from app.client_errors where session_id = 'sess-dddd-0004'), 'outlet tanpa hak disimpan null');
  perform t.login(t.id('ka'));
  -- batas laju 60 per menit
  for i in 1..70 loop perform public.rpc_client_error_log(jsonb_build_object('events', jsonb_build_array(jsonb_build_object('kind', 'rt', 'session_id', 'sess-eeee-0005', 'message', 'rt ' || i)))); end loop;
  perform t.logout();
  perform t.ok((select count(*) from app.client_errors where session_id = 'sess-eeee-0005') <= 60, 'batas laju menahan > 60 kejadian per menit');
  perform t.login(t.id('ka'));
  -- kasir tidak boleh membaca laporan
  e := t.err('rpc_client_error_report', '{}'::jsonb);
  perform t.ok(e like '42501%', 'kasir tidak boleh membaca laporan galat: ' || coalesce(e, 'NULL'));
  perform t.logout();

  -- klien tidak dapat membaca tabelnya langsung
  perform t.login(t.id('owner'));
  begin perform count(*) from app.client_errors; perform t.ok(false, 'owner tidak seharusnya bisa SELECT app.client_errors'); exception when insufficient_privilege then perform t.ok(true, 'app.client_errors tidak bisa dibaca langsung'); end;
  r := public.rpc_client_error_report('{"days": 7}'::jsonb);
  perform t.ok((r ->> 'sesi_total')::int >= 3 and (r ->> 'sesi_error')::int >= 1, 'laporan: sesi_total dan sesi_error terhitung: ' || r::text);
  perform t.ok((r ->> 'error_rate_persen')::numeric > 0 and jsonb_array_length(r -> 'teratas') >= 1 and jsonb_array_length(r -> 'per_hari') >= 1, 'laporan: error rate, teratas, per_hari terisi');
  perform t.logout();

  -- retensi
  update app.client_errors set created_at = now() - interval '40 days' where session_id = 'sess-bbbb-0002';
  perform t.ok(app.purge_client_errors(30) >= 1, 'purge_client_errors menghapus data lama');
  e := t.err('rpc_client_error_log', '{}'::jsonb); -- (sesi sudah keluar) tetap ditolak
  perform t.ok(e like '28000%' or e like '42501%', 'setelah logout tetap ditolak');
end $$;

-- ===== Sinyal sinkronisasi =====
do $$ declare c0 bigint; c1 bigint; n int; begin
  delete from public.sync_events;
  -- perubahan stok di o1 => sinyal 'stock' untuk o1 (digabung dalam 2 detik)
  perform t.login(t.id('owner'));
  perform public.rpc_stock_adjust(jsonb_build_object('outlet_id', t.id('o1'), 'tipe', 'varian', 'id', t.id('v1'), 'stok_baru', 77, 'hpp', 6000, 'alasan', 'uji sinyal'));
  perform public.rpc_stock_adjust(jsonb_build_object('outlet_id', t.id('o1'), 'tipe', 'varian', 'id', t.id('v1'), 'stok_baru', 78, 'hpp', 6000, 'alasan', 'uji sinyal 2'));
  perform t.logout();
  select count(*) into n from public.sync_events where kind = 'stock' and outlet_id = t.id('o1');
  perform t.ok(n = 1, 'dua perubahan stok beruntun digabung menjadi satu sinyal (n=' || n || ')');
  perform t.ok((select count(*) from public.sync_events where kind = 'stock' and outlet_id is distinct from t.id('o1')) = 0, 'tidak ada sinyal stok untuk outlet lain');

  -- perubahan katalog => sinyal 'cat' global
  update public.channels set updated_at = now() where id = t.id('ch');
  perform t.ok((select count(*) from public.sync_events where kind = 'cat' and outlet_id is null) = 1, 'perubahan katalog menghasilkan sinyal cat global');

  -- sinyal tidak membawa data sensitif: hanya kolom id, created_at, outlet_id, kind
  perform t.ok((select array_agg(column_name::text order by column_name) from information_schema.columns where table_schema = 'public' and table_name = 'sync_events')
               = array['created_at', 'id', 'kind', 'outlet_id'], 'sync_events hanya memuat id, created_at, outlet_id, kind');

  -- RLS: kasir o1 melihat sinyal o1 dan global, tidak melihat sinyal outlet lain
  insert into public.sync_events (outlet_id, kind) values (t.id('o2'), 'stock');
  perform t.login(t.id('ka'));
  perform t.ok((select count(*) from public.sync_events where outlet_id = t.id('o2')) = 0, 'kasir o1 tidak melihat sinyal o2 (RLS)');
  perform t.ok((select count(*) from public.sync_events where outlet_id = t.id('o1')) >= 1, 'kasir o1 melihat sinyal o1');
  perform t.ok((select count(*) from public.sync_events where outlet_id is null) >= 1, 'kasir melihat sinyal global');
  begin insert into public.sync_events (kind) values ('cat'); perform t.ok(false, 'klien tidak boleh INSERT sinyal'); exception when insufficient_privilege then perform t.ok(true, 'klien tidak bisa INSERT sinyal'); end;
  perform t.logout();
end $$;

select 'Tes observabilitas dan sinyal sinkronisasi selesai' as hasil;
