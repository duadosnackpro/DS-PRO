-- 0021 Kasir, kas, dan keamanan akun (temuan F3, F4, F8).
-- F3: pembuangan transaksi antrean yang ditolak server dicatat di audit_logs (sebelumnya hanya pesan di layar).
-- F4: buka kasir wajib secara default; modal awal ditetapkan saat BUKA dan kas keluar hanya lewat cash_movement_add, bukan diketik saat tutup.
-- F8: penguncian akun setelah salah kata sandi/PIN berulang (Password Verification Hook Supabase Auth) + buka kunci oleh Owner/Admin.

-- ---------- F4: sesi kasir ----------
create or replace function app.ensure_session(p_outlet uuid, p_cashier uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v public.cash_sessions;
begin
  select * into v from public.cash_sessions where cashier_id = p_cashier and status = 'open' for share;
  if found then
    if v.outlet_id <> p_outlet then
      raise exception 'Sesi kasir Anda masih aktif di outlet lain. Tutup kasir di sana lebih dulu.' using errcode = 'P0001';
    end if;
    return v.id;
  end if;
  if app.setting_bool(p_outlet, 'wajib_buka_kasir', true) then
    raise exception 'Buka sesi kasir terlebih dahulu (isi modal awal).' using errcode = 'P0001';
  end if;
  insert into public.cash_sessions (outlet_id, cashier_id, opening_cash, auto_opened)
  values (p_outlet, p_cashier, 0, true)
  on conflict (cashier_id) where status = 'open' do nothing
  returning id into v.id;
  if v.id is null then
    select id into v.id from public.cash_sessions where cashier_id = p_cashier and status = 'open';
  end if;
  return v.id;
end $$;

create or replace function app.cash_close(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid()); v public.cash_sessions;
  v_fisik numeric := app.num(p, 'uang_fisik'); v_extra numeric := 0;   -- F4: kas keluar hanya lewat cash_movement_add (dengan alasan); angka dari klien saat tutup diabaikan
  v_modal numeric; v_in numeric; v_out numeric; v_tunai numeric; v_tf numeric; v_qr numeric; v_lain numeric; v_total numeric; v_retur numeric;
  v_n int; v_exp numeric; v_diff numeric; v_note text := trim(coalesce(p ->> 'catatan', '')); v_amb numeric;
begin
  if v_uid is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  if v_fisik is null or v_fisik < 0 then raise exception 'Isi jumlah uang tunai di laci (0 atau lebih).' using errcode = '22023'; end if;
  if v_extra < 0 then raise exception 'Kas keluar tidak boleh negatif.' using errcode = '22023'; end if;
  select * into v from public.cash_sessions where cashier_id = v_uid and status = 'open' for update;  -- menunggu penjualan yang sedang berjalan
  if not found then raise exception 'Tidak ada sesi kasir aktif untuk ditutup.' using errcode = 'P0001'; end if;
  perform app.require_role(v.outlet_id, array['owner','admin','supervisor','kasir']);

  v_modal := v.opening_cash;   -- F4: modal awal ditetapkan saat BUKA kasir, tidak bisa diketik ulang setelah uang dihitung
  if v_modal < 0 then raise exception 'Modal awal tidak boleh negatif.' using errcode = '22023'; end if;

  select coalesce(sum(amount) filter (where method = 'tunai'), 0), coalesce(sum(amount) filter (where method = 'transfer'), 0),
         coalesce(sum(amount) filter (where method = 'qris'), 0), coalesce(sum(amount) filter (where method = 'lain'), 0),
         coalesce(sum(amount), 0)
    into v_tunai, v_tf, v_qr, v_lain, v_total from public.payments where cash_session_id = v.id and status = 'confirmed';
  select coalesce(sum(-amount), 0) into v_retur from public.payments pm join public.sales s on s.id = pm.sale_id
    where pm.cash_session_id = v.id and s.kind = 'return';
  select count(*) into v_n from public.sales where cash_session_id = v.id and kind = 'sale' and status = 'completed';
  select coalesce(sum(amount) filter (where kind = 'in'), 0), coalesce(sum(amount) filter (where kind = 'out'), 0)
    into v_in, v_out from public.cash_movements where cash_session_id = v.id;

  v_exp := v_modal + v_tunai + v_in - v_out - v_extra;
  v_diff := v_fisik - v_exp;
  v_amb := coalesce(nullif(app.setting(v.outlet_id, 'selisih_ambang_catatan', '0'), '')::numeric, 0);
  if abs(v_diff) > v_amb and length(v_note) < 3 then
    raise exception 'Ada selisih kas Rp%. Isi catatan penyebab selisih.', v_diff using errcode = 'P0001', hint = 'NOTE_REQUIRED';
  end if;

  update public.cash_sessions set status = 'closed', closed_at = now(), opening_cash = v_modal, txn_count = v_n,
    totals = jsonb_build_object('tunai', v_tunai, 'transfer', v_tf, 'qris', v_qr, 'lain', v_lain, 'total', v_total, 'retur', v_retur),
    cash_in = v_in, cash_out = v_out + v_extra, expected_cash = v_exp, actual_cash = v_fisik, difference = v_diff, note = nullif(v_note, '')
  where id = v.id;

  perform app.audit(v.outlet_id, 'cash_close', 'cash_sessions', v.id::text, null,
                    jsonb_build_object('diharapkan', v_exp, 'fisik', v_fisik, 'selisih', v_diff, 'catatan', v_note));
  return jsonb_build_object('id', v.id, 'dari', to_char(v.opened_at at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS'),
    'sampai', to_char(now() at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS'), 'jumlah_trx', v_n, 'tunai', v_tunai, 'transfer', v_tf,
    'qris', v_qr, 'lain', v_lain, 'total', v_total, 'retur', v_retur, 'modal_awal', v_modal, 'kas_keluar', v_out + v_extra,
    'tunai_diharapkan', v_exp, 'uang_fisik', v_fisik, 'selisih_tunai', v_diff);
end $$;

-- Ringkasan "buta" tetap: tidak menampilkan total penjualan/uang seharusnya. Ditambah modal awal, status wajib buka, dan gerakan kas milik sesi ini.
create or replace function app.cash_summary(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v public.cash_sessions; v_n int; v_o uuid := nullif(p ->> 'outlet_id', '')::uuid; v_mv jsonb;
begin
  if (select auth.uid()) is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  select * into v from public.cash_sessions where cashier_id = (select auth.uid()) and status = 'open';
  if not found then
    return jsonb_build_object('sesi', null, 'dari', null, 'jumlah_trx', 0, 'modal_terakhir', 0, 'modal_awal', 0,
      'wajib_buka', case when v_o is null then true else app.setting_bool(v_o, 'wajib_buka_kasir', true) end, 'gerakan', '[]'::jsonb);
  end if;
  select count(*) into v_n from public.sales where cash_session_id = v.id and kind = 'sale' and status = 'completed';
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'jenis', m.kind, 'nominal', m.amount, 'alasan', m.reason,
           'waktu', to_char(m.created_at at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS')) order by m.created_at), '[]'::jsonb)
    into v_mv from public.cash_movements m where m.cash_session_id = v.id;
  return jsonb_build_object('sesi', v.id, 'outlet_id', v.outlet_id, 'dari', to_char(v.opened_at at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS'),
    'sampai', to_char(now() at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS'), 'jumlah_trx', v_n,
    'modal_terakhir', v.opening_cash, 'modal_awal', v.opening_cash, 'auto_opened', v.auto_opened,
    'wajib_buka', app.setting_bool(v.outlet_id, 'wajib_buka_kasir', true), 'gerakan', v_mv);
end $$;

-- ---------- F3: catatan pembuangan transaksi antrean ----------
create function app.sale_reject_log(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_o uuid := nullif(p ->> 'outlet_id', '')::uuid; v_req text := left(coalesce(p ->> 'request_id', ''), 80);
        v_why text := left(coalesce(p ->> 'alasan', ''), 300); v_aksi text := coalesce(nullif(p ->> 'aksi', ''), 'hapus');
begin
  if v_uid is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  if v_o is null then raise exception 'Outlet wajib diisi.' using errcode = '22023'; end if;
  perform app.require_role(v_o, array['owner','admin','supervisor','kasir']);
  if length(v_req) < 8 then raise exception 'request_id wajib (minimal 8 karakter).' using errcode = '22023'; end if;
  if v_aksi not in ('hapus','tinjau') then raise exception 'Aksi tidak dikenal.' using errcode = '22023'; end if;
  perform app.audit(v_o, 'sale_queue_' || v_aksi, 'sales_queue', v_req, null,
    jsonb_build_object('alasan', v_why, 'total', app.num(p, 'total'), 'nomor', left(coalesce(p ->> 'nomor', ''), 40), 'galat', left(coalesce(p ->> 'galat', ''), 300)));
  return jsonb_build_object('logged', true);
end $$;

-- ---------- F8: penguncian akun ----------
create table app.auth_failures (
  user_id uuid primary key,
  failures integer not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz,
  locked_count integer not null default 0
);
revoke all on table app.auth_failures from public, anon, authenticated;

-- Dipanggil Supabase Auth setiap kali kata sandi/PIN diperiksa (Authentication > Hooks > Password verification).
-- 5 salah berturut-turut dalam 15 menit mengunci akun; kunci memanjang (15 menit x jumlah kunci, maks. 24 jam). Benar = hitungan kembali ke nol.
create function public.hook_password_verification_attempt(event jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := nullif(event ->> 'user_id', '')::uuid; v_ok boolean := coalesce((event ->> 'valid')::boolean, false); r app.auth_failures;
begin
  if v_uid is null then return jsonb_build_object('decision', 'continue'); end if;
  insert into app.auth_failures (user_id) values (v_uid) on conflict (user_id) do nothing;
  select * into r from app.auth_failures where user_id = v_uid for update;
  if r.locked_until is not null and r.locked_until > now() then
    return jsonb_build_object('decision', 'reject', 'message', 'Akun terkunci sementara karena terlalu banyak percobaan. Coba lagi nanti atau minta Owner/Admin membuka kunci.', 'should_logout_user', false);
  end if;
  if v_ok then
    update app.auth_failures set failures = 0, locked_until = null, window_start = now() where user_id = v_uid;
    return jsonb_build_object('decision', 'continue');
  end if;
  if r.window_start < now() - interval '15 minutes' then r.failures := 0; r.window_start := now(); end if;
  r.failures := r.failures + 1;
  if r.failures >= 5 then
    update app.auth_failures set failures = 0, window_start = now(), locked_count = locked_count + 1,
           locked_until = now() + (least(locked_count + 1, 96) * interval '15 minutes') where user_id = v_uid;
  else
    update app.auth_failures set failures = r.failures, window_start = r.window_start where user_id = v_uid;
  end if;
  return jsonb_build_object('decision', 'continue');
end $$;
revoke all on function public.hook_password_verification_attempt(jsonb) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema app to supabase_auth_admin;
    grant execute on function public.hook_password_verification_attempt(jsonb) to supabase_auth_admin;
  end if;
end $$;

-- Daftar akun terkunci (untuk layar Pengguna) dan buka kunci. Akun owner/admin/auditor hanya dapat dibuka oleh Owner.
create function app.user_locks(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_role(null, array['owner','admin']);
  return (select coalesce(jsonb_agg(jsonb_build_object('user_id', f.user_id, 'sampai', f.locked_until)), '[]'::jsonb) from app.auth_failures f where f.locked_until > now());
end $$;

create function app.user_unlock(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_u uuid := nullif(p ->> 'user_id', '')::uuid;
begin
  perform app.require_role(null, array['owner','admin']);
  if v_u is null then raise exception 'Pengguna wajib dipilih.' using errcode = '22023'; end if;
  if not app.is_owner() and exists (select 1 from public.memberships m where m.user_id = v_u and m.status = 'active' and m.role in ('owner','admin','auditor')) then
    raise exception 'Hanya Owner yang dapat membuka kunci akun Owner/Admin/Auditor.' using errcode = '42501';
  end if;
  update app.auth_failures set failures = 0, locked_until = null, locked_count = 0, window_start = now() where user_id = v_u;
  perform app.audit(null, 'user_unlock', 'profiles', v_u::text, null, null);
  return jsonb_build_object('ok', true);
end $$;

do $$ declare n text; begin
  foreach n in array array['sale_reject_log','user_locks','user_unlock','cash_summary'] loop
    execute format('create or replace function public.rpc_%1$s(p jsonb default ''{}''::jsonb) returns jsonb language sql security invoker set search_path = '''' as $f$ select app.%1$s(p) $f$', n);
    execute format('revoke all on function public.rpc_%1$s(jsonb) from public, anon', n);
    execute format('grant execute on function public.rpc_%1$s(jsonb) to authenticated', n);
    execute format('revoke all on function app.%1$s(jsonb) from public, anon', n);
    execute format('grant execute on function app.%1$s(jsonb) to authenticated', n);
  end loop;
end $$;
-- ensure_session dan cash_close sudah ada dan hak eksekusinya dipertahankan oleh create or replace.
