-- 0012 Pengerasan keamanan (temuan advisor Supabase): search_path tetap pada fungsi pembantu,
-- dan cabut hak panggil RPC pada fungsi bawaan Supabase rls_auto_enable() bila ada.
-- Aman dijalankan ulang (idempoten) dan di atas skema yang sudah memakai versi terkeras.
alter function app.forbid_mutation() set search_path = pg_catalog, pg_temp;
alter function app.touch_updated_at() set search_path = pg_catalog, pg_temp;
alter function app.num(jsonb, text, numeric) set search_path = pg_catalog, pg_temp;
alter function app.public_setting_keys() set search_path = pg_catalog, pg_temp;
alter function app.uid() set search_path = pg_catalog, auth, pg_temp;

do $$ begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;
