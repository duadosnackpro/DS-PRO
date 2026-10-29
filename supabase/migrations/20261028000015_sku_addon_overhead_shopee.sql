-- 0015 Fitur UI v2.0.0 yang belum punya padanan di Supabase:
--   * SKU otomatis (trigger; aturan sama dengan genSkuLocal di UI)
--   * produk tambahan (kantong kresek dll.)   -> rpc_addon_create
--   * saran overhead dari biaya bulan lalu    -> rpc_overhead_saran
--   * impor pesanan Shopee (CSV)              -> rpc_shopee_import
-- Logo struk memakai rpc_settings_set (kunci logo_data, logo_aktif); foto produk memakai Supabase Storage (bucket product-photos, migrasi sebelumnya).

-- ---------- SKU otomatis ----------
create function app.sku_abbr(p_name text) returns text
language plpgsql immutable set search_path = pg_catalog as $$
declare w text[]; t text;
begin
  w := array_remove(regexp_split_to_array(trim(regexp_replace(
         translate(upper(coalesce(p_name, '')), 'ÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÇÑ', 'AAAAAAEEEEIIIIOOOOOUUUUCN'), '[^A-Z0-9 ]', ' ', 'g')), '\s+'), '');
  if w is null or coalesce(array_length(w, 1), 0) = 0 then return 'PRD'; end if;
  if array_length(w, 1) > 1 then
    return (select string_agg(substr(x, 1, 1), '' order by n) from unnest(w[1:3]) with ordinality as u(x, n));
  end if;
  t := substr(w[1], 1, 1) || regexp_replace(substr(w[1], 2), '[AEIOU]', '', 'g');
  if length(t) < 3 then t := w[1]; end if;
  return substr(t, 1, 3);
end $$;

create function app.sku_size(p_size text) returns text
language plpgsql immutable set search_path = pg_catalog as $$
declare t text := upper(coalesce(p_size, '')); m text[]; x text;
begin
  m := regexp_match(t, '(\d+(?:[.,]\d+)?)\s*(KG|GR|G|ML|LT|L|PCS|PACK)?');
  if m is not null then return regexp_replace(m[1], '[.,]', '', 'g') || coalesce(m[2], ''); end if;
  x := regexp_replace(t, '[^A-Z]', '', 'g');
  return case when x <> '' then substr(x, 1, 1) else '' end;
end $$;

create function app.sku_level(p_level text) returns text
language plpgsql immutable set search_path = pg_catalog as $$
declare raw text := trim(coalesce(p_level, '')); d text;
begin
  if raw = '' then return ''; end if;
  d := regexp_replace(raw, '\D', '', 'g');
  if d <> '' then return 'L' || left(d, 9)::int::text; end if;
  return substr(regexp_replace(upper(raw), '[^A-Z0-9]', '', 'g'), 1, 3);
end $$;

-- SKU kosong diisi otomatis dari nama produk + ukuran + level; bila sudah dipakai ditambah -2, -3, ...
create function app.variant_sku_fill() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_name text; v_base text; v_sku text; v_i int := 2;
begin
  if new.sku is null or length(trim(new.sku)) = 0 then
    select name into v_name from public.products where id = new.product_id;
    v_base := concat_ws('-', nullif(app.sku_abbr(v_name), ''), nullif(app.sku_size(new.size), ''), nullif(app.sku_level(new.spice_level), ''));
    v_sku := v_base;
    while exists (select 1 from public.product_variants where lower(sku) = lower(v_sku) and id <> new.id) loop
      v_sku := v_base || '-' || v_i; v_i := v_i + 1;
    end loop;
    new.sku := v_sku;
  else
    new.sku := trim(new.sku);
  end if;
  return new;
end $$;

create trigger variants_sku_fill before insert or update of sku on public.product_variants
  for each row execute function app.variant_sku_fill();

revoke all on function app.sku_abbr(text), app.sku_size(text), app.sku_level(text), app.variant_sku_fill() from public, anon, authenticated;

-- ---------- Produk tambahan (kategori "Tambahan"): produk + varian + harga semua channel aktif + stok awal, atomik ----------
create function app.addon_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_o public.outlets; v_nama text := trim(coalesce(p ->> 'nama', ''));
  v_harga numeric := app.num(p, 'harga'); v_hpp numeric := coalesce(app.num(p, 'hpp'), 0); v_stok numeric := coalesce(app.num(p, 'stok'), 0);
  v_prod uuid; v_var uuid; v_sku text;
begin
  if (select auth.uid()) is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  v_o := app.active_outlet(nullif(p ->> 'outlet_id', '')::uuid);
  perform app.require_role(v_o.id, array['owner','admin']);
  if length(v_nama) < 2 or length(v_nama) > 80 then raise exception 'Nama produk tambahan 2-80 karakter.' using errcode = '22023'; end if;
  if v_harga is null or v_harga < 0 then raise exception 'Harga jual tidak valid.' using errcode = '22023'; end if;
  if v_hpp < 0 then raise exception 'HPP tidak valid.' using errcode = '22023'; end if;
  if v_stok < 0 then raise exception 'Stok awal tidak valid.' using errcode = '22023'; end if;

  insert into public.products (name, category) values (v_nama, 'Tambahan') returning id into v_prod;
  insert into public.product_variants (product_id, sku) values (v_prod, '') returning id, sku into v_var, v_sku;   -- SKU diisi trigger
  insert into public.channel_prices (variant_id, channel_id, price) select v_var, c.id, v_harga from public.channels c where c.active;

  insert into public.inventory_balances (outlet_id, variant_id, avg_cost) values (v_o.id, v_var, v_hpp) on conflict do nothing;
  if v_stok > 0 then
    perform app.stock_apply(v_o.id, 'variant', v_var, v_stok, 'opening', 'addon', v_var, v_hpp, true, 'Stok awal produk tambahan', true);
  end if;
  perform app.audit(v_o.id, 'addon_create', 'products', v_prod::text, null,
                    jsonb_build_object('nama', v_nama, 'sku', v_sku, 'harga', v_harga, 'hpp', v_hpp, 'stok', v_stok));
  return jsonb_build_object('product_id', v_prod, 'variant_id', v_var, 'sku', v_sku);
end $$;

-- ---------- Saran overhead per bungkus: biaya bulan lalu (kategori yang sudah masuk HPP) / unit produksi selesai bulan lalu ----------
create function app.overhead_saran(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_o public.outlets; v_from date; v_to date; v_cats text[]; v_biaya numeric; v_unit numeric;
  v_mon text[] := array['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
begin
  if (select auth.uid()) is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  v_o := app.active_outlet(nullif(p ->> 'outlet_id', '')::uuid);
  perform app.require_role(v_o.id, array['owner','admin']);
  v_to := date_trunc('month', now() at time zone v_o.timezone)::date;
  v_from := (v_to - interval '1 month')::date;
  v_cats := array(select lower(trim(x)) from unnest(string_to_array(coalesce(app.setting(v_o.id, 'kategori_masuk_hpp', ''), ''), ',')) as x where trim(x) <> '');
  if coalesce(cardinality(v_cats), 0) = 0 then
    return jsonb_build_object('saran_per_unit', null, 'pesan', 'Isi dulu "Kategori biaya yang SUDAH masuk HPP" (mis. Listrik, Gas), simpan pengaturan, lalu hitung lagi.');
  end if;
  select coalesce(sum(amount), 0) into v_biaya from public.expenses
   where (outlet_id = v_o.id or outlet_id is null) and expense_date >= v_from and expense_date < v_to and lower(trim(category)) = any (v_cats);
  select coalesce(sum(actual_qty), 0) into v_unit from public.production_orders
   where kitchen_outlet_id = v_o.id and status = 'done'
     and (completed_at at time zone v_o.timezone)::date >= v_from and (completed_at at time zone v_o.timezone)::date < v_to;
  if v_biaya <= 0 then
    return jsonb_build_object('saran_per_unit', null, 'pesan', 'Tidak ada biaya pada kategori tersebut di bulan lalu.');
  end if;
  if v_unit <= 0 then
    return jsonb_build_object('saran_per_unit', null, 'pesan', 'Belum ada produksi yang selesai di bulan lalu, jadi belum bisa dibagi per bungkus.');
  end if;
  return jsonb_build_object('saran_per_unit', round(v_biaya / v_unit, 2), 'bulan', v_mon[extract(month from v_from)::int] || ' ' || extract(year from v_from)::int,
                            'biaya', v_biaya, 'unit', v_unit);
end $$;

-- ---------- Impor pesanan Shopee (tanggal asli, memotong stok, aman diimpor ulang) ----------
-- Tiap pesanan punya savepoint sendiri: satu gagal tidak membatalkan yang lain. Pesanan yang sudah ada (external_orders) dilewati.
-- Penjualan dicatat tanpa sesi kasir (bukan uang laci) dengan metode "lain"; harga dari berkas bila ada, selain itu harga channel Shopee.
create function app.shopee_import(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid()); v_o public.outlets; v_ch public.channels;
  v_ign boolean := lower(coalesce(p ->> 'abaikan_stok', 'true')) in ('true', '1', 'yes', 'ya');
  v_allow boolean; v_batch uuid := gen_random_uuid(); v_ord jsonb; v_oid text; v_sold timestamptz; v_local timestamp;
  v_sale uuid; v_no text; v_seq int; v_sub numeric; v_fee numeric; v_it record; v_price numeric; v_n int := 0;
  v_ok int := 0; v_dup int := 0; v_fail jsonb := '[]'::jsonb;
begin
  if v_uid is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  if (p ->> 'outlet_id') is null or (p ->> 'outlet_id') !~* '^[0-9a-f-]{36}$' then raise exception 'Outlet wajib dipilih.' using errcode = '22023'; end if;
  v_o := app.active_outlet((p ->> 'outlet_id')::uuid, 'store');
  perform app.require_role(v_o.id, array['owner','admin']);
  if jsonb_typeof(p -> 'orders') <> 'array' or jsonb_array_length(p -> 'orders') = 0 then raise exception 'Tidak ada pesanan untuk diimpor.' using errcode = '22023'; end if;
  if jsonb_array_length(p -> 'orders') > 50 then raise exception 'Maksimal 50 pesanan per permintaan.' using errcode = '22023'; end if;
  select * into v_ch from public.channels where active and lower(name) like '%shopee%' order by name limit 1;
  if not found then raise exception 'Channel "Shopee" tidak ditemukan. Buat channel bernama Shopee di Data Master lebih dulu.' using errcode = 'P0001'; end if;
  v_allow := v_ign or not app.setting_bool(v_o.id, 'block_negative_stock', true);

  create temp table if not exists _sh (variant_id uuid, qty numeric, price numeric, sku text, nm text) on commit drop;
  insert into public.import_batches (id, outlet_id, source, status, total_rows, created_by)
  values (v_batch, v_o.id, 'shopee', 'posted', jsonb_array_length(p -> 'orders'), v_uid);

  for v_ord in select * from jsonb_array_elements(p -> 'orders') loop
    v_oid := left(trim(coalesce(v_ord ->> 'order_id', '')), 80);
    begin
      if v_oid = '' then raise exception 'Nomor pesanan kosong.' using errcode = 'P0001'; end if;
      if exists (select 1 from public.external_orders where source = 'shopee' and external_id = v_oid) then
        v_dup := v_dup + 1;
      else
        if jsonb_typeof(v_ord -> 'items') <> 'array' or jsonb_array_length(v_ord -> 'items') = 0 then raise exception 'Pesanan tanpa item.' using errcode = 'P0001'; end if;
        if jsonb_array_length(v_ord -> 'items') > 100 then raise exception 'Terlalu banyak baris item.' using errcode = 'P0001'; end if;

        -- waktu pesanan (waktu lokal outlet); tidak valid atau di masa depan => waktu server
        v_sold := now();
        if coalesce(v_ord ->> 'tanggal', '') ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$' then
          begin v_sold := (v_ord ->> 'tanggal')::timestamp at time zone v_o.timezone; exception when others then v_sold := now(); end;
          if v_sold > now() + interval '5 minutes' or v_sold < timestamptz '2000-01-01' then v_sold := now(); end if;
        end if;

        truncate _sh; v_sub := 0; v_sale := gen_random_uuid();
        for v_it in
          select i.sk, v.id as variant_id, v.sku, v.active as vactive, pr.active as pactive, i.qty, i.harga,
                 trim(coalesce(pr.name, '') || ' ' || coalesce(v.size, '') ||
                      case when v.spice_level is null or v.spice_level = '' then '' else ' ' || v.spice_level end) as nm
          from (select lower(trim(e ->> 'sku')) as sk, sum((e ->> 'qty')::numeric) as qty,
                       round(sum((e ->> 'qty')::numeric * nullif(e ->> 'harga', '')::numeric)
                             filter (where nullif(e ->> 'harga', '') is not null)
                             / nullif(sum((e ->> 'qty')::numeric) filter (where nullif(e ->> 'harga', '') is not null), 0), 2) as harga
                from jsonb_array_elements(v_ord -> 'items') e group by 1) i
          left join public.product_variants v on lower(v.sku) = i.sk
          left join public.products pr on pr.id = v.product_id
          order by v.id
        loop
          if v_it.variant_id is null then raise exception 'SKU tidak dikenal: %', v_it.sk using errcode = 'P0001'; end if;
          if not v_it.vactive or not v_it.pactive then raise exception 'Varian nonaktif: %', v_it.sku using errcode = 'P0001'; end if;
          if v_it.qty is null or v_it.qty <= 0 or v_it.qty > 100000 then raise exception 'Jumlah tidak valid untuk %.', v_it.sku using errcode = 'P0001'; end if;
          v_price := coalesce(v_it.harga, app.price_of(v_o.id, v_it.variant_id, v_ch.id));
          if v_price is null or v_price < 0 then raise exception 'Harga belum diatur: % di %', v_it.sku, v_ch.name using errcode = 'P0001'; end if;
          insert into _sh values (v_it.variant_id, v_it.qty, v_price, v_it.sku, v_it.nm);
          v_sub := v_sub + round(v_it.qty * v_price, 2);
        end loop;

        for v_it in select * from _sh order by variant_id loop
          perform app.stock_apply(v_o.id, 'variant', v_it.variant_id, -v_it.qty, 'sale', 'sale', v_sale, null, v_allow, 'Impor Shopee ' || v_oid);
        end loop;

        v_fee := round(v_sub * v_ch.fee_percent / 100) + v_ch.fee_fixed;
        v_local := v_sold at time zone v_o.timezone;
        v_seq := app.next_seq(v_o.id, 'sale', v_local::date);
        v_no := v_o.code || '-' || to_char(v_local, 'YYMMDD') || '-' || lpad(v_seq::text, 3, '0');

        insert into public.sales (id, outlet_id, receipt_no, request_id, kind, channel_id, cashier_id, cash_session_id, status,
                                  subtotal, discount, fee_channel, tax_rate, tax_amount, total, payment_method, sold_at, note)
        values (v_sale, v_o.id, v_no, 'shopee:' || v_oid, 'sale', v_ch.id, v_uid, null, 'completed',
                v_sub, 0, v_fee, 0, 0, v_sub, 'lain', v_sold, 'Impor Shopee ' || v_oid);
        insert into public.sale_items (sale_id, outlet_id, variant_id, sku_snapshot, name_snapshot, qty, unit_price, hpp_snapshot)
        select v_sale, v_o.id, s.variant_id, s.sku, s.nm, s.qty, s.price, nullif(b.avg_cost, 0)
        from _sh s join public.inventory_balances b on b.outlet_id = v_o.id and b.variant_id = s.variant_id;
        insert into public.payments (sale_id, outlet_id, cash_session_id, method, amount, received, change_given, reference)
        values (v_sale, v_o.id, null, 'lain', v_sub, v_sub, 0, v_oid);
        insert into public.external_orders (source, external_id, sale_id, outlet_id, batch_id) values ('shopee', v_oid, v_sale, v_o.id, v_batch);
        v_ok := v_ok + 1;
      end if;
    exception
      when sqlstate '28000' then raise;
      when sqlstate '40001' or sqlstate '40P01' or sqlstate '55P03' then
        v_fail := v_fail || jsonb_build_array(jsonb_build_object('order_id', v_oid, 'error', 'Server sibuk, impor ulang file yang sama (pesanan yang sudah masuk dilewati).'));
      when others then
        v_fail := v_fail || jsonb_build_array(jsonb_build_object('order_id', v_oid, 'error', sqlerrm));
    end;
  end loop;

  update public.import_batches set ok_rows = v_ok, rejected_rows = jsonb_array_length(v_fail),
         status = case when v_ok = 0 and jsonb_array_length(v_fail) > 0 then 'failed' else 'posted' end,
         errors = case when jsonb_array_length(v_fail) > 0 then v_fail end
   where id = v_batch;
  perform app.audit(v_o.id, 'shopee_import', 'import_batches', v_batch::text, null,
                    jsonb_build_object('berhasil', v_ok, 'duplikat', v_dup, 'gagal', jsonb_array_length(v_fail)));
  return jsonb_build_object('ok', v_ok, 'duplikat', v_dup, 'gagal', v_fail, 'batch_id', v_batch);
end $$;

-- ---------- Pembungkus RPC publik + hak ----------
do $$ declare n text; begin
  foreach n in array array['addon_create', 'overhead_saran', 'shopee_import'] loop
    execute format('create function public.rpc_%1$s(p jsonb default ''{}''::jsonb) returns jsonb language sql security invoker set search_path = '''' as $f$ select app.%1$s(p) $f$', n);
    execute format('revoke all on function public.rpc_%1$s(jsonb) from public, anon', n);
    execute format('grant execute on function public.rpc_%1$s(jsonb) to authenticated', n);
    execute format('revoke all on function app.%1$s(jsonb) from public, anon', n);
    execute format('grant execute on function app.%1$s(jsonb) to authenticated', n);
  end loop;
end $$;
