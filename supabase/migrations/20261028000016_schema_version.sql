-- 0016 Versi skema (P0-3). Dipakai dua pihak:
--   1. langkah deploy: memastikan migrasi benar-benar terpasang sebelum situs terbit (tools/verify_schema.js);
--   2. klien web: menolak berjalan bila database lebih lama dari yang dibutuhkan, atau bila database mensyaratkan klien yang lebih baru (min_client).
-- version = versi migrasi terakhir yang tercatat oleh Supabase CLI (supabase_migrations.schema_migrations). 'unknown' bila migrasi dipasang
-- tanpa CLI (mis. Postgres biasa di CI atau SQL editor): deploy menganggapnya BELUM terverifikasi, klien tidak memblokir.
-- min_client = versi klien paling rendah yang masih cocok dengan skema ini. NAIKKAN nilainya (migrasi berikutnya, lewat create or replace)
-- setiap kali sebuah migrasi mengubah kontrak RPC/REST sampai klien lama rusak.
-- Sengaja SECURITY DEFINER dan boleh dipanggil anon: hanya mengembalikan nomor versi (tanpa data), supaya deploy dapat memeriksa tanpa login.
create function public.rpc_schema_version(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    execute 'select max(version) from supabase_migrations.schema_migrations' into v;
  end if;
  return jsonb_build_object('version', coalesce(v, 'unknown'), 'min_client', '2.3.0');
end $$;
revoke all on function public.rpc_schema_version(jsonb) from public, anon, authenticated;
grant execute on function public.rpc_schema_version(jsonb) to anon, authenticated;
