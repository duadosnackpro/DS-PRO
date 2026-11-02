-- 0033 Cadangan dan pemulihan (Fase 2, bagian 3.7 B1 dan B7 di Framework-Efisiensi-End-to-End.md).
-- ADITIF dan HANYA BACA terhadap data bisnis: tidak mengubah fungsi yang ada, tidak menyentuh stock_apply, tidak menyentuh ledger.
--   A. app.backup_runs      : catatan tiap cadangan (satu baris per jalan). Tabel privat, tidak terjangkau Data API.
--   B. app.backup_manifest_core(p_hash) : manifest kendali. Dipanggil langsung oleh tools/backup.sh (koneksi database langsung, tanpa sesi pengguna)
--      dan oleh tools/restore_verify.sh sesudah pemulihan. Isi: baris per tabel (+ hash isi tabel public/app), versi migrasi, dan TOTAL KENDALI uang/stok.
--   C. app.backup_record(p)  : dipanggil workflow setelah cadangan sah. Tidak dapat dipanggil dari aplikasi.
--   D. public.rpc_backup_manifest (owner/admin, tanpa hash) dan public.rpc_backup_status (owner/admin/auditor, untuk layar Diagnostik).
-- Semua angka uang/kuantitas dikeluarkan sebagai TEKS (numeric::text) agar tidak ada pembulatan float pada JSON; pembanding memakai aritmetika desimal.
-- Setelan sesi dikunci pada fungsi (UTC, ISO, extra_float_digits) agar teks baris dan hash sama persis di mesin mana pun.

-- ---------- A. Catatan jalan cadangan ----------
create table if not exists app.backup_runs (
  id bigint generated always as identity primary key,
  finished_at timestamptz not null default now(),
  ok boolean not null,
  kind text not null default 'dump' check (kind in ('dump', 'restore_test')),
  file_name text,
  size_bytes bigint,
  photos_count int,
  tables_count int,
  manifest_hash text,
  integrity_violations int,
  note text
);
create index if not exists backup_runs_time_idx on app.backup_runs (finished_at desc);
alter table app.backup_runs enable row level security;
revoke all on table app.backup_runs from public, anon, authenticated;

-- ---------- B. Manifest kendali ----------
-- Tabel yang dihitung: semua tabel biasa di skema yang ikut dump (public, app, auth, supabase_migrations) bila ada.
-- Hash isi hanya untuk public dan app (auth berisi sesi yang berubah terus dan dikelola Supabase; cukup dihitung barisnya).
-- Satu tabel yang tak terbaca (hak akses) ditandai baris = null, tidak menggagalkan manifest; pembanding melaporkannya.
create or replace function app.backup_manifest_core(p_hash boolean default true) returns jsonb
language plpgsql stable security definer set search_path = '' set timezone = 'UTC' set datestyle = 'ISO, YMD' set extra_float_digits = 3
set intervalstyle = 'iso_8601' as $$
declare
  r record; v_tabel jsonb := '{}'::jsonb; v_n bigint; v_h text; v_mig text; v_kendali jsonb; v_hak jsonb; v_struk jsonb;
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    execute 'select max(version) from supabase_migrations.schema_migrations' into v_mig;
  end if;

  for r in
    select n.nspname as s, c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and not c.relispartition and n.nspname in ('public', 'app', 'auth', 'supabase_migrations')
    order by 1, 2
  loop
    begin
      execute format('select count(*) from %I.%I', r.s, r.t) into v_n;
      v_h := null;
      if p_hash and r.s in ('public', 'app') then
        -- hash tak bergantung urutan baris: urutkan hash per baris, lalu hash gabungannya
        execute format('select md5(coalesce(string_agg(h, '''' order by h), '''')) from (select md5(x::text) as h from %I.%I x) y', r.s, r.t) into v_h;
      end if;
      v_tabel := v_tabel || jsonb_build_object(r.s || '.' || r.t, jsonb_build_object('baris', v_n, 'hash', v_h));
    exception when insufficient_privilege then
      v_tabel := v_tabel || jsonb_build_object(r.s || '.' || r.t, jsonb_build_object('baris', null, 'hash', null, 'catatan', 'tidak terbaca (hak akses)'));
    end;
  end loop;

  -- TOTAL KENDALI. Tiap kelompok = satu angka yang salah bila ada satu rupiah atau satu satuan yang berubah.
  select jsonb_build_object(
    'penjualan', (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
        select kind || '|' || status as k, jsonb_build_object('n', count(*), 'subtotal', sum(subtotal)::text, 'diskon', sum(discount)::text,
               'ppn', sum(tax_amount)::text, 'fee_channel', sum(fee_channel)::text, 'total', sum(total)::text) as v
        from public.sales group by kind, status) x),
    'penjualan_item', (select jsonb_build_object('n', count(*), 'qty', coalesce(sum(qty), 0)::text, 'jumlah_baris', coalesce(sum(line_total), 0)::text,
                       'hpp', coalesce(sum(qty * hpp_snapshot), 0)::text) from public.sale_items),
    'pembayaran', (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
        select method || '|' || status as k, jsonb_build_object('n', count(*), 'jumlah', sum(amount)::text) as v from public.payments group by method, status) x),
    'persediaan', jsonb_build_object(
        'varian', (select jsonb_build_object('n', count(*), 'qty', coalesce(sum(quantity), 0)::text, 'nilai', coalesce(sum(quantity * avg_cost), 0)::text) from public.inventory_balances),
        'bahan',  (select jsonb_build_object('n', count(*), 'qty', coalesce(sum(quantity), 0)::text, 'nilai', coalesce(sum(quantity * avg_cost), 0)::text) from public.inventory_material_balances)),
    'ledger', (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
        select item_type || '|' || movement_type as k, jsonb_build_object('n', count(*), 'qty', sum(quantity_delta)::text, 'nilai', coalesce(sum(value), 0)::text) as v
        from public.stock_movements group by item_type, movement_type) x),
    'kerugian', (select jsonb_build_object('n', count(*), 'qty', coalesce(sum(quantity), 0)::text, 'nilai', coalesce(sum(value), 0)::text) from public.inventory_losses),
    'pembelian', (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
        select status as k, jsonb_build_object('n', count(*), 'subtotal', sum(subtotal)::text, 'ongkir', sum(shipping)::text, 'total', sum(total)::text) as v
        from public.purchases group by status) x),
    'pembelian_item', (select jsonb_build_object('n', count(*), 'qty', coalesce(sum(qty), 0)::text, 'jumlah_harga', coalesce(sum(qty * unit_price), 0)::text,
                       'jumlah_biaya', coalesce(sum(qty * effective_cost), 0)::text) from public.purchase_items),
    'produksi', (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
        select status as k, jsonb_build_object('n', count(*), 'standar', sum(standard_qty)::text, 'aktual', coalesce(sum(actual_qty), 0)::text) as v
        from public.production_orders group by status) x),
    'biaya_produksi', (select jsonb_build_object('n', count(*), 'bahan', coalesce(sum(materials_cost), 0)::text, 'kemasan', coalesce(sum(packaging_cost), 0)::text,
                       'tenaga_kerja', coalesce(sum(labor_cost), 0)::text, 'overhead', coalesce(sum(overhead_cost), 0)::text, 'total', coalesce(sum(total), 0)::text) from public.production_costs),
    'kas', (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
        select kind as k, jsonb_build_object('n', count(*), 'jumlah', sum(amount)::text) as v from public.cash_movements group by kind) x),
    'biaya_operasional', (select jsonb_build_object('n', count(*), 'jumlah', coalesce(sum(amount), 0)::text) from public.expenses)
  ) into v_kendali;

  -- SIDIK JARI KEAMANAN: hak tabel/fungsi dan kebijakan RLS pada skema public dan app. pg_restore tanpa hak (atau ke proyek dengan default berbeda)
  -- tidak mengubah baris sama sekali, tetapi dapat membuka atau menutup akses diam-diam; hash ini menangkapnya. Pemilik/pemberi hak sengaja tidak ikut.
  select jsonb_build_object(
    'hak_tabel_n', count(*), 'hak_tabel_hash', md5(coalesce(string_agg(x, ',' order by x), ''))) into v_hak from (
      select n.nspname || '.' || c.relname || ':' || case a.grantee when 0 then 'public' else pg_get_userbyid(a.grantee) end || ':' || a.privilege_type as x
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault((case c.relkind when 'S' then 's' else 'r' end)::"char", c.relowner))) a
      where n.nspname in ('public', 'app') and c.relkind in ('r', 'p', 'v', 'm', 'S')
        and a.grantee <> c.relowner) q;
  select v_hak || jsonb_build_object(
    'hak_fungsi_n', count(*), 'hak_fungsi_hash', md5(coalesce(string_agg(x, ',' order by x), ''))) into v_hak from (
      select n.nspname || '.' || f.proname || '(' || pg_get_function_identity_arguments(f.oid) || '):' || case a.grantee when 0 then 'public' else pg_get_userbyid(a.grantee) end as x
      from pg_proc f join pg_namespace n on n.oid = f.pronamespace
      cross join lateral aclexplode(coalesce(f.proacl, acldefault('f'::"char", f.proowner))) a
      where n.nspname in ('public', 'app') and a.grantee <> f.proowner and f.prokind in ('f', 'p')) q;
  select v_hak || jsonb_build_object(
    'rls_tabel_hash', (select md5(coalesce(string_agg(n.nspname || '.' || c.relname || ':' || c.relrowsecurity::text, ',' order by n.nspname, c.relname), ''))
                       from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'app') and c.relkind in ('r', 'p')),
    'kebijakan_n', count(*), 'kebijakan_hash', md5(coalesce(string_agg(x, ',' order by x), ''))) into v_hak from (
      select schemaname || '.' || tablename || ':' || policyname || ':' || cmd || ':' || coalesce(roles::text, '') || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '') as x
      from pg_policies where schemaname in ('public', 'app')) q;


  -- SIDIK JARI STRUKTUR: konstrain (FK, CHECK, UNIQUE, PK), indeks, trigger, kolom, dan ISI fungsi pada public dan app. Baris dan uang bisa sama persis
  -- sementara satu FK gagal dibuat ulang saat pemulihan (mis. profiles -> auth.users bila akun target berbeda); tanpa sidik jari ini hal itu lolos sebagai "sah".
  select jsonb_build_object('konstrain_n', count(*), 'konstrain_hash', md5(coalesce(string_agg(x, E'\n' order by x), ''))) into v_struk from (
      select n.nspname || '.' || c.relname || ':' || k.conname || ':' || pg_get_constraintdef(k.oid) as x
      from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'app') and not c.relispartition) q;
  select v_struk || jsonb_build_object('indeks_n', count(*), 'indeks_hash', md5(coalesce(string_agg(x, E'\n' order by x), ''))) into v_struk from (
      select indexdef as x from pg_indexes where schemaname in ('public', 'app')) q;
  select v_struk || jsonb_build_object('trigger_n', count(*), 'trigger_hash', md5(coalesce(string_agg(x, E'\n' order by x), ''))) into v_struk from (
      select n.nspname || '.' || c.relname || ':' || t.tgname || ':' || pg_get_triggerdef(t.oid) as x
      from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'app') and not t.tgisinternal and not c.relispartition) q;
  select v_struk || jsonb_build_object('kolom_n', count(*), 'kolom_hash', md5(coalesce(string_agg(x, E'\n' order by x), ''))) into v_struk from (
      select n.nspname || '.' || c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' ||
             coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ':' || a.attgenerated::text || ':' || a.attidentity::text as x
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where n.nspname in ('public', 'app') and c.relkind in ('r', 'p') and not c.relispartition and a.attnum > 0 and not a.attisdropped) q;
  select v_struk || jsonb_build_object('fungsi_n', count(*), 'fungsi_hash', md5(coalesce(string_agg(x, E'\n' order by x), ''))) into v_struk from (
      select n.nspname || '.' || f.proname || '(' || pg_get_function_identity_arguments(f.oid) || '):' || f.prosecdef::text || ':' || coalesce(f.proconfig::text, '') || ':' || md5(f.prosrc) as x
      from pg_proc f join pg_namespace n on n.oid = f.pronamespace
      where n.nspname in ('public', 'app') and f.prokind in ('f', 'p')) q;

  return jsonb_build_object('versi_manifest', 1, 'dibuat_pada', now(), 'migrasi_terakhir', coalesce(v_mig, 'unknown'),
    'jumlah_tabel', (select count(*) from jsonb_object_keys(v_tabel)), 'tabel', v_tabel, 'kendali', v_kendali, 'keamanan', v_hak, 'struktur', v_struk);
end $$;
revoke all on function app.backup_manifest_core(boolean) from public, anon, authenticated;

-- Hasil integrity_check (Fase 1) untuk SEMUA outlet, dijalankan dari koneksi database langsung. integrity_check memakai auth.uid(), jadi fungsi ini
-- memakai identitas satu owner aktif hanya untuk transaksi ini (set_config lokal). Outlet tidak aktif dilewati dan dicatat (active_outlet menolaknya).
-- Dipanggil dua kali: di sumber (di dalam snapshot yang sama dengan dump) dan di hasil pemulihan. Pemulihan sah bila TIDAK menambah temuan.
create or replace function app.backup_integrity_all() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; o record; v_r jsonb; v_out jsonb := '{}'::jsonb; v_total bigint := 0; v_skip int := 0;
begin
  select user_id into v_owner from public.memberships where role = 'owner' and status = 'active' order by created_at, id limit 1;
  if v_owner is null then
    return jsonb_build_object('tersedia', false, 'alasan', 'tidak ada owner aktif', 'total_pelanggaran', null, 'outlet', '{}'::jsonb);
  end if;
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner)::text, true);
  for o in select id, code, status from public.outlets order by code loop
    begin
      v_r := app.integrity_check(jsonb_build_object('outlet_id', o.id));
      v_out := v_out || jsonb_build_object(o.code, jsonb_build_object('ok', v_r -> 'ok', 'pelanggaran', v_r -> 'total_pelanggaran',
        'per_kode', (select coalesce(jsonb_object_agg(c ->> 'kode', c -> 'pelanggaran'), '{}'::jsonb) from jsonb_array_elements(v_r -> 'pemeriksaan') c),
        'diperiksa', (select coalesce(sum((c ->> 'diperiksa')::bigint), 0) from jsonb_array_elements(v_r -> 'pemeriksaan') c)));
      v_total := v_total + (v_r ->> 'total_pelanggaran')::bigint;
    exception when others then
      if o.status <> 'active' then
        v_out := v_out || jsonb_build_object(o.code, jsonb_build_object('dilewati', 'outlet tidak aktif'));
        v_skip := v_skip + 1;
      else raise; end if;
    end;
  end loop;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return jsonb_build_object('tersedia', true, 'total_pelanggaran', v_total, 'outlet_dilewati', v_skip, 'outlet', v_out);
end $$;
revoke all on function app.backup_integrity_all() from public, anon, authenticated;

-- ---------- C. Pencatatan cadangan (hanya dari koneksi database langsung milik workflow) ----------
create or replace function app.backup_record(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  if jsonb_typeof(p -> 'ok') is distinct from 'boolean' then raise exception 'Field ok (true/false) wajib.' using errcode = '22023'; end if;
  insert into app.backup_runs (ok, kind, file_name, size_bytes, photos_count, tables_count, manifest_hash, integrity_violations, note)
  values ((p ->> 'ok')::boolean, coalesce(nullif(p ->> 'kind', ''), 'dump'), left(p ->> 'file_name', 200), nullif(p ->> 'size_bytes', '')::bigint,
          nullif(p ->> 'photos_count', '')::int, nullif(p ->> 'tables_count', '')::int, left(p ->> 'manifest_hash', 64), nullif(p ->> 'integrity_violations', '')::int, left(p ->> 'note', 500))
  returning id into v_id;
  delete from app.backup_runs where finished_at < now() - interval '400 days';
  return v_id;
end $$;
revoke all on function app.backup_record(jsonb) from public, anon, authenticated;

-- ---------- D. RPC untuk aplikasi ----------
create or replace function app.rpc_backup_manifest_impl(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_role(null, array['owner', 'admin']);
  return app.backup_manifest_core(false);   -- tanpa hash: ringan, cukup untuk dilihat; hash hanya untuk tools/backup.sh
end $$;
revoke all on function app.rpc_backup_manifest_impl(jsonb) from public, anon;
grant execute on function app.rpc_backup_manifest_impl(jsonb) to authenticated;

create or replace function public.rpc_backup_manifest(p jsonb default '{}'::jsonb) returns jsonb
language sql stable security invoker set search_path = '' as $f$ select app.rpc_backup_manifest_impl(p) $f$;
revoke all on function public.rpc_backup_manifest(jsonb) from public, anon;
grant execute on function public.rpc_backup_manifest(jsonb) to authenticated;

-- Status untuk Diagnostik. Peringatan bila belum pernah ada cadangan sah, atau yang terakhir lebih tua dari ambang jam (bawaan 36, batas 6..720).
create or replace function app.rpc_backup_status_impl(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_jam int := least(greatest(coalesce(nullif(p ->> 'ambang_jam', '')::int, 36), 6), 720);
  v_ok app.backup_runs; v_last app.backup_runs; v_umur numeric;
begin
  perform app.require_role(null, array['owner', 'admin', 'auditor']);
  select * into v_ok from app.backup_runs where ok and kind = 'dump' order by finished_at desc, id desc limit 1;
  select * into v_last from app.backup_runs where kind = 'dump' order by finished_at desc, id desc limit 1;
  v_umur := case when v_ok.id is null then null else round((extract(epoch from (now() - v_ok.finished_at)) / 3600)::numeric, 1) end;
  return jsonb_build_object(
    'ada_cadangan', v_ok.id is not null,
    'terakhir_sah', case when v_ok.id is null then null else jsonb_build_object('waktu', v_ok.finished_at, 'umur_jam', v_umur, 'berkas', v_ok.file_name,
                       'ukuran_byte', v_ok.size_bytes, 'foto', v_ok.photos_count, 'tabel', v_ok.tables_count,
                       'temuan_integritas', v_ok.integrity_violations) end,
    'percobaan_terakhir_gagal', coalesce(v_last.id is not null and not v_last.ok, false),
    'catatan_gagal', case when v_last.id is not null and not v_last.ok then v_last.note end,
    'ambang_jam', v_jam,
    'peringatan', v_ok.id is null or v_umur > v_jam or coalesce(v_last.id is not null and not v_last.ok, false));
end $$;
revoke all on function app.rpc_backup_status_impl(jsonb) from public, anon;
grant execute on function app.rpc_backup_status_impl(jsonb) to authenticated;

create or replace function public.rpc_backup_status(p jsonb default '{}'::jsonb) returns jsonb
language sql stable security invoker set search_path = '' as $f$ select app.rpc_backup_status_impl(p) $f$;
revoke all on function public.rpc_backup_status(jsonb) from public, anon;
grant execute on function public.rpc_backup_status(jsonb) to authenticated;
