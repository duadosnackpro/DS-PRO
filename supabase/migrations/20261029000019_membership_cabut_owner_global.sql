-- 0019 Perbaikan: menurunkan peran pengguna di satu outlet kini juga mencabut peran owner global miliknya.
-- Masalah sebelumnya: baris owner global (outlet_id NULL) tidak disentuh, sehingga pengguna yang "diturunkan"
-- lewat form (mis. owner -> supervisor) tetap berstatus owner.
-- Aturan baru (hanya bila pemanggil owner):
--   * Memberi peran non-owner pada sebuah outlet menonaktifkan baris owner global aktif milik pengguna itu.
--   * Owner aktif terakhir tidak boleh diturunkan (tetap ditolak, transaksi dibatalkan seluruhnya).
-- Hak akses fungsi tidak berubah (create or replace mempertahankan GRANT/REVOKE yang sudah ada).
create or replace function app.membership_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_user uuid := nullif(p ->> 'user_id', '')::uuid; v_outlet uuid := nullif(p ->> 'outlet_id', '')::uuid;
        v_role text := p ->> 'role'; v_status text := coalesce(p ->> 'status', 'active'); v_old public.memberships; v_new public.memberships;
        v_owner public.memberships;
begin
  if v_uid is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  if v_status not in ('active','inactive') then raise exception 'Status tidak valid.' using errcode = '22023'; end if;
  if not exists (select 1 from public.profiles where id = v_user) then raise exception 'Pengguna tidak ditemukan.' using errcode = 'P0002'; end if;
  -- Owner mengatur semuanya. Admin global hanya mengatur role operasional pada outlet tertentu.
  if not app.is_owner() then
    if v_outlet is null or v_role not in ('supervisor','kasir','stok','produksi') then
      raise exception 'Hanya owner yang dapat mengatur akses global atau role owner/admin/auditor.' using errcode = '42501'; end if;
    perform app.require_role(v_outlet, array['admin']);
  end if;
  if v_outlet is not null and not exists (select 1 from public.outlets where id = v_outlet) then raise exception 'Outlet tidak ditemukan.' using errcode = 'P0002'; end if;
  select * into v_old from public.memberships where user_id = v_user and outlet_id is not distinct from v_outlet for update;
  -- Jangan sampai tidak ada owner aktif.
  if found and v_old.role = 'owner' and v_old.outlet_id is null and (v_status <> 'active' or v_role <> 'owner') then
    if not exists (select 1 from public.memberships m join public.profiles pr on pr.id = m.user_id
                   where m.role = 'owner' and m.outlet_id is null and m.status = 'active' and pr.status = 'active' and m.user_id <> v_user) then
      raise exception 'Tidak boleh menonaktifkan/menurunkan owner aktif terakhir.' using errcode = 'P0001'; end if;
  end if;
  if found then
    update public.memberships set role = v_role, status = v_status where id = v_old.id returning * into v_new;
  else
    insert into public.memberships (user_id, outlet_id, role, status, created_by) values (v_user, v_outlet, v_role, v_status, v_uid) returning * into v_new;
  end if;
  perform app.audit(v_outlet, 'membership_set', 'memberships', v_new.id::text, to_jsonb(v_old), to_jsonb(v_new));

  -- BARU: peran non-owner pada outlet mencabut peran owner global yang masih aktif (hanya bila pemanggil owner).
  if v_outlet is not null and v_role <> 'owner' and v_status = 'active' and app.is_owner() then
    select * into v_owner from public.memberships
     where user_id = v_user and outlet_id is null and role = 'owner' and status = 'active' for update;
    if found then
      if not exists (select 1 from public.memberships m join public.profiles pr on pr.id = m.user_id
                     where m.role = 'owner' and m.outlet_id is null and m.status = 'active' and pr.status = 'active' and m.user_id <> v_user) then
        raise exception 'Tidak boleh menurunkan owner aktif terakhir.' using errcode = 'P0001'; end if;
      update public.memberships set status = 'inactive' where id = v_owner.id;
      perform app.audit(null, 'membership_set', 'memberships', v_owner.id::text, to_jsonb(v_owner),
                        to_jsonb(v_owner) || jsonb_build_object('status', 'inactive'));
    end if;
  end if;

  return to_jsonb(v_new);
end $$;
