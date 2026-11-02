-- 0026 Observabilitas klien + sinyal sinkronisasi Realtime (v2.5.2).
--   A. app.client_errors + rpc_client_error_log (klien melapor galat/sesi) + rpc_client_error_report (Owner/Admin/Auditor): dasar KPI error rate per sesi.
--   B. public.sync_events: tabel sinyal TANPA data sensitif (hanya outlet_id, kind, waktu) yang masuk publikasi supabase_realtime.
--      Klien yang menerima sinyal cukup memanggil ping versi (rpc_ping) lalu memuat ulang bagian yang berubah. Sengaja BUKAN menyiarkan tabel
--      inventory_balances/products langsung: Realtime tidak menghormati hak kolom, sehingga avg_cost (HPP) akan bocor ke kasir.
--      Insert-only (tanpa upsert satu baris) supaya penjualan serentak di satu outlet tidak saling mengunci.
-- Tidak mengubah kontrak RPC yang sudah ada, jadi min_client tidak dinaikkan dan klien lama tetap berjalan.

-- ---------- A. Galat klien ----------
create table app.client_errors (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid,
  outlet_id uuid,
  session_id text not null,
  kind text not null check (kind in ('boot', 'error', 'promise', 'rt')),
  message text,
  source text,
  stack text,
  app_version text,
  online boolean
);
create index client_errors_created_idx on app.client_errors (created_at);
create index client_errors_user_idx on app.client_errors (user_id, created_at);
alter table app.client_errors enable row level security;
revoke all on table app.client_errors from public, anon, authenticated;

create function app.purge_client_errors(p_days int default 30) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v bigint;
begin
  if p_days < 7 then raise exception 'Retensi minimal 7 hari.' using errcode = '22023'; end if;
  delete from app.client_errors where created_at < now() - make_interval(days => p_days); get diagnostics v = row_count;
  return v;
end $$;
revoke all on function app.purge_client_errors(int) from public, anon, authenticated;

-- Klien melapor: {outlet_id?, events:[{kind, message, source, stack, session_id, app_version, online}]}. Maksimum 20 per panggilan, 60 per pengguna per menit.
-- Sengaja tidak pernah menggagalkan klien karena isi data (dipotong/diabaikan); hanya sesi yang tidak valid yang ditolak.
create function public.rpc_client_error_log(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_o uuid; v_ev jsonb; v_n int := 0; v_recent int;
begin
  if v_uid is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  begin v_o := nullif(p ->> 'outlet_id', '')::uuid; exception when others then v_o := null; end;
  if v_o is not null and not app.has_role(v_o, array['owner','admin','supervisor','kasir','stok','produksi','auditor']) then v_o := null; end if;
  select count(*) into v_recent from app.client_errors where user_id = v_uid and created_at > now() - interval '1 minute';
  if v_recent >= 60 then return jsonb_build_object('ok', true, 'diterima', 0, 'dibatasi', true); end if;
  if jsonb_typeof(p -> 'events') is distinct from 'array' then return jsonb_build_object('ok', true, 'diterima', 0); end if;
  for v_ev in select e from jsonb_array_elements(p -> 'events') e limit 20 loop
    continue when (v_ev ->> 'kind') is null or (v_ev ->> 'kind') not in ('boot', 'error', 'promise', 'rt');
    continue when coalesce(length(v_ev ->> 'session_id'), 0) < 8;
    insert into app.client_errors (user_id, outlet_id, session_id, kind, message, source, stack, app_version, online)
    values (v_uid, v_o, left(v_ev ->> 'session_id', 64), v_ev ->> 'kind', left(v_ev ->> 'message', 300), left(v_ev ->> 'source', 120),
            left(v_ev ->> 'stack', 1000), left(v_ev ->> 'app_version', 20),
            case when v_ev ->> 'online' in ('true', 'false') then (v_ev ->> 'online')::boolean end);
    v_n := v_n + 1;
  end loop;
  if random() < 0.01 then perform app.purge_client_errors(30); end if;   -- pembersihan murah tanpa cron
  return jsonb_build_object('ok', true, 'diterima', v_n);
end $$;
revoke all on function public.rpc_client_error_log(jsonb) from public, anon, authenticated;
grant execute on function public.rpc_client_error_log(jsonb) to authenticated;

-- Ringkasan: sesi = session_id berbeda yang pernah melapor (boot/error). Sesi bermasalah = punya minimal satu 'error' atau 'promise'.
create function public.rpc_client_error_report(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_days int := least(greatest(coalesce(nullif(p ->> 'days', '')::int, 7), 1), 90);
  v_from timestamptz := now() - make_interval(days => v_days);
  v_tot int; v_bad int; v_hari jsonb; v_top jsonb;
begin
  perform app.require_role(null, array['owner','admin','auditor']);
  select count(distinct session_id), count(distinct session_id) filter (where kind in ('error', 'promise'))
    into v_tot, v_bad from app.client_errors where created_at >= v_from;
  select coalesce(jsonb_agg(jsonb_build_object('tanggal', d, 'sesi', s, 'sesi_error', b) order by d), '[]'::jsonb) into v_hari from (
    select (created_at at time zone 'Asia/Jakarta')::date d, count(distinct session_id) s, count(distinct session_id) filter (where kind in ('error', 'promise')) b
    from app.client_errors where created_at >= v_from group by 1) x;
  select coalesce(jsonb_agg(jsonb_build_object('pesan', m, 'jumlah', n, 'sesi', s, 'terakhir', last, 'versi', ver) order by n desc), '[]'::jsonb) into v_top from (
    select coalesce(message, '(tanpa pesan)') m, count(*) n, count(distinct session_id) s, max(created_at) last, max(app_version) ver
    from app.client_errors where created_at >= v_from and kind in ('error', 'promise') group by 1 order by 2 desc limit 10) y;
  return jsonb_build_object('hari', v_days, 'sesi_total', v_tot, 'sesi_error', v_bad,
    'error_rate_persen', case when v_tot > 0 then round(100.0 * v_bad / v_tot, 2) else 0 end, 'per_hari', v_hari, 'teratas', v_top);
end $$;
revoke all on function public.rpc_client_error_report(jsonb) from public, anon, authenticated;
grant execute on function public.rpc_client_error_report(jsonb) to authenticated;

-- ---------- B. Sinyal sinkronisasi ----------
create table public.sync_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default clock_timestamp(),
  outlet_id uuid,                                  -- null = berlaku untuk semua outlet (katalog, harga, pengaturan)
  kind text not null check (kind in ('cat', 'stock'))
);
create index sync_events_lookup_idx on public.sync_events (kind, outlet_id, created_at desc);
create index sync_events_created_idx on public.sync_events (created_at);
alter table public.sync_events enable row level security;
revoke all on table public.sync_events from public, anon, authenticated;
grant select on table public.sync_events to authenticated;
create policy sync_events_read on public.sync_events for select to authenticated
  using (outlet_id is null and (select app.is_member_any()) or outlet_id in (select app.my_outlet_ids()));

create function app.sync_signal(p_outlet uuid, p_kind text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- gabungkan sinyal beruntun (satu transaksi penjualan mengubah banyak baris saldo): satu sinyal per outlet per jenis per 2 detik
  if not exists (select 1 from public.sync_events e where e.kind = p_kind and e.outlet_id is not distinct from p_outlet
                 and e.created_at > clock_timestamp() - interval '2 seconds') then
    insert into public.sync_events (outlet_id, kind) values (p_outlet, p_kind);
  end if;
  if random() < 0.01 then delete from public.sync_events where created_at < now() - interval '1 day'; end if;
end $$;
revoke all on function app.sync_signal(uuid, text) from public, anon, authenticated;

create function app.trg_sync_cat() returns trigger
language plpgsql security definer set search_path = '' as $$
begin perform app.sync_signal(null, 'cat'); return null; end $$;
revoke all on function app.trg_sync_cat() from public, anon, authenticated;

create function app.trg_sync_stock() returns trigger
language plpgsql security definer set search_path = '' as $$
begin perform app.sync_signal(new.outlet_id, 'stock'); return null; end $$;
revoke all on function app.trg_sync_stock() from public, anon, authenticated;

do $$ declare t text; begin
  foreach t in array array['products', 'product_variants', 'channels', 'channel_prices', 'outlet_prices', 'settings'] loop
    execute format('create trigger sync_cat_signal after insert or update or delete on public.%I for each statement execute function app.trg_sync_cat()', t);
  end loop;
end $$;
create trigger sync_stock_signal after insert or update on public.inventory_balances for each row execute function app.trg_sync_stock();

-- Publikasi Realtime (hanya ada di Supabase; di Postgres biasa dilewati). Hanya tabel sinyal yang dipublikasikan.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sync_events') then
      alter publication supabase_realtime add table public.sync_events;
    end if;
  else
    raise notice 'Publikasi supabase_realtime tidak ada (Postgres biasa): tabel sync_events tidak dipublikasikan.';
  end if;
end $$;

-- Retensi terjadwal (selain pembersihan murah di dalam fungsi) bila pg_cron ada.
do $m$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname = 'duado-purge-client-errors';
    perform cron.schedule('duado-purge-client-errors', '25 3 * * *', $cron$select app.purge_client_errors(30)$cron$);
    perform cron.unschedule(jobid) from cron.job where jobname = 'duado-purge-sync-events';
    perform cron.schedule('duado-purge-sync-events', '35 3 * * *', $cron$delete from public.sync_events where created_at < now() - interval '1 day'$cron$);
  else
    raise notice 'pg_cron tidak tersedia: pembersihan client_errors dan sync_events hanya lewat pembersihan oportunistik di fungsi.';
  end if;
exception when others then
  raise notice 'Penjadwalan pg_cron dilewati: %', sqlerrm;
end $m$;
