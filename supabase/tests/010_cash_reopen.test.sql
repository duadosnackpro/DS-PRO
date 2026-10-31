-- Tes migrasi 0031: buka kembali penutupan kasir yang salah input. Dijalankan setelah 001-009 (memakai t.ids: owner, ka, sv, o1).
\set ON_ERROR_STOP on
do $$
declare sid uuid; e text; r jsonb; n0 bigint; s public.cash_sessions;
begin
  update public.cash_sessions set status = 'closed', closed_at = now() where status = 'open' and cashier_id = t.id('ka');   -- sisa tes lain
  perform t.login(t.id('ka'));
  perform public.rpc_cash_open(jsonb_build_object('outlet_id', t.id('o1'), 'modal_awal', 100000));
  r := public.rpc_cash_close(jsonb_build_object('uang_fisik', 1, 'catatan', 'salah ketik uang laci'));   -- salah input
  sid := (r ->> 'id')::uuid;
  e := t.err('rpc_cash_reopen', jsonb_build_object('id', sid, 'alasan', 'salah ketik'));
  perform t.ok(e like '42501%', 'kasir tidak boleh membuka kembali penutupan: ' || coalesce(e, 'NULL'));
  perform t.logout();

  perform t.login(t.id('sv'));
  e := t.err('rpc_cash_reopen', jsonb_build_object('id', sid, 'alasan', 'x'));
  perform t.ok(e like '22023%', 'alasan wajib (min. 3 huruf): ' || coalesce(e, 'NULL'));
  perform t.logout();

  select count(*) into n0 from public.audit_logs where action = 'cash_reopen';
  perform t.login(t.id('sv'));
  r := public.rpc_cash_reopen(jsonb_build_object('id', sid, 'alasan', 'salah ketik uang laci'));
  perform t.ok((r ->> 'dibuka_kembali')::boolean, 'supervisor boleh membuka kembali penutupan kasir lain');
  e := t.err('rpc_cash_reopen', jsonb_build_object('id', sid, 'alasan', 'sekali lagi'));
  perform t.ok(e like 'P0001%', 'sesi yang sudah terbuka tidak bisa dibuka ulang: ' || coalesce(e, 'NULL'));
  perform t.logout();

  select * into s from public.cash_sessions where id = sid;
  perform t.ok(s.status = 'open' and s.closed_at is null and s.actual_cash is null and s.difference is null and s.totals is null and s.note is null,
    'hasil penutupan lama dikosongkan, sesi kembali open');
  perform t.ok(s.opening_cash = 100000, 'modal awal tetap');
  perform t.ok((select count(*) from public.audit_logs where action = 'cash_reopen') = n0 + 1, 'pembukaan kembali tercatat di audit');
  perform t.ok((select (before ->> 'uang_fisik')::numeric from public.audit_logs where action = 'cash_reopen' order by created_at desc limit 1) = 1, 'audit menyimpan uang fisik lama');

  -- kasir menutup ulang dengan angka benar (sesi yang sama, bukan sesi baru)
  perform t.login(t.id('ka'));
  r := public.rpc_cash_close(jsonb_build_object('uang_fisik', 100000));
  perform t.ok((r ->> 'id')::uuid = sid and (r ->> 'selisih_tunai')::numeric = 0, 'tutup ulang memakai sesi yang sama; selisih 0');
  perform t.logout();

  -- penutupan lama tidak boleh dibuka bila ada yang lebih baru / sesi sedang terbuka
  perform t.login(t.id('ka'));
  perform public.rpc_cash_open(jsonb_build_object('outlet_id', t.id('o1'), 'modal_awal', 0));
  perform t.logout();
  perform t.login(t.id('owner'));
  e := t.err('rpc_cash_reopen', jsonb_build_object('id', sid, 'alasan', 'coba lagi'));
  perform t.ok(e like 'P0001%' and e like '%sedang terbuka%', 'ditolak bila kasir punya sesi terbuka: ' || coalesce(e, 'NULL'));
  perform t.logout();
  perform t.login(t.id('ka')); perform public.rpc_cash_close(jsonb_build_object('uang_fisik', 0)); perform t.logout();
  perform t.login(t.id('owner'));
  e := t.err('rpc_cash_reopen', jsonb_build_object('id', sid, 'alasan', 'coba lagi'));
  perform t.ok(e like 'P0001%' and e like '%TERAKHIR%', 'hanya penutupan terakhir yang boleh dibuka: ' || coalesce(e, 'NULL'));
  perform t.logout();
end $$;
select 'Tes buka kembali penutupan kasir selesai' as hasil;
