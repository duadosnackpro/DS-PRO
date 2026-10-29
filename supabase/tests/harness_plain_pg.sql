-- Hanya untuk Postgres biasa (bukan Supabase): meniru skema auth, peran, dan auth.uid().
do $$ begin
  if not exists (select 1 from pg_namespace where nspname = 'auth') then
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    create function auth.uid() returns uuid language sql stable as
      $f$ select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
                                 nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid $f$;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  grant usage on schema public, auth to anon, authenticated;
end $$;
