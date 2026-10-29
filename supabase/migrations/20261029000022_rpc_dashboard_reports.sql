-- 0011 Fungsi baca yang dipanggil UI: Beranda (dashboard), 8 jenis laporan (report_legacy), daftar produksi, simpan resep.
-- Kontrak keluaran mengikuti web/js/modules.js (laporan memakai INDEKS KOLOM: penjualan/hpp kolom 5 = HPP; penjualan kolom 2 = qty).
-- Semua agregasi memakai zona waktu OUTLET (bukan UTC dan bukan zona perangkat). Kolom biaya/HPP hanya untuk owner/admin/auditor.

-- Fakta penjualan per outlet dan rentang tanggal lokal outlet. Privat: tidak diberikan ke klien (dipanggil dari fungsi lain milik owner fungsi).
create function app.sales_facts(p_outlet uuid, p_from date, p_to date)
returns table (sale_id uuid, kind text, channel_id uuid, d date, om numeric, fee numeric, hpp numeric, hpp_missing integer)
language sql stable security definer set search_path = '' as $$
  select s.id, s.kind, s.channel_id, (s.sold_at at time zone o.timezone)::date, s.total - s.tax_amount, s.fee_channel,
         coalesce(h.hpp, 0), coalesce(h.miss, 0)
  from public.sales s
  join public.outlets o on o.id = s.outlet_id
  left join lateral (
    select sum(i.qty * i.hpp_snapshot) as hpp, (count(*) filter (where i.hpp_snapshot is null))::integer as miss
    from public.sale_items i where i.sale_id = s.id) h on true
  where s.outlet_id = p_outlet and s.status = 'completed'
    and s.sold_at >= (p_from::timestamp at time zone o.timezone)
    and s.sold_at <  ((p_to + 1)::timestamp at time zone o.timezone);
$$;
revoke all on function app.sales_facts(uuid, date, date) from public, anon, authenticated;

-- ---------- Beranda ----------
create function app.dashboard(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_o public.outlets; v_per text := coalesce(nullif(p ->> 'period', ''), 'hari');
  v_today date; v_from date; v_to date; v_pfrom date; v_pto date; v_sfrom date;
  v_cur jsonb; v_prev jsonb; v_series jsonb; v_ch jsonb; v_top jsonb; v_low jsonb; v_neg jsonb;
  v_fee numeric; v_biaya numeric; v_laba numeric;
begin
  select * into v_o from public.outlets where id = nullif(p ->> 'outlet_id', '')::uuid;
  if not found then raise exception 'Outlet tidak ditemukan.' using errcode = 'P0002'; end if;
  perform app.require_role(v_o.id, array['owner','admin','auditor']);
  if v_per not in ('hari','minggu','bulan') then raise exception 'Periode tidak valid.' using errcode = '22023'; end if;

  v_today := (now() at time zone v_o.timezone)::date;
  if v_per = 'hari' then
    v_from := v_today; v_to := v_today; v_pto := v_today - 1; v_pfrom := v_pto;
  elsif v_per = 'minggu' then
    v_from := v_today - 6; v_to := v_today; v_pto := v_from - 1; v_pfrom := v_pto - 6;
  else
    v_from := date_trunc('month', v_today)::date; v_to := v_today;
    v_pfrom := (v_from - interval '1 month')::date;
    v_pto := least(v_pfrom + (v_to - v_from), v_from - 1);
  end if;
  v_sfrom := least(v_from, v_to - 6);      -- grafik minimal 7 hari agar "Hari ini" tetap punya konteks

  select jsonb_build_object('omzet', coalesce(sum(f.om), 0), 'trx', count(*) filter (where f.kind = 'sale'), 'laba', coalesce(sum(f.om - f.hpp), 0)),
         coalesce(sum(f.fee), 0)
    into v_cur, v_fee from app.sales_facts(v_o.id, v_from, v_to) f;
  select jsonb_build_object('omzet', coalesce(sum(f.om), 0), 'trx', count(*) filter (where f.kind = 'sale'), 'laba', coalesce(sum(f.om - f.hpp), 0))
    into v_prev from app.sales_facts(v_o.id, v_pfrom, v_pto) f;

  select coalesce(jsonb_agg(jsonb_build_object('d', to_char(v_sfrom + g.n, 'YYYY-MM-DD'), 'omzet', coalesce(x.om, 0), 'laba', coalesce(x.om - x.hpp, 0)) order by g.n), '[]'::jsonb)
    into v_series
    from generate_series(0, v_to - v_sfrom) as g(n)
    left join (select f.d, sum(f.om) as om, sum(f.hpp) as hpp from app.sales_facts(v_o.id, v_sfrom, v_to) f group by f.d) x on x.d = v_sfrom + g.n;

  select coalesce(jsonb_agg(jsonb_build_object('nama', c.name, 'omzet', t.om) order by t.om desc), '[]'::jsonb) into v_ch
    from (select f.channel_id, sum(f.om) as om from app.sales_facts(v_o.id, v_from, v_to) f group by f.channel_id having sum(f.om) <> 0) t
    join public.channels c on c.id = t.channel_id;

  select coalesce(jsonb_agg(jsonb_build_object('nama', q.nm, 'qty', q.qty) order by q.qty desc), '[]'::jsonb) into v_top from (
    select max(i.name_snapshot) as nm, sum(i.qty) as qty
    from public.sale_items i join public.sales s on s.id = i.sale_id
    where s.outlet_id = v_o.id and s.status = 'completed'
      and s.sold_at >= (v_from::timestamp at time zone v_o.timezone) and s.sold_at < ((v_to + 1)::timestamp at time zone v_o.timezone)
    group by i.variant_id having sum(i.qty) > 0 order by 2 desc limit 5) q;

  select coalesce(jsonb_agg(jsonb_build_object('nama', q.name, 'stok', q.qty, 'satuan', q.unit) order by q.qty - q.min_stock), '[]'::jsonb) into v_low from (
    select m.name, coalesce(b.quantity, 0) as qty, m.unit, m.min_stock
    from public.materials m left join public.inventory_material_balances b on b.outlet_id = v_o.id and b.material_id = m.id
    where m.active and m.min_stock > 0 and coalesce(b.quantity, 0) <= m.min_stock
    order by coalesce(b.quantity, 0) - m.min_stock limit 10) q;

  select coalesce(jsonb_agg(jsonb_build_object('nama', q.nm, 'stok', q.qty)), '[]'::jsonb) into v_neg from (
    select trim(coalesce(pr.name, '?') || ' ' || v.sku) as nm, b.quantity as qty
      from public.inventory_balances b join public.product_variants v on v.id = b.variant_id left join public.products pr on pr.id = v.product_id
      where b.outlet_id = v_o.id and b.quantity < 0
    union all
    select m.name, b.quantity from public.inventory_material_balances b join public.materials m on m.id = b.material_id
      where b.outlet_id = v_o.id and b.quantity < 0
    order by 2 limit 20) q;

  select coalesce(sum(e.amount), 0) into v_biaya from public.expenses e
    where e.outlet_id = v_o.id and e.expense_date between v_from and v_to;
  v_laba := (v_cur ->> 'laba')::numeric - v_fee - v_biaya;

  return jsonb_build_object('period', v_per, 'outlet_id', v_o.id, 'from', v_from, 'to', v_to, 'pfrom', v_pfrom, 'pto', v_pto,
    'cur', v_cur, 'prev', v_prev, 'series', v_series, 'channels', v_ch, 'top', v_top, 'low', v_low, 'stok_minus', v_neg,
    'peringatan', '[]'::jsonb, 'biaya', v_biaya, 'fee_channel', v_fee, 'laba_bersih', v_laba);
end $$;

-- ---------- Laporan (8 jenis) ----------
create function app.report_legacy(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_o public.outlets; v_type text := coalesce(p ->> 'type', 'labarugi'); v_role text; v_cost boolean;
  v_today date; v_from date; v_to date; v_title text; v_cols jsonb; v_fmt jsonb; v_rows jsonb := '[]'::jsonb; v_sum jsonb := '[]'::jsonb;
  v_om numeric; v_hpp numeric; v_fee numeric; v_exp numeric; v_miss bigint; v_warn text := null; v_n numeric; v_t numeric;
begin
  select * into v_o from public.outlets where id = nullif(p ->> 'outlet_id', '')::uuid;
  if not found then raise exception 'Outlet tidak ditemukan.' using errcode = 'P0002'; end if;
  v_role := app.role_at(v_o.id);
  if v_role is null then raise exception 'Akses ditolak untuk outlet ini.' using errcode = '42501'; end if;
  if v_type not in ('labarugi','penjualan','channel','hpp','stok','produksi','pembelian','pengeluaran') then
    raise exception 'Jenis laporan tidak dikenal: %', v_type using errcode = '22023'; end if;
  -- Matriks akses per jenis (sejalan dengan require_role di report_sales/report_pnl/report_stock_value).
  if (v_type in ('labarugi','hpp') and v_role not in ('owner','admin','auditor'))
     or (v_type in ('penjualan','channel') and v_role not in ('owner','admin','supervisor','auditor'))
     or (v_type = 'stok' and v_role not in ('owner','admin','supervisor','stok','produksi','auditor'))
     or (v_type = 'produksi' and v_role not in ('owner','admin','supervisor','produksi','stok','auditor'))
     or (v_type = 'pembelian' and v_role not in ('owner','admin','supervisor','stok','auditor'))
     or (v_type = 'pengeluaran' and v_role not in ('owner','admin','supervisor','auditor')) then
    raise exception 'Peran Anda tidak boleh membuka laporan ini.' using errcode = '42501'; end if;
  v_cost := v_role in ('owner','admin','auditor');

  v_today := (now() at time zone v_o.timezone)::date;
  v_from := coalesce(nullif(p ->> 'from', '')::date, v_today); v_to := coalesce(nullif(p ->> 'to', '')::date, v_today);
  if v_to < v_from or v_to - v_from > 400 then raise exception 'Rentang tanggal tidak valid (maksimal 400 hari).' using errcode = '22023'; end if;

  if v_type = 'labarugi' then
    v_title := 'Laba rugi'; v_cols := '["Komponen","Nilai"]'; v_fmt := '["txt","rp"]';
    select coalesce(sum(f.om), 0), coalesce(sum(f.hpp), 0), coalesce(sum(f.fee), 0), coalesce(sum(f.hpp_missing), 0)
      into v_om, v_hpp, v_fee, v_miss from app.sales_facts(v_o.id, v_from, v_to) f;
    select coalesce(sum(e.amount), 0) into v_exp from public.expenses e where e.outlet_id = v_o.id and e.expense_date between v_from and v_to;
    v_rows := jsonb_build_array(jsonb_build_array('Omzet (tanpa PPN, setelah retur)', v_om), jsonb_build_array('HPP', v_hpp),
      jsonb_build_array('Laba kotor', v_om - v_hpp), jsonb_build_array('Fee channel', v_fee));
    v_rows := v_rows || coalesce((select jsonb_agg(jsonb_build_array('Biaya: ' || q.category, q.t) order by q.t desc)
      from (select e.category, sum(e.amount) as t from public.expenses e where e.outlet_id = v_o.id and e.expense_date between v_from and v_to group by e.category) q), '[]'::jsonb);
    v_rows := v_rows || jsonb_build_array(jsonb_build_array('Laba bersih', v_om - v_hpp - v_fee - v_exp));
    v_sum := jsonb_build_array(jsonb_build_object('label', 'Omzet', 'value', v_om, 'fmt', 'rp'), jsonb_build_object('label', 'Laba kotor', 'value', v_om - v_hpp, 'fmt', 'rp'),
      jsonb_build_object('label', 'Laba bersih', 'value', v_om - v_hpp - v_fee - v_exp, 'fmt', 'rp'),
      jsonb_build_object('label', 'Margin kotor', 'value', case when v_om > 0 then round((v_om - v_hpp) / v_om * 100, 1) else 0 end, 'fmt', 'pct'));
    if v_miss > 0 then v_warn := v_miss || ' baris penjualan belum punya HPP; laba kotor bisa terlalu tinggi.'; end if;

  elsif v_type = 'penjualan' then
    v_title := 'Penjualan per produk'; v_cols := '["Produk","Varian","Terjual","Omzet","Harga rata-rata","HPP","Laba kotor","Margin"]'; v_fmt := '["txt","txt","num","rp","rp","rp","rp","pct"]';
    select coalesce(jsonb_agg(jsonb_build_array(q.produk, q.varian, q.qty, q.omzet, case when q.qty <> 0 then round(q.omzet / q.qty, 2) else 0 end,
             case when v_cost then q.hpp else null end, case when v_cost then q.omzet - q.hpp else null end,
             case when v_cost and q.omzet > 0 then round((q.omzet - q.hpp) / q.omzet * 100, 1) else null end) order by q.omzet desc), '[]'::jsonb)
      into v_rows from (
        select coalesce(pr.name, max(i.name_snapshot)) as produk, trim(concat_ws(' · ', v.size, v.spice_level)) as varian,
               sum(i.qty) as qty, coalesce(sum(i.line_total), 0) as omzet, coalesce(sum(i.qty * i.hpp_snapshot), 0) as hpp
        from public.sale_items i join public.sales s on s.id = i.sale_id
        join public.product_variants v on v.id = i.variant_id left join public.products pr on pr.id = v.product_id
        where s.outlet_id = v_o.id and s.status = 'completed'
          and s.sold_at >= (v_from::timestamp at time zone v_o.timezone) and s.sold_at < ((v_to + 1)::timestamp at time zone v_o.timezone)
        group by i.variant_id, pr.name, v.size, v.spice_level) q;
    select coalesce(sum(f.om), 0), count(*) filter (where f.kind = 'sale') into v_om, v_n from app.sales_facts(v_o.id, v_from, v_to) f;
    v_sum := jsonb_build_array(jsonb_build_object('label', 'Omzet', 'value', v_om, 'fmt', 'rp'), jsonb_build_object('label', 'Transaksi', 'value', v_n, 'fmt', 'num'));

  elsif v_type = 'channel' then
    v_title := 'Penjualan per channel'; v_cols := '["Channel","Transaksi","Omzet","Fee channel","Laba kotor","Setelah fee"]'; v_fmt := '["txt","num","rp","rp","rp","rp"]';
    select coalesce(jsonb_agg(jsonb_build_array(q.nama, q.trx, q.om, q.fee, case when v_cost then q.om - q.hpp else null end, case when v_cost then q.om - q.hpp - q.fee else null end) order by q.om desc), '[]'::jsonb)
      into v_rows from (
        select c.name as nama, count(*) filter (where f.kind = 'sale') as trx, sum(f.om) as om, sum(f.fee) as fee, sum(f.hpp) as hpp
        from app.sales_facts(v_o.id, v_from, v_to) f join public.channels c on c.id = f.channel_id group by c.name) q;
    select coalesce(sum(f.om), 0), coalesce(sum(f.fee), 0) into v_om, v_fee from app.sales_facts(v_o.id, v_from, v_to) f;
    v_sum := jsonb_build_array(jsonb_build_object('label', 'Omzet', 'value', v_om, 'fmt', 'rp'), jsonb_build_object('label', 'Total fee channel', 'value', v_fee, 'fmt', 'rp'));

  elsif v_type = 'hpp' then
    v_title := 'HPP & margin'; v_cols := '["Produk","Varian","SKU","Stok","Harga jual terendah","HPP per unit","Laba per unit","Margin","Nilai stok"]'; v_fmt := '["txt","txt","txt","num","rp","rp","rp","pct","rp"]';
    select coalesce(jsonb_agg(jsonb_build_array(q.produk, q.varian, q.sku, q.stok, q.harga, q.hpp,
             case when q.harga is not null then q.harga - q.hpp else null end,
             case when q.harga > 0 then round((q.harga - q.hpp) / q.harga * 100, 1) else null end, round(q.stok * q.hpp, 2)) order by q.produk, q.sku), '[]'::jsonb)
      into v_rows from (
        select coalesce(pr.name, '?') as produk, trim(concat_ws(' · ', v.size, v.spice_level)) as varian, v.sku, coalesce(b.quantity, 0) as stok,
               (select min(app.price_of(v_o.id, v.id, c.id)) from public.channels c where c.active) as harga, coalesce(b.avg_cost, 0) as hpp
        from public.product_variants v join public.products pr on pr.id = v.product_id and pr.active
        left join public.inventory_balances b on b.outlet_id = v_o.id and b.variant_id = v.id where v.active) q;
    select count(*) into v_miss from public.product_variants v join public.products pr on pr.id = v.product_id and pr.active
      left join public.inventory_balances b on b.outlet_id = v_o.id and b.variant_id = v.id where v.active and coalesce(b.avg_cost, 0) <= 0;
    v_sum := jsonb_build_array(jsonb_build_object('label', 'Varian tanpa HPP', 'value', v_miss, 'fmt', 'num'));

  elsif v_type = 'stok' then
    v_title := 'Stok & nilai'; v_cols := '["Jenis","Item","Satuan","Stok","Minimum","HPP","Nilai"]'; v_fmt := '["txt","txt","txt","num","num","rp","rp"]';
    select coalesce(jsonb_agg(jsonb_build_array(q.jenis, q.nm, q.satuan, q.stok, q.mn, case when v_cost then q.hpp else null end, case when v_cost then round(q.stok * q.hpp, 2) else null end) order by q.jenis, q.nm), '[]'::jsonb)
      into v_rows from (
        select 'Produk jadi' as jenis, trim(coalesce(pr.name, '?') || ' ' || v.sku) as nm, 'pcs' as satuan, coalesce(b.quantity, 0) as stok, coalesce(b.min_qty, 0) as mn, coalesce(b.avg_cost, 0) as hpp
          from public.product_variants v join public.products pr on pr.id = v.product_id and pr.active
          left join public.inventory_balances b on b.outlet_id = v_o.id and b.variant_id = v.id where v.active
        union all
        select 'Bahan', m.name, m.unit, coalesce(b.quantity, 0), m.min_stock, coalesce(b.avg_cost, 0)
          from public.materials m left join public.inventory_material_balances b on b.outlet_id = v_o.id and b.material_id = m.id where m.active) q;
    if v_cost then
      select coalesce(sum(b.quantity * b.avg_cost), 0) into v_n from public.inventory_balances b where b.outlet_id = v_o.id;
      select coalesce(sum(b.quantity * b.avg_cost), 0) into v_t from public.inventory_material_balances b where b.outlet_id = v_o.id;
      v_sum := jsonb_build_array(jsonb_build_object('label', 'Nilai produk jadi', 'value', v_n, 'fmt', 'rp'), jsonb_build_object('label', 'Nilai bahan', 'value', v_t, 'fmt', 'rp'),
                                 jsonb_build_object('label', 'Total nilai stok', 'value', v_n + v_t, 'fmt', 'rp'));
    end if;

  elsif v_type = 'produksi' then
    v_title := 'Produksi'; v_cols := '["Tanggal","Produk","Jenis","Batch","Hasil","Susut","Total biaya","HPP per unit","Status"]'; v_fmt := '["txt","txt","txt","num","num","num","rp","rp","txt"]';
    select coalesce(jsonb_agg(jsonb_build_array(to_char(q.created_at at time zone v_o.timezone, 'YYYY-MM-DD'), q.produk, q.kind, q.batches, q.actual_qty,
             case when q.status = 'done' then q.standard_qty - q.actual_qty else null end, case when v_cost then q.total else null end, case when v_cost then q.unit_cost else null end,
             case q.status when 'done' then 'Selesai' when 'planned' then 'Rencana' else 'Batal' end) order by q.created_at desc), '[]'::jsonb)
      into v_rows from (
        select po.created_at, trim(coalesce(pr.name, '?') || ' ' || v.sku) as produk, po.kind, po.batches, po.actual_qty, po.standard_qty, po.status, pc.total, pc.unit_cost
        from public.production_orders po join public.product_variants v on v.id = po.variant_id left join public.products pr on pr.id = v.product_id
        left join public.production_costs pc on pc.production_id = po.id
        where (po.kitchen_outlet_id = v_o.id or po.output_outlet_id = v_o.id)
          and (po.created_at at time zone v_o.timezone)::date between v_from and v_to) q;
    select count(*) filter (where po.status = 'done'), coalesce(sum(po.actual_qty) filter (where po.status = 'done'), 0), coalesce(sum(pc.total), 0)
      into v_miss, v_n, v_t from public.production_orders po left join public.production_costs pc on pc.production_id = po.id
      where (po.kitchen_outlet_id = v_o.id or po.output_outlet_id = v_o.id) and (po.created_at at time zone v_o.timezone)::date between v_from and v_to;
    v_sum := jsonb_build_array(jsonb_build_object('label', 'Produksi selesai', 'value', v_miss, 'fmt', 'num'), jsonb_build_object('label', 'Total hasil', 'value', v_n, 'fmt', 'num'));
    if v_cost then v_sum := v_sum || jsonb_build_array(jsonb_build_object('label', 'Total biaya', 'value', v_t, 'fmt', 'rp')); end if;

  elsif v_type = 'pembelian' then
    v_title := 'Pembelian bahan'; v_cols := '["Tanggal","Supplier","Bahan","Jumlah","Harga","Biaya efektif","Subtotal"]'; v_fmt := '["txt","txt","txt","num","rp","rp","rp"]';
    select coalesce(jsonb_agg(jsonb_build_array(to_char(q.purchased_at at time zone v_o.timezone, 'YYYY-MM-DD'), coalesce(q.supplier, '-'), q.bahan, q.qty, q.unit_price, q.effective_cost, round(q.qty * q.effective_cost, 2)) order by q.purchased_at desc), '[]'::jsonb)
      into v_rows from (
        select pu.purchased_at, su.name as supplier, m.name as bahan, i.qty, i.unit_price, i.effective_cost
        from public.purchases pu join public.purchase_items i on i.purchase_id = pu.id join public.materials m on m.id = i.material_id left join public.suppliers su on su.id = pu.supplier_id
        where pu.outlet_id = v_o.id and pu.status = 'posted' and (pu.purchased_at at time zone v_o.timezone)::date between v_from and v_to) q;
    select count(*), coalesce(sum(pu.total), 0) into v_miss, v_n from public.purchases pu
      where pu.outlet_id = v_o.id and pu.status = 'posted' and (pu.purchased_at at time zone v_o.timezone)::date between v_from and v_to;
    v_sum := jsonb_build_array(jsonb_build_object('label', 'Jumlah pembelian', 'value', v_miss, 'fmt', 'num'), jsonb_build_object('label', 'Total pembelian', 'value', v_n, 'fmt', 'rp'));

  else  -- pengeluaran
    v_title := 'Biaya operasional'; v_cols := '["Tanggal","Kategori","Nominal","Catatan"]'; v_fmt := '["txt","txt","rp","txt"]';
    select coalesce(jsonb_agg(jsonb_build_array(to_char(e.expense_date, 'YYYY-MM-DD'), e.category, e.amount, coalesce(e.note, '')) order by e.expense_date desc, e.created_at desc), '[]'::jsonb)
      into v_rows from public.expenses e where e.outlet_id = v_o.id and e.expense_date between v_from and v_to;
    select coalesce(sum(e.amount), 0) into v_n from public.expenses e where e.outlet_id = v_o.id and e.expense_date between v_from and v_to;
    v_sum := jsonb_build_array(jsonb_build_object('label', 'Total biaya', 'value', v_n, 'fmt', 'rp'));
  end if;

  return jsonb_build_object('type', v_type, 'title', v_title, 'from', v_from, 'to', v_to, 'outlet_id', v_o.id,
    'columns', v_cols, 'fmt', v_fmt, 'rows', v_rows, 'summary', v_sum, 'peringatan', v_warn);
end $$;

-- ---------- Daftar produksi ----------
create function app.production_list(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_o public.outlets; v_cost boolean; v_rows jsonb;
begin
  select * into v_o from public.outlets where id = nullif(p ->> 'outlet_id', '')::uuid;
  if not found then raise exception 'Outlet tidak ditemukan.' using errcode = 'P0002'; end if;
  perform app.require_role(v_o.id, array['owner','admin','supervisor','produksi','stok','auditor']);
  v_cost := app.has_role(v_o.id, array['owner','admin','auditor']);
  select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'variant_id', q.variant_id, 'recipe_id', q.recipe_id, 'jenis', q.kind,
      'jumlah_batch', q.batches, 'tanggal', to_char(q.created_at at time zone v_o.timezone, 'YYYY-MM-DD HH24:MI:SS'),
      'status', case q.status when 'done' then 'selesai' when 'planned' then 'rencana' else 'batal' end,
      'qty_standar', q.standard_qty, 'qty_hasil', q.actual_qty, 'catatan', q.note,
      'bahan', case when v_cost then q.materials_cost end, 'kemasan', case when v_cost then q.packaging_cost end,
      'tenaga_kerja', case when v_cost then q.labor_cost end, 'overhead', case when v_cost then q.overhead_cost end,
      'total', case when v_cost then q.total end, 'hpp_per_unit', case when v_cost then q.unit_cost end) order by q.created_at desc), '[]'::jsonb)
    into v_rows from (
      select po.*, pc.materials_cost, pc.packaging_cost, pc.labor_cost, pc.overhead_cost, pc.total, pc.unit_cost
      from public.production_orders po left join public.production_costs pc on pc.production_id = po.id
      where po.kitchen_outlet_id = v_o.id or po.output_outlet_id = v_o.id order by po.created_at desc limit 200) q;
  return v_rows;
end $$;

-- ---------- Simpan resep (header + bahan, satu transaksi) ----------
create function app.recipe_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid; v_r public.recipes; v_e jsonb; v_yield numeric := app.num(p, 'hasil_standar');
  v_labor numeric := coalesce(app.num(p, 'tenaga_kerja', 0), 0); v_kind text := coalesce(nullif(p ->> 'jenis', ''), 'batch'); v_mat uuid; v_q numeric; v_items jsonb;
begin
  perform app.require_role(null, array['owner','admin']);
  if v_yield is null or v_yield <= 0 then raise exception 'Hasil standar harus lebih dari 0.' using errcode = '22023'; end if;
  if v_labor < 0 then raise exception 'Biaya tenaga kerja tidak boleh negatif.' using errcode = '22023'; end if;
  if v_kind not in ('batch','repack') then raise exception 'Jenis resep tidak valid.' using errcode = '22023'; end if;
  if length(trim(coalesce(p ->> 'nama', ''))) = 0 then raise exception 'Nama resep wajib diisi.' using errcode = '22023'; end if;
  if jsonb_typeof(p -> 'items') is distinct from 'array' or jsonb_array_length(p -> 'items') = 0 then raise exception 'Resep minimal berisi satu bahan.' using errcode = '22023'; end if;
  if not exists (select 1 from public.product_variants where id = nullif(p ->> 'variant_id', '')::uuid) then raise exception 'Varian produk tidak ditemukan.' using errcode = 'P0002'; end if;

  if v_id is null then
    insert into public.recipes (variant_id, name, standard_yield, kind, labor_cost)
    values ((p ->> 'variant_id')::uuid, trim(p ->> 'nama'), v_yield, v_kind, v_labor) returning * into v_r;
  else
    update public.recipes set variant_id = (p ->> 'variant_id')::uuid, name = trim(p ->> 'nama'), standard_yield = v_yield, kind = v_kind, labor_cost = v_labor
      where id = v_id returning * into v_r;
    if not found then raise exception 'Resep tidak ditemukan.' using errcode = 'P0002'; end if;
    delete from public.recipe_items where recipe_id = v_r.id;
  end if;

  for v_e in select * from jsonb_array_elements(p -> 'items') loop
    v_mat := nullif(v_e ->> 'material_id', '')::uuid; v_q := app.num(v_e, 'qty');
    if v_mat is null or v_q is null or v_q <= 0 then raise exception 'Bahan resep tidak valid (bahan dan jumlah > 0 wajib).' using errcode = '22023'; end if;
    if not exists (select 1 from public.materials where id = v_mat) then raise exception 'Bahan tidak ditemukan.' using errcode = 'P0002'; end if;
    insert into public.recipe_items (recipe_id, material_id, qty) values (v_r.id, v_mat, v_q);
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'recipe_id', i.recipe_id, 'material_id', i.material_id, 'qty', i.qty)), '[]'::jsonb) into v_items
    from public.recipe_items i where i.recipe_id = v_r.id;
  perform app.audit(null, 'recipe_save', 'recipes', v_r.id::text, null, jsonb_build_object('items', jsonb_array_length(v_items)));
  return jsonb_build_object('recipe', jsonb_build_object('id', v_r.id, 'variant_id', v_r.variant_id, 'nama', v_r.name, 'hasil_standar', v_r.standard_yield,
                            'jenis', v_r.kind, 'aktif', true, 'tenaga_kerja', v_r.labor_cost), 'items', v_items);
end $$;

-- ---------- Pembungkus RPC + hak ----------
do $$ declare n text; begin
  foreach n in array array['dashboard','report_legacy','production_list','recipe_save'] loop
    execute format('create or replace function public.rpc_%1$s(p jsonb default ''{}''::jsonb) returns jsonb language sql security invoker set search_path = '''' as $f$ select app.%1$s(p) $f$', n);
    execute format('revoke all on function public.rpc_%1$s(jsonb) from public, anon', n);
    execute format('grant execute on function public.rpc_%1$s(jsonb) to authenticated', n);
    execute format('revoke all on function app.%1$s(jsonb) from public, anon', n);
    execute format('grant execute on function app.%1$s(jsonb) to authenticated', n);
  end loop;
end $$;
