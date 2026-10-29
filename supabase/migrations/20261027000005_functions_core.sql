-- 0005 Fungsi inti (skema privat `app`): otorisasi, idempotensi, audit, persediaan.
-- Fungsi SECURITY DEFINER hanya ada di skema `app` (tidak diekspos). Semuanya memeriksa auth.uid() sendiri.

-- ---------- Otorisasi ----------
create function app.uid() returns uuid language sql stable as $$ select auth.uid() $$;

-- Apakah pengguna aktif punya salah satu role pada outlet? Keanggotaan global (outlet_id NULL) berlaku di semua outlet.
create function app.has_role(p_outlet uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.memberships m
    join public.profiles p on p.id = m.user_id
    where m.user_id = (select auth.uid())
      and m.status = 'active' and p.status = 'active'
      and m.role = any (p_roles)
      and (m.outlet_id is null or m.outlet_id = p_outlet)
  );
$$;

create function app.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m join public.profiles p on p.id = m.user_id
    where m.user_id = (select auth.uid()) and m.status = 'active' and p.status = 'active'
      and m.role = 'owner' and m.outlet_id is null
  );
$$;

create function app.is_member_any() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m join public.profiles p on p.id = m.user_id
    where m.user_id = (select auth.uid()) and m.status = 'active' and p.status = 'active'
  );
$$;

-- Outlet yang boleh dilihat pengguna (untuk RLS dan daftar pilihan outlet).
create function app.my_outlet_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select o.id from public.outlets o
  where exists (
    select 1 from public.memberships m join public.profiles p on p.id = m.user_id
    where m.user_id = (select auth.uid()) and m.status = 'active' and p.status = 'active'
      and (m.outlet_id is null or m.outlet_id = o.id)
  );
$$;

create function app.require_role(p_outlet uuid, p_roles text[]) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000';
  end if;
  if not app.has_role(p_outlet, p_roles) then
    raise exception 'Akses ditolak untuk outlet ini.' using errcode = '42501';
  end if;
end $$;

-- Outlet harus aktif (dan, bila diminta, berjenis tertentu). Mengembalikan barisnya.
create function app.active_outlet(p_outlet uuid, p_kind text default null) returns public.outlets
language plpgsql stable security definer set search_path = '' as $$
declare o public.outlets;
begin
  select * into o from public.outlets where id = p_outlet;
  if not found then raise exception 'Outlet tidak ditemukan.' using errcode = 'P0002'; end if;
  if o.status <> 'active' then raise exception 'Outlet % tidak aktif; transaksi baru ditolak.', o.code using errcode = 'P0001'; end if;
  if p_kind is not null and o.kind <> p_kind then
    raise exception 'Outlet % bukan lokasi bertipe %.', o.code, p_kind using errcode = 'P0001';
  end if;
  return o;
end $$;

-- Nilai pengaturan: outlet menimpa global.
create function app.setting(p_outlet uuid, p_key text, p_default text default null) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select s.value from public.settings s where s.key = p_key and s.outlet_id = p_outlet),
    (select s.value from public.settings s where s.key = p_key and s.outlet_id is null limit 1),
    p_default);
$$;
create function app.setting_bool(p_outlet uuid, p_key text, p_default boolean) returns boolean
language sql stable security definer set search_path = '' as $$
  select lower(coalesce(app.setting(p_outlet, p_key, null), case when p_default then 'true' else 'false' end)) in ('true','1','yes','ya');
$$;

-- ---------- Audit ----------
create function app.audit(p_outlet uuid, p_action text, p_entity text, p_entity_id text, p_before jsonb, p_after jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_logs (organization_id, outlet_id, actor_id, action, entity, entity_id, before, after)
  values ((select id from public.organizations limit 1), p_outlet, (select auth.uid()), p_action, p_entity, p_entity_id, p_before, p_after);
end $$;

-- ---------- Idempotensi ----------
-- Mengembalikan hasil lama bila kunci sudah pernah selesai; NULL bila ini percobaan pertama.
-- Percobaan serentak dengan kunci sama menunggu di unique index sampai transaksi pertama commit/rollback.
create function app.idem_begin(p_scope text, p_key text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_hash text := md5(coalesce(p_payload::text, '')); v_n int; v_row app.idempotency_keys;
begin
  if p_key is null or length(trim(p_key)) < 8 then
    raise exception 'request_id wajib (minimal 8 karakter).' using errcode = '22023';
  end if;
  insert into app.idempotency_keys (scope, key, request_hash, user_id)
  values (p_scope, p_key, v_hash, (select auth.uid()))
  on conflict (scope, key) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 1 then return null; end if;
  select * into v_row from app.idempotency_keys where scope = p_scope and key = p_key;
  if v_row.request_hash <> v_hash then
    raise exception 'request_id sudah dipakai untuk permintaan yang berbeda.' using errcode = '23505';
  end if;
  return coalesce(v_row.result, '{}'::jsonb) || jsonb_build_object('duplicate', true);
end $$;

create function app.idem_finish(p_scope text, p_key text, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  update app.idempotency_keys set result = p_result where scope = p_scope and key = p_key;
  return p_result;
end $$;

-- ---------- Persediaan: SATU-SATUNYA jalur yang mengubah saldo ----------
-- Mengunci baris saldo, menolak stok negatif (kecuali diizinkan), memperbarui HPP rata-rata, dan menulis ledger.
-- Mengembalikan saldo baru.
create function app.stock_apply(
  p_outlet uuid, p_item_type text, p_item_id uuid, p_delta numeric, p_type text,
  p_ref_type text default null, p_ref_id uuid default null, p_unit_cost numeric default null,
  p_allow_negative boolean default false, p_note text default null, p_set_cost boolean default false
) returns numeric
language plpgsql security definer set search_path = '' as $$
declare v_old numeric; v_cost numeric; v_new numeric; v_newcost numeric; v_pos numeric; v_name text;
begin
  if p_delta is null or p_delta = 0 then return null; end if;
  if p_item_type = 'variant' then
    insert into public.inventory_balances (outlet_id, variant_id) values (p_outlet, p_item_id) on conflict do nothing;
    select quantity, avg_cost into v_old, v_cost from public.inventory_balances
      where outlet_id = p_outlet and variant_id = p_item_id for update;
  elsif p_item_type = 'material' then
    insert into public.inventory_material_balances (outlet_id, material_id) values (p_outlet, p_item_id) on conflict do nothing;
    select quantity, avg_cost into v_old, v_cost from public.inventory_material_balances
      where outlet_id = p_outlet and material_id = p_item_id for update;
  else
    raise exception 'Jenis item stok tidak valid: %', p_item_type using errcode = '22023';
  end if;

  v_new := round(v_old + p_delta, 4);
  if v_new < 0 and not p_allow_negative then
    if p_item_type = 'variant' then
      select coalesce(p.name, '?') || ' ' || v.sku into v_name from public.product_variants v
        left join public.products p on p.id = v.product_id where v.id = p_item_id;
    else
      select m.name into v_name from public.materials m where m.id = p_item_id;
    end if;
    raise exception 'Stok % tidak cukup (stok %, diminta %).', coalesce(v_name, p_item_id::text), v_old, abs(p_delta)
      using errcode = 'P0001', hint = 'STOCK_INSUFFICIENT';
  end if;

  v_newcost := v_cost;
  if p_unit_cost is not null then
    if p_set_cost then v_newcost := p_unit_cost;
    elsif p_delta > 0 then
      v_pos := greatest(v_old, 0);
      v_newcost := round((v_pos * v_cost + p_delta * p_unit_cost) / (v_pos + p_delta), 4);
    end if;
  end if;

  if p_item_type = 'variant' then
    update public.inventory_balances set quantity = v_new, avg_cost = v_newcost, updated_at = now()
      where outlet_id = p_outlet and variant_id = p_item_id;
  else
    update public.inventory_material_balances set quantity = v_new, avg_cost = v_newcost, updated_at = now()
      where outlet_id = p_outlet and material_id = p_item_id;
  end if;

  insert into public.stock_movements (outlet_id, item_type, item_id, movement_type, quantity_delta, unit_cost, value,
                                      balance_after, reference_type, reference_id, user_id, note)
  values (p_outlet, p_item_type, p_item_id, p_type, p_delta, coalesce(p_unit_cost, v_cost),
          round(p_delta * coalesce(p_unit_cost, v_cost), 4), v_new, p_ref_type, p_ref_id, (select auth.uid()), p_note);
  return v_new;
end $$;

-- Nomor urut harian per outlet; baris counter terkunci sampai transaksi selesai (tanpa nomor ganda).
create function app.next_seq(p_outlet uuid, p_kind text, p_day date) returns integer
language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  insert into app.outlet_counters (outlet_id, kind, day, last_seq) values (p_outlet, p_kind, p_day, 1)
  on conflict (outlet_id, kind, day) do update set last_seq = app.outlet_counters.last_seq + 1
  returning last_seq into v;
  return v;
end $$;

-- Harga berlaku: override outlet (terbaru yang sudah berlaku) -> harga global channel.
create function app.price_of(p_outlet uuid, p_variant uuid, p_channel uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select op.price from public.outlet_prices op
       where op.outlet_id = p_outlet and op.variant_id = p_variant and op.channel_id = p_channel
         and op.effective_from <= current_date order by op.effective_from desc limit 1),
    (select cp.price from public.channel_prices cp where cp.variant_id = p_variant and cp.channel_id = p_channel));
$$;

create function app.num(p jsonb, k text, d numeric default null) returns numeric
language sql immutable as $$
  select case when p ? k and jsonb_typeof(p -> k) = 'number' then (p ->> k)::numeric
              when p ? k and jsonb_typeof(p -> k) = 'string' and (p ->> k) ~ '^-?[0-9]+(\.[0-9]+)?$' then (p ->> k)::numeric
              else d end;
$$;

-- Hak eksekusi diatur eksplisit di migrasi 0008 (daftar putih). Fungsi pembantu internal
-- (stock_apply, idem_*, audit, next_seq, ...) sengaja TIDAK dapat dipanggil langsung oleh klien.
revoke all on all functions in schema app from public;
