-- 0007 Administrasi outlet, anggota, opname, pembelian, produksi, transfer stok

-- ---------- Outlet ----------
create function app.outlet_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_code text := upper(trim(coalesce(p ->> 'code', ''))); v_o public.outlets; v_org uuid; v_dup jsonb;
begin
  perform app.require_role(null, array['owner']);                       -- hanya owner global
  if p ? 'request_id' then
    v_dup := app.idem_begin('outlet_create', p ->> 'request_id', p);
    if v_dup is not null then return v_dup; end if;
  end if;
  if v_code !~ '^[A-Z0-9][A-Z0-9-]{1,19}$' then raise exception 'Kode outlet harus 2-20 karakter huruf besar/angka/strip (contoh OUT-002).' using errcode = '22023'; end if;
  if length(trim(coalesce(p ->> 'name', ''))) < 2 then raise exception 'Nama outlet wajib diisi.' using errcode = '22023'; end if;
  if coalesce(p ->> 'kind', 'store') not in ('store','kitchen') then raise exception 'Jenis lokasi tidak valid.' using errcode = '22023'; end if;
  if coalesce(p ->> 'status', 'active') not in ('active','inactive') then raise exception 'Status awal harus active/inactive.' using errcode = '22023'; end if;
  begin
    perform now() at time zone coalesce(nullif(p ->> 'timezone', ''), 'Asia/Jakarta');
  exception when others then raise exception 'Zona waktu tidak valid.' using errcode = '22023'; end;
  select id into v_org from public.organizations limit 1;
  begin
    insert into public.outlets (organization_id, code, name, kind, address, phone, status, timezone, opened_on, receipt_header, receipt_footer, notes, created_by)
    values (v_org, v_code, trim(p ->> 'name'), coalesce(p ->> 'kind', 'store'), nullif(trim(p ->> 'address'), ''), nullif(trim(p ->> 'phone'), ''),
            coalesce(p ->> 'status', 'active'), coalesce(nullif(p ->> 'timezone', ''), 'Asia/Jakarta'), nullif(p ->> 'opened_on', '')::date,
            nullif(p ->> 'receipt_header', ''), nullif(p ->> 'receipt_footer', ''), nullif(p ->> 'notes', ''), (select auth.uid()))
    returning * into v_o;
  exception when unique_violation then
    raise exception 'Kode outlet % sudah dipakai (kode tidak dapat dipakai ulang).', v_code using errcode = '23505';
  end;
  perform app.audit(v_o.id, 'outlet_create', 'outlets', v_o.id::text, null, to_jsonb(v_o));
  return app.idem_finish('outlet_create', p ->> 'request_id', to_jsonb(v_o));
end $$;

create function app.outlet_update(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_old public.outlets; v_new public.outlets; v_status text;
begin
  select * into v_old from public.outlets where id = nullif(p ->> 'id', '')::uuid for update;
  if not found then raise exception 'Outlet tidak ditemukan.' using errcode = 'P0002'; end if;
  perform app.require_role(v_old.id, array['owner','admin']);
  v_status := coalesce(p ->> 'status', v_old.status);
  if v_status not in ('active','inactive','closed') then raise exception 'Status outlet tidak valid.' using errcode = '22023'; end if;
  if v_status <> 'active' and v_old.status = 'active' then
    if exists (select 1 from public.cash_sessions where outlet_id = v_old.id and status = 'open') then
      raise exception 'Masih ada sesi kasir aktif di outlet ini. Tutup kasir lebih dulu.' using errcode = 'P0001'; end if;
    if exists (select 1 from public.stock_transfers where status = 'sent' and (from_outlet_id = v_old.id or to_outlet_id = v_old.id)) then
      raise exception 'Masih ada transfer stok dalam perjalanan. Selesaikan dulu.' using errcode = 'P0001'; end if;
  end if;
  if v_old.status = 'closed' and v_status <> 'closed' then perform app.require_role(null, array['owner']); end if;
  update public.outlets set name = coalesce(nullif(trim(p ->> 'name'), ''), name), address = case when p ? 'address' then nullif(trim(p ->> 'address'), '') else address end,
    phone = case when p ? 'phone' then nullif(trim(p ->> 'phone'), '') else phone end, status = v_status,
    opened_on = case when p ? 'opened_on' then nullif(p ->> 'opened_on', '')::date else opened_on end,
    receipt_header = case when p ? 'receipt_header' then p ->> 'receipt_header' else receipt_header end,
    receipt_footer = case when p ? 'receipt_footer' then p ->> 'receipt_footer' else receipt_footer end,
    notes = case when p ? 'notes' then p ->> 'notes' else notes end
  where id = v_old.id returning * into v_new;                                     -- code dan kind sengaja tidak dapat diubah
  perform app.audit(v_old.id, 'outlet_update', 'outlets', v_old.id::text, to_jsonb(v_old), to_jsonb(v_new));
  return to_jsonb(v_new);
end $$;

-- ---------- Anggota dan akses outlet ----------
create function app.membership_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_user uuid := nullif(p ->> 'user_id', '')::uuid; v_outlet uuid := nullif(p ->> 'outlet_id', '')::uuid;
        v_role text := p ->> 'role'; v_status text := coalesce(p ->> 'status', 'active'); v_old public.memberships; v_new public.memberships;
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
  return to_jsonb(v_new);
end $$;

create function app.profile_set_status(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := nullif(p ->> 'user_id', '')::uuid; v_status text := p ->> 'status';
begin
  perform app.require_role(null, array['owner','admin']);
  if v_status not in ('active','inactive') then raise exception 'Status tidak valid.' using errcode = '22023'; end if;
  if v_status = 'inactive' then
    if v_user = (select auth.uid()) then raise exception 'Tidak dapat menonaktifkan akun sendiri.' using errcode = 'P0001'; end if;
    if exists (select 1 from public.memberships where user_id = v_user and role = 'owner' and outlet_id is null and status = 'active')
       and not exists (select 1 from public.memberships m join public.profiles pr on pr.id = m.user_id
                       where m.role = 'owner' and m.outlet_id is null and m.status = 'active' and pr.status = 'active' and m.user_id <> v_user) then
      raise exception 'Tidak boleh menonaktifkan owner aktif terakhir.' using errcode = 'P0001'; end if;
    if exists (select 1 from public.cash_sessions where cashier_id = v_user and status = 'open') then
      raise exception 'Pengguna masih punya sesi kasir aktif. Tutup kasirnya dulu.' using errcode = 'P0001'; end if;
  end if;
  update public.profiles set status = v_status where id = v_user;
  if not found then raise exception 'Pengguna tidak ditemukan.' using errcode = 'P0002'; end if;
  perform app.audit(null, 'profile_status', 'profiles', v_user::text, null, jsonb_build_object('status', v_status));
  return jsonb_build_object('user_id', v_user, 'status', v_status);
end $$;

-- ---------- Opname / saldo pembukaan ----------
create function app.stock_adjust(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_o public.outlets; v_type text := case p ->> 'tipe' when 'bahan' then 'material' when 'varian' then 'variant' else null end;
        v_id uuid := nullif(p ->> 'id', '')::uuid; v_new numeric := app.num(p, 'stok_baru'); v_hpp numeric := app.num(p, 'hpp');
        v_old numeric; v_cost numeric; v_alasan text := trim(coalesce(p ->> 'alasan', '')); v_first boolean; v_res numeric; v_thr numeric;
begin
  v_o := app.active_outlet(nullif(p ->> 'outlet_id', '')::uuid);
  perform app.require_role(v_o.id, array['owner','admin','supervisor','stok']);
  if v_type is null then raise exception 'Tipe stok tidak valid.' using errcode = '22023'; end if;
  if v_new is null or v_new < 0 then raise exception 'Stok baru tidak valid.' using errcode = '22023'; end if;
  if v_hpp is not null and v_hpp < 0 then raise exception 'HPP tidak valid.' using errcode = '22023'; end if;
  if length(v_alasan) < 3 then raise exception 'Alasan penyesuaian wajib diisi.' using errcode = '22023'; end if;
  if v_type = 'variant' then
    insert into public.inventory_balances (outlet_id, variant_id) values (v_o.id, v_id) on conflict do nothing;
    select quantity, avg_cost into v_old, v_cost from public.inventory_balances where outlet_id = v_o.id and variant_id = v_id for update;
  else
    insert into public.inventory_material_balances (outlet_id, material_id) values (v_o.id, v_id) on conflict do nothing;
    select quantity, avg_cost into v_old, v_cost from public.inventory_material_balances where outlet_id = v_o.id and material_id = v_id for update;
  end if;
  v_thr := nullif(app.setting(v_o.id, 'opname_ambang_nilai', ''), '')::numeric;   -- di atas ambang nilai, perlu supervisor/admin/owner
  if v_thr is not null and abs(v_new - v_old) * coalesce(v_hpp, v_cost) > v_thr
     and not app.has_role(v_o.id, array['owner','admin','supervisor']) then
    raise exception 'Penyesuaian bernilai besar perlu persetujuan supervisor.' using errcode = '42501'; end if;
  v_first := not exists (select 1 from public.stock_movements where outlet_id = v_o.id and item_type = v_type and item_id = v_id);
  if v_new <> v_old then
    v_res := app.stock_apply(v_o.id, v_type, v_id, v_new - v_old, case when v_first then 'opening' else 'adjustment' end,
                             'adjust', null, v_hpp, true, v_alasan, v_hpp is not null);
  elsif v_hpp is not null then
    if v_type = 'variant' then update public.inventory_balances set avg_cost = v_hpp, updated_at = now() where outlet_id = v_o.id and variant_id = v_id;
    else update public.inventory_material_balances set avg_cost = v_hpp, updated_at = now() where outlet_id = v_o.id and material_id = v_id; end if;
    v_res := v_old;
  else v_res := v_old; end if;
  perform app.audit(v_o.id, case when v_first then 'stock_opening' else 'opname' end, v_type, v_id::text,
                    jsonb_build_object('stok', v_old, 'hpp', v_cost), jsonb_build_object('stok', v_new, 'hpp', coalesce(v_hpp, v_cost), 'alasan', v_alasan));
  return jsonb_build_object('id', v_id, 'stok', v_res, 'hpp_rata2', coalesce(v_hpp, v_cost));
end $$;

-- ---------- Pembelian bahan ----------
create function app.purchase_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_o public.outlets; v_dup jsonb; v_id uuid := gen_random_uuid(); v_sum numeric := 0; v_ship numeric := greatest(coalesce(app.num(p, 'ongkir', 0), 0), 0);
        v_alloc boolean := coalesce((p ->> 'alokasi_ongkir')::boolean, true); v_e jsonb; v_qty numeric; v_price numeric; v_eff numeric; v_mat uuid;
        v_out jsonb := '[]'::jsonb; v_new numeric;
begin
  v_o := app.active_outlet(nullif(p ->> 'outlet_id', '')::uuid);
  perform app.require_role(v_o.id, array['owner','admin','supervisor','stok']);
  v_dup := app.idem_begin('purchase', p ->> 'request_id', p);                       -- kirim ulang tidak menambah stok dua kali
  if v_dup is not null then return v_dup; end if;
  if jsonb_typeof(p -> 'items') <> 'array' or jsonb_array_length(p -> 'items') = 0 then raise exception 'Daftar pembelian kosong.' using errcode = '22023'; end if;
  for v_e in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := app.num(v_e, 'qty'); v_price := app.num(v_e, 'harga_satuan');
    if v_qty is null or v_qty <= 0 or v_price is null or v_price < 0 then raise exception 'Jumlah atau harga tidak valid.' using errcode = '22023'; end if;
    v_sum := v_sum + v_qty * v_price;
  end loop;
  insert into public.purchases (id, outlet_id, supplier_id, request_id, doc_ref, subtotal, shipping, total, note, user_id)
  values (v_id, v_o.id, nullif(p ->> 'supplier_id', '')::uuid, p ->> 'request_id', nullif(p ->> 'doc_ref', ''), v_sum, v_ship, v_sum + v_ship,
          nullif(p ->> 'catatan', ''), (select auth.uid()));
  for v_e in select e from jsonb_array_elements(p -> 'items') e order by (e ->> 'material_id') loop       -- urutan tetap: tanpa deadlock
    v_mat := (v_e ->> 'material_id')::uuid; v_qty := app.num(v_e, 'qty'); v_price := app.num(v_e, 'harga_satuan');
    if not exists (select 1 from public.materials where id = v_mat) then raise exception 'Bahan tidak ditemukan.' using errcode = 'P0002'; end if;
    v_eff := v_price + case when v_alloc and v_sum > 0 then v_ship * (v_qty * v_price / v_sum) / v_qty else 0 end;
    insert into public.purchase_items (purchase_id, material_id, qty, unit_price, effective_cost) values (v_id, v_mat, v_qty, v_price, round(v_eff, 4));
    v_new := app.stock_apply(v_o.id, 'material', v_mat, v_qty, 'purchase', 'purchase', v_id, round(v_eff, 4), true, null);
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_mat, 'stok', v_new));
  end loop;
  perform app.audit(v_o.id, 'purchase', 'purchases', v_id::text, null, jsonb_build_object('total', v_sum + v_ship));
  return app.idem_finish('purchase', p ->> 'request_id', jsonb_build_object('id', v_id, 'total', v_sum + v_ship, 'materials', v_out));
end $$;

-- ---------- Produksi ----------
create function app.production_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_k public.outlets; v_out public.outlets; v_r public.recipes; v_b numeric := app.num(p, 'jumlah_batch'); v_id uuid; v_kind text := coalesce(p ->> 'jenis', 'batch');
begin
  v_k := app.active_outlet(nullif(p ->> 'kitchen_outlet_id', '')::uuid);
  v_out := app.active_outlet(coalesce(nullif(p ->> 'output_outlet_id', '')::uuid, v_k.id));
  perform app.require_role(v_k.id, array['owner','admin','supervisor','produksi']);
  select * into v_r from public.recipes where id = nullif(p ->> 'recipe_id', '')::uuid and active;
  if not found then raise exception 'Resep tidak ditemukan.' using errcode = 'P0002'; end if;
  if v_b is null or v_b <= 0 then raise exception 'Jumlah batch harus lebih dari 0.' using errcode = '22023'; end if;
  if v_kind not in ('batch','pesanan','repack') then v_kind := 'batch'; end if;
  insert into public.production_orders (kitchen_outlet_id, output_outlet_id, recipe_id, variant_id, kind, batches, standard_qty, note, user_id)
  values (v_k.id, v_out.id, v_r.id, v_r.variant_id, v_kind, v_b, v_r.standard_yield * v_b, nullif(p ->> 'catatan', ''), (select auth.uid())) returning id into v_id;
  perform app.audit(v_k.id, 'production_create', 'production_orders', v_id::text, null, jsonb_build_object('batch', v_b));
  return jsonb_build_object('id', v_id, 'status', 'planned');
end $$;

create function app.production_cancel(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.production_orders;
begin
  select * into v from public.production_orders where id = nullif(p ->> 'id', '')::uuid for update;
  if not found then raise exception 'Produksi tidak ditemukan.' using errcode = 'P0002'; end if;
  perform app.require_role(v.kitchen_outlet_id, array['owner','admin','supervisor','produksi']);
  if v.status <> 'planned' then raise exception 'Hanya produksi berstatus rencana yang bisa dibatalkan.' using errcode = 'P0001'; end if;
  update public.production_orders set status = 'cancelled' where id = v.id;
  perform app.audit(v.kitchen_outlet_id, 'production_cancel', 'production_orders', v.id::text, null, null);
  return jsonb_build_object('id', v.id, 'status', 'cancelled');
end $$;

-- Penyelesaian produksi ATOMIK: bahan berkurang, hasil bertambah, biaya tersimpan, atau tidak ada yang berubah.
create function app.production_complete(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v public.production_orders; v_r public.recipes; v_qty numeric := app.num(p, 'qty_hasil'); v_m record;
  v_bahan numeric := 0; v_kem numeric := 0; v_tk numeric; v_oh numeric; v_total numeric; v_unit numeric; v_c numeric; v_mats jsonb := '[]'::jsonb;
  v_new numeric; v_vnew numeric; v_vcost numeric; v_dup jsonb;
begin
  select * into v from public.production_orders where id = nullif(p ->> 'id', '')::uuid for update;   -- kunci: tidak bisa diselesaikan dua kali
  if not found then raise exception 'Produksi tidak ditemukan.' using errcode = 'P0002'; end if;
  perform app.require_role(v.kitchen_outlet_id, array['owner','admin','supervisor','produksi']);
  if v.status <> 'planned' then raise exception 'Produksi ini sudah berstatus %.', v.status using errcode = 'P0001'; end if;
  if v_qty is null or v_qty <= 0 then raise exception 'Hasil aktual harus lebih dari 0.' using errcode = '22023'; end if;
  perform app.active_outlet(v.kitchen_outlet_id); perform app.active_outlet(v.output_outlet_id);
  select * into v_r from public.recipes where id = v.recipe_id;

  for v_m in
    select ri.material_id, sum(ri.qty * v.batches) as need, m.type, m.name
    from public.recipe_items ri join public.materials m on m.id = ri.material_id
    where ri.recipe_id = v.recipe_id group by ri.material_id, m.type, m.name order by ri.material_id
  loop
    v_new := app.stock_apply(v.kitchen_outlet_id, 'material', v_m.material_id, -v_m.need, 'production_use', 'production', v.id, null, false, null);
    select avg_cost into v_c from public.inventory_material_balances where outlet_id = v.kitchen_outlet_id and material_id = v_m.material_id;
    if v_m.type = 'kemasan' then v_kem := v_kem + v_m.need * v_c; else v_bahan := v_bahan + v_m.need * v_c; end if;
    v_mats := v_mats || jsonb_build_array(jsonb_build_object('id', v_m.material_id, 'stok', v_new));
  end loop;

  v_tk := coalesce(app.num(p, 'tenaga_kerja'), v_r.labor_cost * v.batches);
  v_oh := coalesce(app.num(p, 'overhead'), case when app.setting(v.kitchen_outlet_id, 'metode_overhead', 'per_unit') = 'per_batch'
                    then coalesce(nullif(app.setting(v.kitchen_outlet_id, 'overhead_per_batch', '0'), '')::numeric, 0) * v.batches
                    else coalesce(nullif(app.setting(v.kitchen_outlet_id, 'overhead_per_unit', '0'), '')::numeric, 0) * v_qty end);
  if v_tk < 0 or v_oh < 0 then raise exception 'Biaya tidak valid.' using errcode = '22023'; end if;
  v_total := round(v_bahan + v_kem + v_tk + v_oh, 2); v_unit := round(v_total / v_qty, 4);

  v_vnew := app.stock_apply(v.output_outlet_id, 'variant', v.variant_id, v_qty, 'production_in', 'production', v.id, v_unit, true, null);
  select avg_cost into v_vcost from public.inventory_balances where outlet_id = v.output_outlet_id and variant_id = v.variant_id;

  insert into public.production_costs (production_id, materials_cost, packaging_cost, labor_cost, overhead_cost, total, unit_cost)
  values (v.id, round(v_bahan, 2), round(v_kem, 2), v_tk, v_oh, v_total, v_unit);
  update public.production_orders set status = 'done', actual_qty = v_qty, completed_at = now() where id = v.id;
  perform app.audit(v.kitchen_outlet_id, 'production_complete', 'production_orders', v.id::text, null,
                    jsonb_build_object('qty', v_qty, 'total', v_total, 'hpp_unit', v_unit));
  return jsonb_build_object('id', v.id, 'status', 'done', 'qty_hasil', v_qty,
    'costs', jsonb_build_object('bahan', v_bahan, 'kemasan', v_kem, 'tenaga_kerja', v_tk, 'overhead', v_oh, 'total', v_total, 'hpp_per_unit', v_unit),
    'materials', v_mats, 'variant', jsonb_build_object('id', v.variant_id, 'stok', v_vnew, 'hpp_rata2', v_vcost));
end $$;

-- ---------- Transfer stok antar-lokasi ----------
-- draft -> submitted -> approved -> sent -> received ; atau rejected / cancelled.
-- Saat 'sent' stok asal berkurang (barang dalam perjalanan); stok tujuan bertambah saat 'received'. Selisih tercatat per item.
create function app.transfer_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_f public.outlets; v_t public.outlets; v_id uuid := gen_random_uuid(); v_no text; v_seq int; v_e jsonb; v_status text := 'draft'; v_dup jsonb; v_local timestamp;
begin
  v_f := app.active_outlet(nullif(p ->> 'from_outlet_id', '')::uuid);
  v_t := app.active_outlet(nullif(p ->> 'to_outlet_id', '')::uuid);
  perform app.require_role(v_f.id, array['owner','admin','supervisor','stok']);
  if v_f.id = v_t.id then raise exception 'Outlet asal dan tujuan tidak boleh sama.' using errcode = '22023'; end if;
  v_dup := app.idem_begin('transfer_create', p ->> 'request_id', p);
  if v_dup is not null then return v_dup; end if;
  if jsonb_typeof(p -> 'items') <> 'array' or jsonb_array_length(p -> 'items') = 0 then raise exception 'Transfer minimal berisi satu item.' using errcode = '22023'; end if;
  v_local := now() at time zone v_f.timezone; v_seq := app.next_seq(v_f.id, 'transfer', v_local::date);
  v_no := 'TR-' || v_f.code || '-' || to_char(v_local, 'YYMMDD') || '-' || lpad(v_seq::text, 3, '0');
  if coalesce((p ->> 'ajukan')::boolean, false) then v_status := 'submitted'; end if;
  insert into public.stock_transfers (id, number, from_outlet_id, to_outlet_id, status, requested_by, note)
  values (v_id, v_no, v_f.id, v_t.id, v_status, (select auth.uid()), nullif(p ->> 'catatan', ''));
  for v_e in select * from jsonb_array_elements(p -> 'items') loop
    if coalesce(v_e ->> 'item_type', '') not in ('variant','material') or app.num(v_e, 'qty', 0) <= 0 then
      raise exception 'Item transfer tidak valid.' using errcode = '22023'; end if;
    insert into public.stock_transfer_items (transfer_id, item_type, item_id, qty_requested)
    values (v_id, v_e ->> 'item_type', (v_e ->> 'item_id')::uuid, app.num(v_e, 'qty'));
  end loop;
  perform app.audit(v_f.id, 'transfer_create', 'stock_transfers', v_id::text, null, jsonb_build_object('nomor', v_no, 'ke', v_t.code));
  return app.idem_finish('transfer_create', p ->> 'request_id', jsonb_build_object('id', v_id, 'number', v_no, 'status', v_status));
end $$;

create function app.transfer_action(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v public.stock_transfers; v_act text := p ->> 'action'; v_i record; v_cost numeric; v_rc numeric; v_dup jsonb; v_need_appr boolean; v_var int := 0;
begin
  select * into v from public.stock_transfers where id = nullif(p ->> 'id', '')::uuid for update;     -- satu aksi pada satu waktu per transfer
  if not found then raise exception 'Transfer tidak ditemukan.' using errcode = 'P0002'; end if;
  if p ? 'request_id' then
    v_dup := app.idem_begin('transfer_action', p ->> 'request_id', p);
    if v_dup is not null then return v_dup; end if;
  end if;
  v_need_appr := app.setting_bool(v.from_outlet_id, 'transfer_perlu_persetujuan', true);

  if v_act = 'submit' then
    perform app.require_role(v.from_outlet_id, array['owner','admin','supervisor','stok']);
    if v.status <> 'draft' then raise exception 'Hanya draft yang dapat diajukan (status: %).', v.status using errcode = 'P0001'; end if;
    update public.stock_transfers set status = 'submitted' where id = v.id;
  elsif v_act in ('approve','reject') then
    perform app.require_role(v.from_outlet_id, array['owner','admin','supervisor']);
    if v.status <> 'submitted' then raise exception 'Transfer belum diajukan atau sudah diproses (status: %).', v.status using errcode = 'P0001'; end if;
    update public.stock_transfers set status = case v_act when 'approve' then 'approved' else 'rejected' end, approved_by = (select auth.uid()) where id = v.id;
  elsif v_act = 'send' then
    perform app.require_role(v.from_outlet_id, array['owner','admin','supervisor','stok']);
    if not (v.status = 'approved' or (v.status = 'submitted' and not v_need_appr)) then
      raise exception 'Transfer belum disetujui atau sudah dikirim (status: %).', v.status using errcode = 'P0001'; end if;
    perform app.active_outlet(v.from_outlet_id); perform app.active_outlet(v.to_outlet_id);
    for v_i in select * from public.stock_transfer_items where transfer_id = v.id order by item_type, item_id loop
      perform app.stock_apply(v.from_outlet_id, v_i.item_type, v_i.item_id, -v_i.qty_requested, 'transfer_out', 'transfer', v.id, null, false, null);
      if v_i.item_type = 'variant' then select avg_cost into v_cost from public.inventory_balances where outlet_id = v.from_outlet_id and variant_id = v_i.item_id;
      else select avg_cost into v_cost from public.inventory_material_balances where outlet_id = v.from_outlet_id and material_id = v_i.item_id; end if;
      update public.stock_transfer_items set qty_sent = v_i.qty_requested, unit_cost = v_cost where id = v_i.id;
    end loop;
    update public.stock_transfers set status = 'sent', sent_at = now(), sent_by = (select auth.uid()) where id = v.id;
  elsif v_act = 'receive' then
    perform app.require_role(v.to_outlet_id, array['owner','admin','supervisor','stok']);
    if v.status <> 'sent' then raise exception 'Transfer belum dikirim atau sudah diterima (status: %).', v.status using errcode = 'P0001'; end if;
    perform app.active_outlet(v.to_outlet_id);
    for v_i in select * from public.stock_transfer_items where transfer_id = v.id order by item_type, item_id loop
      v_rc := coalesce((select app.num(e, 'qty_received') from jsonb_array_elements(coalesce(p -> 'items', '[]'::jsonb)) e
                        where e ->> 'item_id' = v_i.item_id::text and e ->> 'item_type' = v_i.item_type limit 1), v_i.qty_sent);
      if v_rc < 0 or v_rc > v_i.qty_sent + 0.0001 then
        raise exception 'Jumlah diterima harus antara 0 dan jumlah dikirim (%).', v_i.qty_sent using errcode = '22023'; end if;
      if v_rc > 0 then
        perform app.stock_apply(v.to_outlet_id, v_i.item_type, v_i.item_id, v_rc, 'transfer_in', 'transfer', v.id, v_i.unit_cost, true, null);
      end if;
      update public.stock_transfer_items set qty_received = v_rc where id = v_i.id;
      if abs(v_i.qty_sent - v_rc) > 0.0001 then v_var := v_var + 1; end if;
    end loop;
    update public.stock_transfers set status = 'received', received_at = now(), received_by = (select auth.uid()) where id = v.id;
    if v_var > 0 then perform app.audit(v.to_outlet_id, 'transfer_variance', 'stock_transfers', v.id::text, null, jsonb_build_object('item_selisih', v_var, 'nomor', v.number)); end if;
  elsif v_act = 'cancel' then
    perform app.require_role(v.from_outlet_id, array['owner','admin','supervisor','stok']);
    if v.status in ('received','rejected','cancelled') then raise exception 'Transfer sudah selesai (status: %).', v.status using errcode = 'P0001'; end if;
    if v.status = 'sent' then   -- barang masih di jalan: kembalikan ke asal (hanya supervisor ke atas)
      perform app.require_role(v.from_outlet_id, array['owner','admin','supervisor']);
      for v_i in select * from public.stock_transfer_items where transfer_id = v.id order by item_type, item_id loop
        perform app.stock_apply(v.from_outlet_id, v_i.item_type, v_i.item_id, v_i.qty_sent, 'transfer_cancel', 'transfer', v.id, v_i.unit_cost, true, null);
      end loop;
    end if;
    update public.stock_transfers set status = 'cancelled' where id = v.id;
  else
    raise exception 'Aksi transfer tidak dikenal: %', v_act using errcode = '22023';
  end if;

  perform app.audit(v.from_outlet_id, 'transfer_' || v_act, 'stock_transfers', v.id::text, jsonb_build_object('status', v.status), null);
  return app.idem_finish('transfer_action', p ->> 'request_id',
    jsonb_build_object('id', v.id, 'number', v.number, 'status', (select status from public.stock_transfers where id = v.id)));
end $$;
