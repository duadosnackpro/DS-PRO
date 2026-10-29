-- 0006 Transaksi penjualan, retur, sesi kasir, kas, pengeluaran.
-- Setiap fungsi = SATU transaksi database: gagal di tengah => semuanya rollback.
-- Payload mengikuti nama field v2.0.0 (request_id, channel_id, items, diskon, metode_bayar, ...) agar klien lama mudah beradaptasi.

-- Sesi kasir aktif milik kasir; dibuat otomatis (bila diizinkan) agar alur v2.0.0 tetap jalan.
create function app.ensure_session(p_outlet uuid, p_cashier uuid) returns uuid
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
  if app.setting_bool(p_outlet, 'wajib_buka_kasir', false) then
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

create function app.sale_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_outlet public.outlets;
  v_req text := p ->> 'request_id';
  v_dup jsonb;
  v_cashier uuid := v_uid;
  v_channel public.channels;
  v_method text := lower(coalesce(nullif(p ->> 'metode_bayar', ''), 'tunai'));
  v_l record;
  v_price numeric; v_cost numeric; v_new numeric;
  v_subtotal numeric := 0; v_discount numeric; v_base numeric;
  v_rate numeric; v_tax numeric := 0; v_total numeric; v_fee numeric; v_maxpct numeric;
  v_ctotal numeric := app.num(p, 'total_klien'); v_recv numeric; v_change numeric := 0;
  v_session uuid; v_sale uuid := gen_random_uuid(); v_no text; v_seq int;
  v_sold timestamptz := now(); v_cts timestamptz; v_local timestamp;
  v_stock jsonb := '{}'::jsonb; v_res jsonb; v_noneg boolean; v_n int := 0; v_note text := nullif(trim(p ->> 'catatan'), '');
begin
  if v_uid is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  if (p ->> 'outlet_id') is null or (p ->> 'outlet_id') !~* '^[0-9a-f-]{36}$' then
    raise exception 'Outlet wajib dipilih.' using errcode = '22023';
  end if;
  v_outlet := app.active_outlet((p ->> 'outlet_id')::uuid, 'store');
  perform app.require_role(v_outlet.id, array['owner','admin','supervisor','kasir']);

  v_dup := app.idem_begin('sale', v_req, p - 'client_ts');   -- retry dengan payload sama => hasil lama
  if v_dup is not null then return v_dup; end if;

  -- Owner/admin/supervisor boleh mengirim antrean milik kasir lain (mis. persetujuan diskon di atas batas).
  if (p ->> 'kasir_id') is not null and (p ->> 'kasir_id')::uuid <> v_uid then
    perform app.require_role(v_outlet.id, array['owner','admin','supervisor']);
    if not exists (select 1 from public.memberships m join public.profiles pr on pr.id = m.user_id
                   where m.user_id = (p ->> 'kasir_id')::uuid and m.status = 'active' and pr.status = 'active'
                     and (m.outlet_id is null or m.outlet_id = v_outlet.id)) then
      raise exception 'Kasir asal transaksi tidak ditemukan atau tidak ditugaskan di outlet ini.' using errcode = 'P0001';
    end if;
    v_cashier := (p ->> 'kasir_id')::uuid;
  end if;

  if v_method not in ('tunai','transfer','qris') or not app.setting_bool(v_outlet.id, 'bayar_' || v_method, true) then
    raise exception 'Metode bayar "%" tidak diizinkan.', v_method using errcode = 'P0001';
  end if;

  select * into v_channel from public.channels where id = nullif(p ->> 'channel_id', '')::uuid and active;
  if not found then raise exception 'Channel tidak valid.' using errcode = 'P0001'; end if;

  if jsonb_typeof(p -> 'items') <> 'array' or jsonb_array_length(p -> 'items') = 0 then
    raise exception 'Keranjang kosong.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p -> 'items') e
             where coalesce(e ->> 'variant_id', '') !~* '^[0-9a-f-]{36}$'
                or coalesce(e ->> 'qty', '') !~ '^[0-9]+(\.[0-9]{1,4})?$'
                or (e ->> 'qty')::numeric <= 0) then
    raise exception 'Item keranjang tidak valid (varian atau jumlah).' using errcode = '22023';
  end if;

  v_noneg := app.setting_bool(v_outlet.id, 'block_negative_stock', true);

  -- Waktu transaksi dari perangkat dipakai hanya bila masuk akal (antrean offline), selain itu waktu server.
  begin
    if jsonb_typeof(p -> 'client_ts') = 'number' then v_cts := to_timestamp((p ->> 'client_ts')::numeric / 1000.0);
    elsif (p ->> 'client_ts') is not null then v_cts := (p ->> 'client_ts')::timestamptz; end if;
  exception when others then v_cts := null; end;
  if v_cts is not null and v_cts <= now() + interval '5 minutes' and v_cts >= now() - interval '72 hours' then
    v_sold := least(v_cts, now());
  elsif v_cts is not null then
    v_note := trim(coalesce(v_note, '') || ' [waktu perangkat tidak valid, dipakai waktu server]');
  end if;

  -- 1) Baris dikunci berurutan per varian (hindari deadlock antar kasir) dan total dihitung SERVER.
  create temp table if not exists _sl (variant_id uuid, qty numeric, price numeric, sku text, nm text) on commit drop;
  truncate _sl;
  for v_l in
    select i.variant_id, i.qty, v.sku, v.active as vactive, pr.active as pactive,
           trim(coalesce(pr.name, '') || ' ' || coalesce(v.size, '') ||
                case when v.spice_level is null or v.spice_level = '' then '' else ' ' || v.spice_level end) as nm
    from (select (e ->> 'variant_id')::uuid as variant_id, sum((e ->> 'qty')::numeric) as qty
          from jsonb_array_elements(p -> 'items') e group by 1) i
    left join public.product_variants v on v.id = i.variant_id
    left join public.products pr on pr.id = v.product_id
    order by i.variant_id
  loop
    if v_l.sku is null then raise exception 'Varian tidak ditemukan.' using errcode = 'P0001'; end if;
    if not v_l.vactive or not v_l.pactive then raise exception 'Varian nonaktif: %', v_l.sku using errcode = 'P0001'; end if;
    v_price := app.price_of(v_outlet.id, v_l.variant_id, v_channel.id);
    if v_price is null then raise exception 'Harga belum diatur: % di %', v_l.sku, v_channel.name using errcode = 'P0001'; end if;
    insert into _sl values (v_l.variant_id, v_l.qty, v_price, v_l.sku, v_l.nm);
    v_subtotal := v_subtotal + round(v_l.qty * v_price, 2);
  end loop;

  v_discount := least(greatest(coalesce(app.num(p, 'diskon', 0), 0), 0), v_subtotal);
  v_base := v_subtotal - v_discount;
  v_maxpct := coalesce(nullif(app.setting(v_outlet.id, 'diskon_maks_persen', '10'), '')::numeric, 100);
  if v_discount > v_subtotal * v_maxpct / 100 + 0.5 and not app.has_role(v_outlet.id, array['owner','admin','supervisor']) then
    raise exception 'Diskon Rp% melebihi batas % persen dari subtotal. Perlu supervisor/owner.', v_discount, v_maxpct using errcode = 'P0001';
  end if;

  v_rate := coalesce(nullif(app.setting(v_outlet.id, 'ppn_persen', '0'), '')::numeric, 0);
  v_total := v_base;
  if app.setting_bool(v_outlet.id, 'ppn_aktif', false) and v_rate > 0 then
    if app.setting_bool(v_outlet.id, 'ppn_inklusif', false) then v_tax := round(v_base * v_rate / (100 + v_rate));
    else v_tax := round(v_base * v_rate / 100); v_total := v_base + v_tax; end if;
  else v_rate := 0; end if;

  if v_ctotal is not null and abs(v_ctotal - v_total) > 0.5 and app.setting_bool(v_outlet.id, 'tolak_selisih_total', true) then
    raise exception 'Total struk Rp% berbeda dari server Rp% (harga atau pengaturan berubah). Muat ulang data lalu ulangi.', v_ctotal, v_total
      using errcode = 'P0001', hint = 'TOTAL_MISMATCH';
  end if;

  v_fee := round(case v_channel.fee_basis when 'subtotal' then v_subtotal when 'omzet' then v_total - v_tax else v_total end
                 * v_channel.fee_percent / 100) + v_channel.fee_fixed;

  if v_method = 'tunai' then
    v_recv := coalesce(app.num(p, 'amount_received'), v_total);
    if v_recv < v_total then raise exception 'Uang diterima (Rp%) kurang dari total (Rp%).', v_recv, v_total using errcode = 'P0001'; end if;
    v_change := v_recv - v_total;
  else v_recv := v_total; end if;

  v_session := app.ensure_session(v_outlet.id, v_cashier);

  -- 2) Stok berkurang + ledger (menolak stok minus bila dilarang).
  for v_l in select * from _sl order by variant_id loop
    v_new := app.stock_apply(v_outlet.id, 'variant', v_l.variant_id, -v_l.qty, 'sale', 'sale', v_sale,
                             null, not v_noneg, null);
    v_stock := v_stock || jsonb_build_object(v_l.variant_id::text, v_new);
  end loop;

  -- 3) Nomor struk: kode outlet + tanggal lokal outlet + urutan.
  v_local := v_sold at time zone v_outlet.timezone;
  v_seq := app.next_seq(v_outlet.id, 'sale', v_local::date);
  v_no := v_outlet.code || '-' || to_char(v_local, 'YYMMDD') || '-' || lpad(v_seq::text, 3, '0');

  insert into public.sales (id, outlet_id, receipt_no, request_id, kind, channel_id, cashier_id, cash_session_id, status,
                            subtotal, discount, fee_channel, tax_rate, tax_amount, total, payment_method,
                            client_total, client_ts, sold_at, note, approved_by)
  values (v_sale, v_outlet.id, v_no, v_req, 'sale', v_channel.id, v_cashier, v_session, 'completed',
          v_subtotal, v_discount, v_fee, v_rate, v_tax, v_total, v_method, v_ctotal, v_cts, v_sold, v_note,
          case when v_cashier <> v_uid then v_uid end);

  insert into public.sale_items (sale_id, outlet_id, variant_id, sku_snapshot, name_snapshot, qty, unit_price, hpp_snapshot)
  select v_sale, v_outlet.id, s.variant_id, s.sku, s.nm, s.qty, s.price, nullif(b.avg_cost, 0)
  from _sl s join public.inventory_balances b on b.outlet_id = v_outlet.id and b.variant_id = s.variant_id;

  insert into public.payments (sale_id, outlet_id, cash_session_id, method, amount, received, change_given)
  values (v_sale, v_outlet.id, v_session, v_method, v_total, v_recv, v_change);

  perform app.audit(v_outlet.id, 'sale', 'sales', v_sale::text, null,
                    jsonb_build_object('nomor', v_no, 'total', v_total, 'metode', v_method, 'kasir', v_cashier));

  v_res := jsonb_build_object(
    'sale', jsonb_build_object('id', v_sale, 'nomor', v_no, 'outlet_id', v_outlet.id,
                               'tanggal', to_char(v_local, 'YYYY-MM-DD HH24:MI:SS'),
                               'subtotal', v_subtotal, 'diskon', v_discount, 'ppn_nominal', v_tax, 'total', v_total),
    'stok', v_stock, 'diterima', v_recv, 'kembalian', v_change, 'sesi', v_session);
  return app.idem_finish('sale', v_req, v_res);
end $$;

-- Beberapa transaksi antrean sekaligus. Tiap transaksi punya savepoint sendiri: satu gagal tidak membatalkan yang lain.
create function app.sale_batch(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_out jsonb := '[]'::jsonb; v_x jsonb; v_r jsonb;
begin
  if jsonb_typeof(p -> 'sales') <> 'array' then raise exception 'Daftar transaksi tidak valid.' using errcode = '22023'; end if;
  if jsonb_array_length(p -> 'sales') > 15 then raise exception 'Maksimal 15 transaksi per permintaan.' using errcode = '22023'; end if;
  for v_x in select * from jsonb_array_elements(p -> 'sales') loop
    begin
      v_r := jsonb_build_object('ok', true, 'data', app.sale_create(v_x));
    exception
      when sqlstate '40001' or sqlstate '40P01' or sqlstate '55P03' then
        v_r := jsonb_build_object('ok', false, 'error', 'Server sibuk. Akan dicoba lagi otomatis.', 'retry', true);
      when sqlstate '28000' then raise;                     -- sesi berakhir: hentikan seluruh batch
      when others then
        v_r := jsonb_build_object('ok', false, 'error', sqlerrm, 'retry', false, 'code', sqlstate);
    end;
    v_out := v_out || jsonb_build_array(v_r);
  end loop;
  return v_out;
end $$;

-- Retur/pembatalan: transaksi BARU bernilai negatif yang menunjuk transaksi asal (tidak mengubah yang lama).
create function app.sale_return(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_req text := p ->> 'request_id'; v_dup jsonb;
  v_o public.sales; v_outlet public.outlets;
  v_alasan text := trim(coalesce(p ->> 'alasan', ''));
  v_l record; v_want numeric; v_sale uuid := gen_random_uuid(); v_no text; v_seq int; v_local timestamp;
  v_all boolean := coalesce((p ->> 'semua')::boolean, false); v_restock boolean := coalesce((p ->> 'restock')::boolean, true);
  v_bruto numeric := 0; v_f numeric; v_subR numeric; v_disR numeric; v_taxR numeric; v_feeR numeric; v_totR numeric;
  v_excl boolean; v_final boolean := true; v_pr record; v_stock jsonb := '{}'::jsonb; v_new numeric;
  v_method text; v_session uuid; v_res jsonb; v_n int := 0;
begin
  if v_uid is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  select * into v_o from public.sales where id = nullif(p ->> 'id', '')::uuid for update;   -- serialisasi retur pada transaksi yang sama
  if not found then raise exception 'Penjualan asal tidak ditemukan.' using errcode = 'P0002'; end if;
  perform app.require_role(v_o.outlet_id, array['owner','admin','supervisor','kasir']);
  if not app.has_role(v_o.outlet_id, array['owner','admin','supervisor'])
     and not app.setting_bool(v_o.outlet_id, 'retur_kasir', false) then
    raise exception 'Retur memerlukan supervisor/owner.' using errcode = '42501';
  end if;
  v_outlet := app.active_outlet(v_o.outlet_id, 'store');
  v_dup := app.idem_begin('sale_return', v_req, p);
  if v_dup is not null then return v_dup; end if;
  if length(v_alasan) < 3 then raise exception 'Alasan retur wajib diisi.' using errcode = '22023'; end if;
  if v_o.kind <> 'sale' or v_o.status <> 'completed' then raise exception 'Hanya transaksi penjualan selesai yang bisa diretur.' using errcode = 'P0001'; end if;

  create temp table if not exists _rl (variant_id uuid, remaining numeric, price numeric, hpp numeric, sku text, nm text, want numeric) on commit drop;
  truncate _rl;
  insert into _rl (variant_id, remaining, price, hpp, sku, nm)
  select i.variant_id, sum(i.qty), max(i.unit_price) filter (where i.qty > 0), max(i.hpp_snapshot) filter (where i.qty > 0),
         max(i.sku_snapshot), max(i.name_snapshot)
  from public.sale_items i join public.sales s on s.id = i.sale_id
  where s.id = v_o.id or (s.ref_sale_id = v_o.id and s.status = 'completed')
  group by i.variant_id;

  if v_all then
    update _rl set want = remaining where remaining > 0;
  else
    if jsonb_typeof(p -> 'items') <> 'array' then raise exception 'Pilih minimal satu item yang diretur.' using errcode = '22023'; end if;
    update _rl r set want = x.q from (
      select (e ->> 'variant_id')::uuid as vid, sum((e ->> 'qty')::numeric) as q
      from jsonb_array_elements(p -> 'items') e where (e ->> 'qty')::numeric > 0 group by 1) x
    where r.variant_id = x.vid;
    if exists (select 1 from jsonb_array_elements(p -> 'items') e
               where (e ->> 'variant_id')::uuid not in (select variant_id from _rl)) then
      raise exception 'Item tidak ada di transaksi asal.' using errcode = 'P0001';
    end if;
  end if;
  if not exists (select 1 from _rl where want > 0) then raise exception 'Pilih minimal satu item yang diretur.' using errcode = '22023'; end if;
  if exists (select 1 from _rl where want > remaining + 0.0001) then
    raise exception 'Jumlah retur melebihi sisa yang bisa diretur.' using errcode = 'P0001';
  end if;

  select coalesce(sum(price * want), 0) into v_bruto from _rl where want > 0;
  v_excl := v_o.tax_amount > 0 and abs(v_o.total - (v_o.subtotal - v_o.discount)) > 0.5;
  v_final := not exists (select 1 from _rl where abs(remaining - coalesce(want, 0)) > 0.0001);
  if v_final then -- sisa terakhir: ambil sisa nilai agar seluruh retur persis menghapus transaksi asal
    select v_o.subtotal - coalesce(sum(-subtotal), 0), v_o.discount - coalesce(sum(-discount), 0),
           v_o.tax_amount - coalesce(sum(-tax_amount), 0), v_o.total - coalesce(sum(-total), 0), v_o.fee_channel - coalesce(sum(-fee_channel), 0)
      into v_subR, v_disR, v_taxR, v_totR, v_feeR
      from public.sales where ref_sale_id = v_o.id and status = 'completed';
  else
    v_f := case when v_o.subtotal > 0 then v_bruto / v_o.subtotal else 0 end;
    v_subR := round(v_bruto); v_disR := round(v_o.discount * v_f); v_taxR := round(v_o.tax_amount * v_f);
    v_feeR := round(v_o.fee_channel * v_f); v_totR := (v_subR - v_disR) + case when v_excl then v_taxR else 0 end;
  end if;

  v_method := case when lower(coalesce(p ->> 'refund_method', '')) in ('tunai','transfer','qris','lain')
                   then lower(p ->> 'refund_method') else v_o.payment_method end;
  v_session := app.ensure_session(v_o.outlet_id, v_uid);
  v_local := now() at time zone v_outlet.timezone;
  v_seq := app.next_seq(v_o.outlet_id, 'return', v_local::date);
  v_no := 'RT-' || v_outlet.code || '-' || to_char(v_local, 'YYMMDD') || '-' || lpad(v_seq::text, 3, '0');

  insert into public.sales (id, outlet_id, receipt_no, request_id, kind, ref_sale_id, channel_id, cashier_id, cash_session_id,
                            status, subtotal, discount, fee_channel, tax_rate, tax_amount, total, payment_method, note, reason, approved_by)
  values (v_sale, v_o.outlet_id, v_no, v_req, 'return', v_o.id, v_o.channel_id, v_uid, v_session, 'completed',
          -v_subR, -v_disR, -v_feeR, v_o.tax_rate, -v_taxR, -v_totR, v_method,
          left('RETUR ' || v_o.receipt_no || ': ' || v_alasan, 300), v_alasan, v_uid);

  for v_l in select * from _rl where want > 0 order by variant_id loop
    insert into public.sale_items (sale_id, outlet_id, variant_id, sku_snapshot, name_snapshot, qty, unit_price, hpp_snapshot)
    values (v_sale, v_o.outlet_id, v_l.variant_id, v_l.sku, v_l.nm, -v_l.want, v_l.price, v_l.hpp);
    if v_restock then
      v_new := app.stock_apply(v_o.outlet_id, 'variant', v_l.variant_id, v_l.want, 'return_in', 'sale', v_sale, v_l.hpp, true, null);
      v_stock := v_stock || jsonb_build_object(v_l.variant_id::text, v_new);
    end if;
  end loop;

  insert into public.payments (sale_id, outlet_id, cash_session_id, method, amount)
  values (v_sale, v_o.outlet_id, v_session, v_method, -v_totR);

  perform app.audit(v_o.outlet_id, 'return', 'sales', v_sale::text, jsonb_build_object('nomor', v_o.receipt_no),
                    jsonb_build_object('nomor', v_no, 'total', -v_totR, 'alasan', v_alasan, 'restock', v_restock));

  v_res := jsonb_build_object('sale', jsonb_build_object('id', v_sale, 'nomor', v_no, 'subtotal', -v_subR, 'diskon', -v_disR,
                                'ppn_nominal', -v_taxR, 'total', -v_totR),
                              'refund', v_totR, 'metode', v_method, 'stok', v_stock, 'restock', v_restock);
  return app.idem_finish('sale_return', v_req, v_res);
end $$;

-- ---------- Sesi kasir ----------
create function app.cash_open(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_o public.outlets; v_open numeric := coalesce(app.num(p, 'modal_awal', 0), 0); v_id uuid;
begin
  if v_uid is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  v_o := app.active_outlet(nullif(p ->> 'outlet_id', '')::uuid, 'store');
  perform app.require_role(v_o.id, array['owner','admin','supervisor','kasir']);
  if v_open < 0 then raise exception 'Modal awal tidak boleh negatif.' using errcode = '22023'; end if;
  begin
    insert into public.cash_sessions (outlet_id, cashier_id, opening_cash) values (v_o.id, v_uid, v_open) returning id into v_id;
  exception when unique_violation then
    raise exception 'Anda sudah memiliki sesi kasir yang aktif. Tutup kasir lebih dulu.' using errcode = 'P0001';
  end;
  perform app.audit(v_o.id, 'cash_open', 'cash_sessions', v_id::text, null, jsonb_build_object('modal_awal', v_open));
  return jsonb_build_object('id', v_id, 'outlet_id', v_o.id, 'modal_awal', v_open);
end $$;

-- Ringkasan "buta": nominal tidak ditampilkan sebelum kasir mengisi uang laci (seperti v2.0.0).
create function app.cash_summary(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v public.cash_sessions; v_n int;
begin
  if (select auth.uid()) is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  select * into v from public.cash_sessions where cashier_id = (select auth.uid()) and status = 'open';
  if not found then
    return jsonb_build_object('sesi', null, 'dari', null, 'jumlah_trx', 0, 'modal_terakhir', 0);
  end if;
  select count(*) into v_n from public.sales where cash_session_id = v.id and kind = 'sale' and status = 'completed';
  return jsonb_build_object('sesi', v.id, 'outlet_id', v.outlet_id, 'dari', to_char(v.opened_at at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS'),
    'sampai', to_char(now() at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS'), 'jumlah_trx', v_n,
    'modal_terakhir', v.opening_cash, 'auto_opened', v.auto_opened);
end $$;

create function app.cash_movement_add(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v public.cash_sessions; v_id uuid; v_amt numeric := app.num(p, 'nominal');
        v_kind text := coalesce(p ->> 'jenis', 'out');
begin
  if v_uid is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  select * into v from public.cash_sessions where cashier_id = v_uid and status = 'open' for update;
  if not found then raise exception 'Tidak ada sesi kasir aktif.' using errcode = 'P0001'; end if;
  perform app.require_role(v.outlet_id, array['owner','admin','supervisor','kasir']);
  if v_kind not in ('in','out') or v_amt is null or v_amt <= 0 then raise exception 'Nominal atau jenis kas tidak valid.' using errcode = '22023'; end if;
  if length(trim(coalesce(p ->> 'alasan', ''))) < 3 then raise exception 'Alasan wajib diisi.' using errcode = '22023'; end if;
  insert into public.cash_movements (outlet_id, cash_session_id, kind, amount, reason, user_id)
  values (v.outlet_id, v.id, v_kind, v_amt, trim(p ->> 'alasan'), v_uid) returning id into v_id;
  perform app.audit(v.outlet_id, 'cash_' || v_kind, 'cash_movements', v_id::text, null, jsonb_build_object('nominal', v_amt, 'alasan', p ->> 'alasan'));
  return jsonb_build_object('id', v_id);
end $$;

create function app.cash_close(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid()); v public.cash_sessions;
  v_fisik numeric := app.num(p, 'uang_fisik'); v_extra numeric := coalesce(app.num(p, 'kas_keluar', 0), 0);
  v_modal numeric; v_in numeric; v_out numeric; v_tunai numeric; v_tf numeric; v_qr numeric; v_lain numeric; v_total numeric; v_retur numeric;
  v_n int; v_exp numeric; v_diff numeric; v_note text := trim(coalesce(p ->> 'catatan', '')); v_amb numeric;
begin
  if v_uid is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  if v_fisik is null or v_fisik < 0 then raise exception 'Isi jumlah uang tunai di laci (0 atau lebih).' using errcode = '22023'; end if;
  if v_extra < 0 then raise exception 'Kas keluar tidak boleh negatif.' using errcode = '22023'; end if;
  select * into v from public.cash_sessions where cashier_id = v_uid and status = 'open' for update;  -- menunggu penjualan yang sedang berjalan
  if not found then raise exception 'Tidak ada sesi kasir aktif untuk ditutup.' using errcode = 'P0001'; end if;
  perform app.require_role(v.outlet_id, array['owner','admin','supervisor','kasir']);

  v_modal := case when v.auto_opened then coalesce(app.num(p, 'modal_awal', 0), 0) else v.opening_cash end;
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

-- Persetujuan selisih oleh supervisor/owner (sesi sudah ditutup; angka final tidak diubah).
create function app.cash_approve(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.cash_sessions;
begin
  select * into v from public.cash_sessions where id = nullif(p ->> 'id', '')::uuid for update;
  if not found or v.status <> 'closed' then raise exception 'Sesi kasir tidak ditemukan atau belum ditutup.' using errcode = 'P0002'; end if;
  perform app.require_role(v.outlet_id, array['owner','admin','supervisor']);
  update public.cash_sessions set approved_by = (select auth.uid()), approved_at = now() where id = v.id;
  perform app.audit(v.outlet_id, 'cash_approve', 'cash_sessions', v.id::text, null, jsonb_build_object('selisih', v.difference));
  return jsonb_build_object('id', v.id, 'approved', true);
end $$;

-- ---------- Pengeluaran ----------
create function app.expense_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_outlet uuid := nullif(p ->> 'outlet_id', '')::uuid; v_amt numeric := app.num(p, 'nominal');
        v_id uuid; v_dup jsonb; v_sess uuid; v_date date := coalesce(nullif(p ->> 'tanggal', '')::date, current_date);
begin
  if v_uid is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  if v_outlet is null then perform app.require_role(null, array['owner','admin']);          -- biaya pusat
  else perform app.require_role(v_outlet, array['owner','admin','supervisor']); end if;
  v_dup := app.idem_begin('expense', p ->> 'request_id', p);
  if v_dup is not null then return v_dup; end if;
  if v_amt is null or v_amt <= 0 then raise exception 'Nominal biaya tidak valid.' using errcode = '22023'; end if;
  if length(trim(coalesce(p ->> 'kategori', ''))) < 2 then raise exception 'Kategori biaya wajib diisi.' using errcode = '22023'; end if;
  if coalesce((p ->> 'dari_laci')::boolean, false) then      -- biaya tunai dari laci: tercatat sebagai kas keluar sesi (tanpa hitung ganda di laporan biaya)
    if v_outlet is null then raise exception 'Biaya dari laci harus terkait outlet.' using errcode = '22023'; end if;
    select id into v_sess from public.cash_sessions where cashier_id = v_uid and status = 'open' and outlet_id = v_outlet for update;
    if v_sess is null then raise exception 'Tidak ada sesi kasir aktif di outlet ini.' using errcode = 'P0001'; end if;
    insert into public.cash_movements (outlet_id, cash_session_id, kind, amount, reason, user_id)
    values (v_outlet, v_sess, 'out', v_amt, 'Biaya: ' || trim(p ->> 'kategori'), v_uid);
  end if;
  insert into public.expenses (outlet_id, category, amount, expense_date, note, user_id, cash_session_id, request_id)
  values (v_outlet, trim(p ->> 'kategori'), v_amt, v_date, nullif(trim(p ->> 'catatan'), ''), v_uid, v_sess, p ->> 'request_id')
  returning id into v_id;
  perform app.audit(v_outlet, 'expense', 'expenses', v_id::text, null, jsonb_build_object('nominal', v_amt, 'kategori', p ->> 'kategori'));
  return app.idem_finish('expense', p ->> 'request_id', jsonb_build_object('id', v_id));
end $$;
