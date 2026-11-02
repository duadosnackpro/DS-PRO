-- 0008 Pembacaan terkonteks outlet: bootstrap, ping, stok, riwayat, pengaturan, laporan, rekonsiliasi.

create function app.public_setting_keys() returns text[] language sql immutable as $$
  select array['nama_usaha','footer_struk','ppn_aktif','ppn_persen','ppn_inklusif','blokir_stok_minus','lebar_struk','auto_cetak',
               'stok_menipis','diskon_maks_persen','bayar_tunai','bayar_transfer','bayar_qris','logo_aktif','logo_nama','logo_data',
               'header_aktif','header_struk','footer_aktif','qr_struk','wajib_buka_kasir','block_negative_stock']::text[];
$$;

-- Role efektif tertinggi pengguna pada outlet (NULL bila tidak ada akses).
create function app.role_at(p_outlet uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.memberships m join public.profiles pr on pr.id = m.user_id
  where m.user_id = (select auth.uid()) and m.status = 'active' and pr.status = 'active' and (m.outlet_id is null or m.outlet_id = p_outlet)
  order by array_position(array['owner','admin','supervisor','stok','produksi','kasir','auditor'], m.role) limit 1;
$$;

create function app.ping(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_o uuid := nullif(p ->> 'outlet_id', '')::uuid; v_cat text; v_stk text;
begin
  if (select auth.uid()) is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  if v_o is not null then perform app.require_role(v_o, array['owner','admin','supervisor','kasir','stok','produksi','auditor']); end if;
  v_cat := md5(concat_ws('|',
    (select count(*) || ':' || coalesce(max(updated_at)::text, '') from public.products),
    (select count(*) || ':' || coalesce(max(updated_at)::text, '') from public.product_variants),
    (select count(*) || ':' || coalesce(max(updated_at)::text, '') from public.channels),
    (select count(*) || ':' || coalesce(max(updated_at)::text, '') from public.channel_prices),
    (select count(*) || ':' || coalesce(max(updated_at)::text, '') from public.settings),
    (select count(*) || ':' || coalesce(max(effective_from)::text, '') from public.outlet_prices where outlet_id = v_o)));
  select count(*) || ':' || coalesce(max(updated_at)::text, '') into v_stk from public.inventory_balances where outlet_id = v_o;
  return jsonb_build_object('ver', v_cat || '~' || coalesce(v_stk, ''), 'cat_ver', v_cat, 'stock_ver', coalesce(v_stk, ''), 'time', now());
end $$;

create function app.stock_get(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_o uuid := nullif(p ->> 'outlet_id', '')::uuid; v jsonb; r jsonb;
begin
  perform app.require_role(v_o, array['owner','admin','supervisor','kasir','stok','produksi','auditor']);
  r := app.ping(p);
  select coalesce(jsonb_object_agg(variant_id::text, quantity), '{}'::jsonb) into v from public.inventory_balances where outlet_id = v_o;
  return jsonb_build_object('stok', v, 'stock_ver', r ->> 'stock_ver', 'ver', r ->> 'ver');
end $$;

create function app.bootstrap(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid()); v_prof public.profiles; v_outlets jsonb; v_out uuid; v_role text; v_cost boolean; v_back boolean; v_full boolean;
  v_set jsonb; v_res jsonb; v_ver jsonb; v_act public.outlets;
begin
  if v_uid is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  select * into v_prof from public.profiles where id = v_uid and status = 'active';
  if not found then raise exception 'Sesi berakhir: akun tidak aktif.' using errcode = '28000'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'code', o.code, 'name', o.name, 'kind', o.kind, 'status', o.status,
           'timezone', o.timezone, 'address', o.address, 'role', r.role) order by o.code), '[]'::jsonb)
    into v_outlets
    from public.outlets o
    cross join lateral (select m.role from public.memberships m
                        where m.user_id = v_uid and m.status = 'active' and (m.outlet_id is null or m.outlet_id = o.id)
                        order by array_position(array['owner','admin','supervisor','stok','produksi','kasir','auditor'], m.role) limit 1) r;

  v_out := coalesce(
    (select (e ->> 'id')::uuid from jsonb_array_elements(v_outlets) e where (e ->> 'id') = p ->> 'outlet_id' and e ->> 'status' = 'active'),
    (select (e ->> 'id')::uuid from jsonb_array_elements(v_outlets) e where (e ->> 'id') = v_prof.default_outlet_id::text and e ->> 'status' = 'active'),
    (select (e ->> 'id')::uuid from jsonb_array_elements(v_outlets) e where e ->> 'status' = 'active' and e ->> 'kind' = 'store' limit 1),
    (select (e ->> 'id')::uuid from jsonb_array_elements(v_outlets) e where e ->> 'status' = 'active' limit 1));

  v_res := jsonb_build_object('server_time', to_char(now() at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS'),
    'user', jsonb_build_object('uid', v_uid, 'nama', v_prof.full_name, 'username', v_prof.username), 'outlets', v_outlets);
  if v_out is null then
    return v_res || jsonb_build_object('outlet', null, 'channels', '[]'::jsonb, 'products', '[]'::jsonb, 'variants', '[]'::jsonb, 'prices', '[]'::jsonb, 'settings', '{}'::jsonb);
  end if;

  select * into v_act from public.outlets where id = v_out;
  v_role := app.role_at(v_out);
  v_cost := v_role in ('owner','admin','auditor');
  v_back := v_role in ('owner','admin','supervisor','stok','produksi');
  v_full := v_role in ('owner','admin');
  v_ver := app.ping(jsonb_build_object('outlet_id', v_out));

  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into v_set from (
    select distinct on (key) key, value from public.settings
    where (outlet_id is null or outlet_id = v_out) and key <> 'logo_data_raw' and (v_full or key = any (app.public_setting_keys()))
    order by key, (outlet_id is null)) s;
  v_set := v_set || jsonb_build_object('blokir_stok_minus', coalesce(v_set ->> 'block_negative_stock', 'true'));

  v_res := v_res || jsonb_build_object('outlet', to_jsonb(v_act) - 'legacy_id' - 'created_by', 'role', v_role,
    'ver', v_ver ->> 'ver', 'cat_ver', v_ver ->> 'cat_ver', 'stock_ver', v_ver ->> 'stock_ver', 'settings', v_set,
    'channels', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'nama', c.name, 'fee_persen', c.fee_percent, 'fee_tetap', c.fee_fixed,
                  'basis_fee', c.fee_basis, 'aktif', true) order by c.name), '[]'::jsonb) from public.channels c where c.active),
    'products', (select coalesce(jsonb_agg(jsonb_build_object('id', pr.id, 'nama', pr.name, 'kategori', pr.category, 'aktif', true, 'foto_url', pr.photo_url)
                  order by pr.name), '[]'::jsonb) from public.products pr where pr.active),
    'variants', (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'product_id', v.product_id, 'sku', v.sku, 'ukuran', v.size,
                  'level_pedas', v.spice_level, 'aktif', true, 'stok', coalesce(b.quantity, 0))
                  || case when v_cost then jsonb_build_object('hpp_rata2', coalesce(b.avg_cost, 0)) else '{}'::jsonb end order by v.sku), '[]'::jsonb)
                 from public.product_variants v join public.products pr on pr.id = v.product_id and pr.active
                 left join public.inventory_balances b on b.outlet_id = v_out and b.variant_id = v.id where v.active),
    'prices', (select coalesce(jsonb_agg(jsonb_build_object('variant_id', v.id, 'channel_id', c.id, 'harga_jual', app.price_of(v_out, v.id, c.id))), '[]'::jsonb)
               from public.product_variants v join public.products pr on pr.id = v.product_id and pr.active
               cross join public.channels c where v.active and c.active and app.price_of(v_out, v.id, c.id) is not null));

  if v_back then
    v_res := v_res || jsonb_build_object(
      'materials', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'nama', m.name, 'tipe', m.type, 'satuan', m.unit, 'stok', coalesce(b.quantity, 0),
                      'stok_minimum', m.min_stock, 'aktif', true, 'satuan_kecil', m.small_unit, 'faktor_kecil', m.small_factor)
                      || case when v_cost then jsonb_build_object('hpp_rata2', coalesce(b.avg_cost, 0)) else '{}'::jsonb end order by m.name), '[]'::jsonb)
                    from public.materials m left join public.inventory_material_balances b on b.outlet_id = v_out and b.material_id = m.id where m.active),
      'suppliers', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'nama', s.name, 'kontak', s.contact, 'catatan', s.notes, 'aktif', true) order by s.name), '[]'::jsonb)
                    from public.suppliers s where s.active),
      'recipes', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'variant_id', r.variant_id, 'nama', r.name, 'hasil_standar', r.standard_yield,
                    'jenis', r.kind, 'aktif', true, 'tenaga_kerja', r.labor_cost)), '[]'::jsonb) from public.recipes r where r.active),
      'recipe_items', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'recipe_id', i.recipe_id, 'material_id', i.material_id, 'qty', i.qty)), '[]'::jsonb)
                       from public.recipe_items i join public.recipes r on r.id = i.recipe_id and r.active));
  end if;
  return v_res;
end $$;

-- Riwayat per hari (zona waktu outlet). Kasir hanya melihat transaksinya sendiri.
create function app.sales_list(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_o public.outlets; v_day date; v_lim int := least(coalesce(app.num(p, 'limit', 50), 50), 500)::int; v_off int := greatest(coalesce(app.num(p, 'offset', 0), 0), 0)::int;
        v_all boolean; v_rows jsonb; v_sum jsonb; v_from timestamptz; v_to timestamptz; v_total int;
begin
  select * into v_o from public.outlets where id = nullif(p ->> 'outlet_id', '')::uuid;
  if not found then raise exception 'Outlet tidak ditemukan.' using errcode = 'P0002'; end if;
  perform app.require_role(v_o.id, array['owner','admin','supervisor','kasir','auditor']);
  v_all := app.has_role(v_o.id, array['owner','admin','supervisor','auditor']);
  v_day := coalesce(nullif(p ->> 'tanggal', '')::date, (now() at time zone v_o.timezone)::date);
  v_from := v_day::timestamp at time zone v_o.timezone; v_to := (v_day + 1)::timestamp at time zone v_o.timezone;
  select count(*) into v_total from public.sales s where s.outlet_id = v_o.id and s.sold_at >= v_from and s.sold_at < v_to and (v_all or s.cashier_id = (select auth.uid()));
  select coalesce(jsonb_agg(x order by (x ->> 'tanggal') desc), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('id', s.id, 'nomor', s.receipt_no, 'tanggal', to_char(s.sold_at at time zone v_o.timezone, 'YYYY-MM-DD HH24:MI:SS'),
      'channel_id', s.channel_id, 'kasir_id', s.cashier_id, 'subtotal', s.subtotal, 'diskon', s.discount, 'fee_channel', s.fee_channel,
      'ppn_nominal', s.tax_amount, 'total', s.total, 'metode_bayar', s.payment_method, 'status', case s.status when 'completed' then 'selesai' else 'batal' end,
      'catatan', s.note, 'ref_sale_id', s.ref_sale_id, 'outlet_id', s.outlet_id) as x
    from public.sales s where s.outlet_id = v_o.id and s.sold_at >= v_from and s.sold_at < v_to and (v_all or s.cashier_id = (select auth.uid()))
    order by s.sold_at desc limit v_lim offset v_off) q;
  select jsonb_build_object('omzet', coalesce(sum(s.total), 0), 'nTrx', count(*) filter (where s.kind = 'sale'), 'nDone', count(*))
    into v_sum from public.sales s where s.outlet_id = v_o.id and s.status = 'completed' and s.sold_at >= v_from and s.sold_at < v_to and (v_all or s.cashier_id = (select auth.uid()));
  return jsonb_build_object('rows', v_rows, 'total', v_total, 'offset', v_off, 'summary', v_sum);
end $$;

create function app.sale_detail(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v public.sales; v_lines jsonb;
begin
  select * into v from public.sales where id = nullif(p ->> 'id', '')::uuid;
  if not found then raise exception 'Penjualan tidak ditemukan.' using errcode = 'P0002'; end if;
  perform app.require_role(v.outlet_id, array['owner','admin','supervisor','kasir','auditor']);
  if not app.has_role(v.outlet_id, array['owner','admin','supervisor','auditor']) and v.cashier_id <> (select auth.uid()) then
    raise exception 'Akses ditolak.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('variant_id', variant_id, 'jual', jual, 'kembali', kembali, 'sisa', jual - kembali, 'harga', harga, 'sku', sku, 'nama', nm)), '[]'::jsonb)
    into v_lines from (
      select i.variant_id, sum(i.qty) filter (where i.qty > 0) as jual, coalesce(-sum(i.qty) filter (where i.qty < 0), 0) as kembali,
             max(i.unit_price) as harga, max(i.sku_snapshot) as sku, max(i.name_snapshot) as nm
      from public.sale_items i join public.sales s on s.id = i.sale_id
      where s.id = v.id or (s.ref_sale_id = v.id and s.status = 'completed') group by i.variant_id) l;
  return jsonb_build_object('sale', to_jsonb(v), 'items', case when v.kind = 'return' then '[]'::jsonb else v_lines end);
end $$;

-- ---------- Pengaturan ----------
create function app.settings_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_o uuid := nullif(p ->> 'outlet_id', '')::uuid; v_k text; v_v text; v_org uuid; v_n int := 0;
begin
  perform app.require_role(v_o, array['owner','admin']);
  select id into v_org from public.organizations limit 1;
  for v_k, v_v in select key, case when jsonb_typeof(value) = 'string' then value #>> '{}' else value::text end from jsonb_each(coalesce(p -> 'values', '{}'::jsonb)) loop
    if v_k !~ '^[a-z0-9_]{2,60}$' then raise exception 'Nama pengaturan tidak valid: %', v_k using errcode = '22023'; end if;
    if length(v_v) > 120000 then raise exception 'Nilai pengaturan % terlalu besar.', v_k using errcode = '22023'; end if;
    insert into public.settings (organization_id, outlet_id, key, value, updated_by, updated_at) values (v_org, v_o, v_k, v_v, (select auth.uid()), now())
    on conflict (organization_id, coalesce(outlet_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
    do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
    v_n := v_n + 1;
    perform app.audit(v_o, 'setting', 'settings', v_k, null, case when v_k like 'logo%' then jsonb_build_object('diubah', true) else jsonb_build_object('nilai', left(v_v, 200)) end);
  end loop;
  return jsonb_build_object('ok', true, 'jumlah', v_n);
end $$;

-- ---------- Laporan (agregasi di server; tidak ada unduhan seluruh histori) ----------
-- Opsi "semua outlet" hanya untuk keanggotaan global owner/admin/auditor. Total konsolidasi = jumlah baris outlet (satu CTE).
create function app.report_sales(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_o uuid := nullif(p ->> 'outlet_id', '')::uuid; v_from date := coalesce(nullif(p ->> 'from', '')::date, current_date);
        v_to date := coalesce(nullif(p ->> 'to', '')::date, current_date); v_rows jsonb; v_tot jsonb; v_ch jsonb; v_day jsonb;
begin
  if v_to < v_from or v_to - v_from > 400 then raise exception 'Rentang tanggal tidak valid (maksimal 400 hari).' using errcode = '22023'; end if;
  if v_o is null then perform app.require_role(null, array['owner','admin','auditor']);
  else perform app.require_role(v_o, array['owner','admin','supervisor','auditor']); end if;

  create temp table if not exists _rs on commit drop as select * from public.sales where false;
  truncate _rs;
  insert into _rs select s.* from public.sales s join public.outlets o on o.id = s.outlet_id
   where s.status = 'completed' and (v_o is null or s.outlet_id = v_o)
     and s.sold_at >= (v_from::timestamp at time zone o.timezone) and s.sold_at < ((v_to + 1)::timestamp at time zone o.timezone);

  select coalesce(jsonb_agg(to_jsonb(r) order by r.outlet_code), '[]'::jsonb) into v_rows from (
    select o.id as outlet_id, o.code as outlet_code, o.name as outlet_name,
      count(*) filter (where s.kind = 'sale') as transaksi, coalesce(sum(s.subtotal), 0) as kotor, coalesce(sum(s.discount), 0) as diskon,
      coalesce(sum(s.tax_amount), 0) as pajak, coalesce(sum(s.total) filter (where s.kind = 'return'), 0) * -1 as retur,
      coalesce(sum(s.total), 0) as penjualan_bersih, coalesce(sum(s.fee_channel), 0) as fee_channel,
      coalesce((select sum(i.qty * i.hpp_snapshot) from public.sale_items i where i.sale_id in (select id from _rs x where x.outlet_id = o.id)), 0) as hpp,
      (select count(*) from public.sale_items i where i.hpp_snapshot is null and i.sale_id in (select id from _rs x where x.outlet_id = o.id)) as baris_tanpa_hpp
    from public.outlets o left join _rs s on s.outlet_id = o.id
    where (v_o is null or o.id = v_o) group by o.id, o.code, o.name) r;

  select jsonb_build_object('transaksi', coalesce(sum((x ->> 'transaksi')::numeric), 0), 'kotor', coalesce(sum((x ->> 'kotor')::numeric), 0),
    'diskon', coalesce(sum((x ->> 'diskon')::numeric), 0), 'pajak', coalesce(sum((x ->> 'pajak')::numeric), 0), 'retur', coalesce(sum((x ->> 'retur')::numeric), 0),
    'penjualan_bersih', coalesce(sum((x ->> 'penjualan_bersih')::numeric), 0), 'fee_channel', coalesce(sum((x ->> 'fee_channel')::numeric), 0),
    'hpp', coalesce(sum((x ->> 'hpp')::numeric), 0), 'baris_tanpa_hpp', coalesce(sum((x ->> 'baris_tanpa_hpp')::numeric), 0))
    into v_tot from jsonb_array_elements(v_rows) x;

  select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) into v_ch from (
    select ch.name as channel, count(*) filter (where s.kind = 'sale') as transaksi, sum(s.total) as penjualan_bersih, sum(s.fee_channel) as fee
    from _rs s join public.channels ch on ch.id = s.channel_id group by ch.name order by 3 desc) c;
  select coalesce(jsonb_agg(to_jsonb(d) order by d.tanggal), '[]'::jsonb) into v_day from (
    select (s.sold_at at time zone o.timezone)::date as tanggal, sum(s.total) as penjualan_bersih, count(*) filter (where s.kind = 'sale') as transaksi
    from _rs s join public.outlets o on o.id = s.outlet_id group by 1) d;

  return jsonb_build_object('from', v_from, 'to', v_to, 'outlet_id', v_o, 'per_outlet', v_rows, 'total', v_tot, 'per_channel', v_ch, 'per_hari', v_day,
    'catatan', 'penjualan_bersih = penjualan dikurangi retur (nilai transaksi, termasuk pajak). baris_tanpa_hpp > 0 berarti HPP tidak lengkap (bukan dianggap nol).');
end $$;

-- Laba rugi sederhana. Biaya pusat ditampilkan terpisah (tidak dialokasikan otomatis).
create function app.report_pnl(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_o uuid := nullif(p ->> 'outlet_id', '')::uuid; v_from date := coalesce(nullif(p ->> 'from', '')::date, current_date);
        v_to date := coalesce(nullif(p ->> 'to', '')::date, current_date); v_s jsonb; v_exp numeric; v_cen numeric; v_cat jsonb; v_net numeric; v_hpp numeric; v_fee numeric;
begin
  if v_o is null then perform app.require_role(null, array['owner','admin','auditor']); else perform app.require_role(v_o, array['owner','admin','auditor']); end if;
  v_s := app.report_sales(p);
  select coalesce(sum(amount), 0) into v_exp from public.expenses where outlet_id is not null and (v_o is null or outlet_id = v_o) and expense_date between v_from and v_to;
  select coalesce(sum(amount), 0) into v_cen from public.expenses where outlet_id is null and v_o is null and expense_date between v_from and v_to;
  select coalesce(jsonb_agg(jsonb_build_object('kategori', category, 'nominal', t)), '[]'::jsonb) into v_cat from (
    select category, sum(amount) t from public.expenses where (v_o is null or outlet_id = v_o or (outlet_id is null and v_o is null)) and expense_date between v_from and v_to group by category order by 2 desc) e;
  v_net := (v_s -> 'total' ->> 'penjualan_bersih')::numeric - (v_s -> 'total' ->> 'pajak')::numeric;
  v_hpp := (v_s -> 'total' ->> 'hpp')::numeric; v_fee := (v_s -> 'total' ->> 'fee_channel')::numeric;
  return jsonb_build_object('from', v_from, 'to', v_to, 'omzet_bersih_tanpa_pajak', v_net, 'hpp', v_hpp, 'fee_channel', v_fee, 'biaya_outlet', v_exp, 'biaya_pusat', v_cen,
    'laba_outlet', v_net - v_hpp - v_fee - v_exp, 'laba_setelah_biaya_pusat', v_net - v_hpp - v_fee - v_exp - v_cen,
    'per_kategori_biaya', v_cat, 'hpp_lengkap', (v_s -> 'total' ->> 'baris_tanpa_hpp')::numeric = 0, 'baris_tanpa_hpp', v_s -> 'total' -> 'baris_tanpa_hpp');
end $$;

create function app.report_stock_value(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_o uuid := nullif(p ->> 'outlet_id', '')::uuid; v_rows jsonb;
begin
  if v_o is null then perform app.require_role(null, array['owner','admin','auditor']); else perform app.require_role(v_o, array['owner','admin','auditor']); end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.outlet_code), '[]'::jsonb) into v_rows from (
    select o.id as outlet_id, o.code as outlet_code,
      coalesce((select sum(quantity * avg_cost) from public.inventory_balances b where b.outlet_id = o.id), 0) as nilai_produk_jadi,
      coalesce((select sum(quantity * avg_cost) from public.inventory_material_balances b where b.outlet_id = o.id), 0) as nilai_bahan,
      (select count(*) from public.inventory_balances b where b.outlet_id = o.id and b.quantity <= b.min_qty and b.min_qty > 0) as produk_menipis,
      (select count(*) from public.inventory_balances b where b.outlet_id = o.id and b.quantity < 0) as produk_minus
    from public.outlets o where v_o is null or o.id = v_o) r;
  return jsonb_build_object('per_outlet', v_rows);
end $$;

-- Rekonsiliasi saldo vs ledger. Hanya MELAPORKAN selisih; tidak pernah mengoreksi diam-diam.
create function app.stock_reconcile(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_o uuid := nullif(p ->> 'outlet_id', '')::uuid; v_rows jsonb;
begin
  if v_o is null then perform app.require_role(null, array['owner','admin','auditor']); else perform app.require_role(v_o, array['owner','admin','auditor']); end if;
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_rows from (
    select b.outlet_id, 'variant' as item_type, b.variant_id as item_id, b.quantity as saldo, coalesce(l.s, 0) as ledger, b.quantity - coalesce(l.s, 0) as selisih
    from public.inventory_balances b left join (select outlet_id, item_id, sum(quantity_delta) s from public.stock_movements where item_type = 'variant' group by 1, 2) l
      on l.outlet_id = b.outlet_id and l.item_id = b.variant_id where (v_o is null or b.outlet_id = v_o) and abs(b.quantity - coalesce(l.s, 0)) > 0.0001
    union all
    select b.outlet_id, 'material', b.material_id, b.quantity, coalesce(l.s, 0), b.quantity - coalesce(l.s, 0)
    from public.inventory_material_balances b left join (select outlet_id, item_id, sum(quantity_delta) s from public.stock_movements where item_type = 'material' group by 1, 2) l
      on l.outlet_id = b.outlet_id and l.item_id = b.material_id where (v_o is null or b.outlet_id = v_o) and abs(b.quantity - coalesce(l.s, 0)) > 0.0001) x;
  return jsonb_build_object('selisih', v_rows, 'jumlah', jsonb_array_length(v_rows));
end $$;

-- Biaya/HPP per item (kolom biaya disembunyikan dari akses tabel langsung).
create function app.cost_snapshot(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_o uuid := nullif(p ->> 'outlet_id', '')::uuid;
begin
  perform app.require_role(v_o, array['owner','admin','auditor']);
  return jsonb_build_object('varian', (select coalesce(jsonb_object_agg(variant_id::text, avg_cost), '{}'::jsonb) from public.inventory_balances where outlet_id = v_o),
                            'bahan', (select coalesce(jsonb_object_agg(material_id::text, avg_cost), '{}'::jsonb) from public.inventory_material_balances where outlet_id = v_o));
end $$;

-- Tabel kerja laporan sementara (temp) ditutup saat commit.
