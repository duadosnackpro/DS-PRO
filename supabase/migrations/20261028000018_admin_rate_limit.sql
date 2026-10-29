-- 0018 Pembatasan laju untuk Edge Function admin-users (P1-6): hitungan per pemanggil per menit.
-- Hanya service_role (Edge Function) yang boleh memanggil; klien tidak.
create table app.admin_calls (
  caller uuid not null,
  window_start timestamptz not null,
  n int not null default 0,
  primary key (caller, window_start)
);
revoke all on table app.admin_calls from public, anon, authenticated;

create function public.rpc_admin_rate_hit(p jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare v_caller uuid := nullif(p ->> 'caller', '')::uuid; v_w timestamptz := date_trunc('minute', now()); v_n int;
begin
  if v_caller is null then raise exception 'caller wajib.' using errcode = '22023'; end if;
  insert into app.admin_calls (caller, window_start, n) values (v_caller, v_w, 1)
  on conflict (caller, window_start) do update set n = app.admin_calls.n + 1
  returning n into v_n;
  if random() < 0.02 then delete from app.admin_calls where window_start < now() - interval '1 hour'; end if;   -- pembersihan murah, tanpa cron
  return v_n;
end $$;
revoke all on function public.rpc_admin_rate_hit(jsonb) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.rpc_admin_rate_hit(jsonb) to service_role; end if;
end $$;
