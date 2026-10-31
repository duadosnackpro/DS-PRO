-- 0027 Laporan operasional (Medium #2 dan #3):
--   stok_minimum  : stok di bawah minimum saat ini + stockout rate (waktu habis / waktu terpantau) dari ledger stock_movements
--   lead_transfer : lama transfer antar-outlet (sent_at -> received_at) per transfer, dengan rata-rata/median/P90
--   durasi_shift  : lama buka kasir per shift (opened_at -> closed_at), transaksi per jam, shift yang lupa ditutup
-- Fungsi terpisah dari report_legacy (tidak menyalin ulang fungsi 100+ baris itu). Keluaran berbentuk sama
-- (columns/fmt/rows/summary/peringatan) sehingga layar Laporan memakainya apa adanya. Klien yang memanggilnya lewat rpc_report_ops.

create or replace function app.report_ops(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_o public.outlets; v_type text := coalesce(p ->> 'type', ''); v_role text;
  v_today date; v_from date; v_to date; v_t0 timestamptz; v_t1 timestamptz;
  v_title text; v_cols jsonb; v_fmt jsonb; v_rows jsonb := '[]'::jsonb; v_sum jsonb := '[]'::jsonb; v_warn text := null;
  v_n bigint; v_a numeric; v_b numeric; v_c numeric; v_d numeric; v_e numeric;
  v_used_days constant int := 60;     -- item dianggap "dipakai" bila ada mutasi keluar dalam 60 hari terakhir
begin
  if (select auth.uid()) is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  select * into v_o from public.outlets where id = nullif(p ->> 'outlet_id', '')::uuid;
  if not found then raise exception 'Outlet tidak ditemukan.' using errcode = 'P0002'; end if;
  if v_type not in ('stok_minimum', 'lead_transfer', 'durasi_shift') then
    raise exception 'Jenis laporan tidak dikenal: %', v_type using errcode = '22023'; end if;
  v_role := app.role_at(v_o.id);
  if v_role is null then raise exception 'Akses ditolak untuk outlet ini.' using errcode = '42501'; end if;
  if (v_type = 'stok_minimum' and v_role not in ('owner','admin','supervisor','stok','produksi','auditor'))
     or (v_type = 'lead_transfer' and v_role not in ('owner','admin','supervisor','stok','auditor'))
     or (v_type = 'durasi_shift' and v_role not in ('owner','admin','supervisor','auditor')) then
    raise exception 'Peran Anda tidak boleh membuka laporan ini.' using errcode = '42501'; end if;

  v_today := (now() at time zone v_o.timezone)::date;
  v_to := coalesce(nullif(p ->> 'to', '')::date, v_today);
  v_from := coalesce(nullif(p ->> 'from', '')::date, v_to - 29);   -- bawaan 30 hari: satu hari saja tidak cukup untuk angka stockout/lead time
  if v_to < v_from or v_to - v_from > 400 then raise exception 'Rentang tanggal tidak valid (maksimal 400 hari).' using errcode = '22023'; end if;
  v_t0 := v_from::timestamp at time zone v_o.timezone;
  v_t1 := least(((v_to + 1)::timestamp at time zone v_o.timezone), now());   -- masa depan tidak ikut dihitung
  if v_t1 <= v_t0 then v_t1 := v_t0 + interval '1 second'; end if;

  if v_type = 'stok_minimum' then
    v_title := 'Stok minimum & stockout';
    v_cols := '["Jenis","Item","Satuan","Stok","Minimum","Status","Kejadian habis","Lama habis (hari)","Waktu habis"]';
    v_fmt  := '["txt","txt","txt","num","num","txt","num","num","pct"]';
    -- Garis waktu saldo tiap item dari ledger: titik awal (saldo terakhir sebelum rentang) + semua mutasi dalam rentang.
    -- Tiap titik berlaku sampai titik berikutnya (atau akhir rentang); "habis" = saldo <= 0 (termasuk minus). Satu kali jalan untuk baris dan ringkasan.
    with items as (
      select 'variant'::text as item_type, v.id as item_id, 'Produk jadi'::text as jenis, trim(coalesce(pr.name, '?') || ' ' || v.sku) as nm, 'pcs'::text as satuan,
             coalesce(b.quantity, 0) as qty, coalesce(b.min_qty, 0) as mn
        from public.product_variants v join public.products pr on pr.id = v.product_id and pr.active
        left join public.inventory_balances b on b.outlet_id = v_o.id and b.variant_id = v.id
       where v.active
      union all
      select 'material', m.id, 'Bahan', m.name, m.unit, coalesce(b.quantity, 0), m.min_stock
        from public.materials m
        left join public.inventory_material_balances b on b.outlet_id = v_o.id and b.material_id = m.id
       where m.active
    ), used as (
      select i.* from items i
       where exists (select 1 from public.stock_movements sm
                      where sm.outlet_id = v_o.id and sm.item_type = i.item_type and sm.item_id = i.item_id
                        and sm.created_at >= v_t1 - make_interval(days => v_used_days) and sm.created_at < v_t1
                        and sm.quantity_delta < 0 and sm.movement_type in ('sale', 'production_use', 'transfer_out'))
    ), pts as (
      select u.item_type, u.item_id, v_t0 as ts, s.balance_after as bal, -1::bigint as sid
        from used u cross join lateral (
          select sm.balance_after from public.stock_movements sm
           where sm.outlet_id = v_o.id and sm.item_type = u.item_type and sm.item_id = u.item_id and sm.created_at < v_t0
           order by sm.created_at desc, sm.id desc limit 1) s
      union all
      select u.item_type, u.item_id, sm.created_at, sm.balance_after, sm.id
        from used u join public.stock_movements sm
          on sm.outlet_id = v_o.id and sm.item_type = u.item_type and sm.item_id = u.item_id and sm.created_at >= v_t0 and sm.created_at < v_t1
    ), seg as (
      select q.item_type, q.item_id, q.bal, q.sid, q.prev_bal, extract(epoch from (coalesce(q.nxt, v_t1) - q.ts)) as secs
        from (select pt.*, lead(pt.ts) over w as nxt, lag(pt.bal) over w as prev_bal
                from pts pt window w as (partition by pt.item_type, pt.item_id order by pt.ts, pt.sid)) q
    ), agg as (
      select s.item_type, s.item_id, sum(s.secs) as mon, coalesce(sum(s.secs) filter (where s.bal <= 0), 0) as out_s,
             count(*) filter (where s.sid > 0 and s.bal <= 0 and coalesce(s.prev_bal, 1) > 0) as kejadian
        from seg s group by 1, 2
    ), allr as (
      select i.jenis, i.nm, i.satuan, i.qty, i.mn,
             case when i.qty <= 0 then 'Habis' when i.mn > 0 and i.qty <= i.mn then 'Di bawah minimum' else 'Aman' end as status,
             coalesce(a.kejadian, 0) as kejadian, coalesce(a.out_s, 0) as out_s, coalesce(a.mon, 0) as mon, (u.item_id is not null) as dipakai
        from items i left join used u on u.item_type = i.item_type and u.item_id = i.item_id
        left join agg a on a.item_type = i.item_type and a.item_id = i.item_id
    )
    select coalesce(jsonb_agg(jsonb_build_array(r.jenis, r.nm, r.satuan, r.qty, r.mn, r.status, r.kejadian, round(r.out_s / 86400.0, 1),
                                                case when r.mon > 0 then round(r.out_s / r.mon * 100, 1) else null end)
                              order by (r.status = 'Habis') desc, r.out_s desc, (r.status = 'Di bawah minimum') desc, r.nm)
                    filter (where (r.dipakai and (r.qty <= 0 or r.out_s > 0 or (r.mn > 0 and r.qty <= r.mn))) or (not r.dipakai and r.mn > 0 and r.qty <= r.mn)), '[]'::jsonb),
           count(*) filter (where r.dipakai), coalesce(sum(r.out_s) filter (where r.dipakai), 0), coalesce(sum(r.mon) filter (where r.dipakai), 0),
           count(*) filter (where r.dipakai and r.out_s > 0), count(*) filter (where r.dipakai and r.qty <= 0), count(*) filter (where r.qty > 0 and r.mn > 0 and r.qty <= r.mn)
      into v_rows, v_n, v_a, v_b, v_c, v_d, v_e from allr r;
    if jsonb_array_length(v_rows) > 300 then
      v_rows := (select jsonb_agg(x.e order by x.o) from jsonb_array_elements(v_rows) with ordinality x(e, o) where x.o <= 300);
      v_warn := '300 baris teratas ditampilkan. ';
    end if;
    v_sum := jsonb_build_array(
      jsonb_build_object('label', 'Stockout rate (waktu habis)', 'value', case when v_b > 0 then round(v_a / v_b * 100, 1) else 0 end, 'fmt', 'pct'),
      jsonb_build_object('label', 'Item dipantau', 'value', v_n, 'fmt', 'num'),
      jsonb_build_object('label', 'Item pernah habis (rentang)', 'value', v_c, 'fmt', 'num'),
      jsonb_build_object('label', 'Item habis sekarang', 'value', v_d, 'fmt', 'num'),
      jsonb_build_object('label', 'Item di bawah minimum', 'value', v_e, 'fmt', 'num'));
    v_warn := coalesce(v_warn, '') || case when v_n = 0
      then 'Belum ada item dengan riwayat keluar dalam ' || v_used_days || ' hari terakhir, jadi stockout rate belum dapat dihitung.'
      else 'Dipantau: item aktif yang keluar (jual/produksi/transfer) dalam ' || v_used_days || ' hari terakhir. Stockout rate = jam saldo <= 0 dibagi jam terpantau, dengan jam kalender (termasuk di luar jam buka). Kolom Stok dan Status adalah kondisi saat ini.' end;

  elsif v_type = 'lead_transfer' then
    v_title := 'Lead time transfer'; v_cols := '["Nomor","Dari","Ke","Dikirim","Diterima","Di jalan (jam)","Total (jam)","Item","Item selisih"]'; v_fmt := '["txt","txt","txt","txt","txt","num","num","num","num"]';
    select coalesce(jsonb_agg(jsonb_build_array(q.number, q.dari, q.ke, to_char(q.sent_at at time zone v_o.timezone, 'YYYY-MM-DD HH24:MI'),
             to_char(q.received_at at time zone v_o.timezone, 'YYYY-MM-DD HH24:MI'), round(q.jalan_jam, 1), round(q.total_jam, 1), q.n, q.beda) order by q.received_at desc), '[]'::jsonb)
      into v_rows from (
        select t.number, fo.code as dari, tu.code as ke, t.sent_at, t.received_at,
               extract(epoch from (t.received_at - t.sent_at)) / 3600.0 as jalan_jam, extract(epoch from (t.received_at - t.created_at)) / 3600.0 as total_jam,
               (select count(*) from public.stock_transfer_items i where i.transfer_id = t.id) as n,
               (select count(*) from public.stock_transfer_items i where i.transfer_id = t.id and i.variance is distinct from 0 and i.variance is not null) as beda
          from public.stock_transfers t join public.outlets fo on fo.id = t.from_outlet_id join public.outlets tu on tu.id = t.to_outlet_id
         where t.status = 'received' and t.sent_at is not null and t.received_at is not null and (t.from_outlet_id = v_o.id or t.to_outlet_id = v_o.id)
           and (t.received_at at time zone v_o.timezone)::date between v_from and v_to
         order by t.received_at desc limit 500) q;
    select count(*), avg(h), percentile_cont(0.5) within group (order by h), percentile_cont(0.9) within group (order by h), max(h), count(*) filter (where h > 72)
      into v_n, v_a, v_b, v_c, v_d, v_e from (
        select extract(epoch from (t.received_at - t.sent_at)) / 3600.0 as h from public.stock_transfers t
         where t.status = 'received' and t.sent_at is not null and t.received_at is not null and (t.from_outlet_id = v_o.id or t.to_outlet_id = v_o.id)
           and (t.received_at at time zone v_o.timezone)::date between v_from and v_to) z;
    v_sum := jsonb_build_array(jsonb_build_object('label', 'Transfer diterima', 'value', v_n, 'fmt', 'num'),
      jsonb_build_object('label', 'Rata-rata di jalan (jam)', 'value', round(coalesce(v_a, 0), 1), 'fmt', 'num'),
      jsonb_build_object('label', 'Median (jam)', 'value', round(coalesce(v_b, 0), 1), 'fmt', 'num'),
      jsonb_build_object('label', 'P90 (jam)', 'value', round(coalesce(v_c, 0), 1), 'fmt', 'num'),
      jsonb_build_object('label', 'Terlama (jam)', 'value', round(coalesce(v_d, 0), 1), 'fmt', 'num'),
      jsonb_build_object('label', 'Lebih dari 72 jam', 'value', v_e, 'fmt', 'num'));
    select count(*) into v_n from public.stock_transfers t where t.status = 'sent' and (t.from_outlet_id = v_o.id or t.to_outlet_id = v_o.id);
    v_warn := 'Di jalan = waktu kirim sampai waktu terima; Total = sejak transfer dibuat. Hanya transfer berstatus diterima pada rentang tanggal terima.'
              || case when v_n > 0 then ' ' || v_n || ' transfer masih di jalan (lihat laporan Dalam perjalanan); belum masuk hitungan.' else '' end;

  else  -- durasi_shift
    v_title := 'Durasi shift kasir'; v_cols := '["Kasir","Buka","Tutup","Durasi (jam)","Transaksi","Transaksi/jam","Omzet","Selisih kas","Buka otomatis"]'; v_fmt := '["txt","txt","txt","num","num","num","rp","rp","txt"]';
    select coalesce(jsonb_agg(jsonb_build_array(q.kasir, to_char(q.opened_at at time zone v_o.timezone, 'YYYY-MM-DD HH24:MI'),
             case when q.closed_at is null then 'masih buka' else to_char(q.closed_at at time zone v_o.timezone, 'YYYY-MM-DD HH24:MI') end,
             round(q.jam, 1), q.trx, case when q.jam >= 0.25 then round(q.trx / q.jam, 1) else null end, q.omzet,
             case when q.closed_at is null then null else q.difference end, case when q.auto_opened then 'ya' else '' end) order by q.opened_at desc), '[]'::jsonb)
      into v_rows from (
        select coalesce(pr.full_name, '?') as kasir, s.opened_at, s.closed_at, extract(epoch from (coalesce(s.closed_at, now()) - s.opened_at)) / 3600.0 as jam,
               coalesce(x.trx, 0) as trx, coalesce(x.omzet, 0) as omzet, s.difference, s.auto_opened
          from public.cash_sessions s left join public.profiles pr on pr.id = s.cashier_id
          left join lateral (select count(*) filter (where sa.kind = 'sale') as trx, sum(sa.total - sa.tax_amount) as omzet from public.sales sa
                              where sa.cash_session_id = s.id and sa.status = 'completed') x on true
         where s.outlet_id = v_o.id and (s.opened_at at time zone v_o.timezone)::date between v_from and v_to
         order by s.opened_at desc limit 500) q;
    select count(*), avg(h) filter (where closed), max(h) filter (where closed), count(*) filter (where h > 16), count(*) filter (where trx = 0 and closed),
           count(*) filter (where auto)
      into v_n, v_a, v_b, v_c, v_d, v_e
      from (select extract(epoch from (coalesce(s.closed_at, now()) - s.opened_at)) / 3600.0 as h, (s.status = 'closed') as closed, s.auto_opened as auto,
                   (select count(*) from public.sales sa where sa.cash_session_id = s.id and sa.status = 'completed' and sa.kind = 'sale') as trx
              from public.cash_sessions s
             where s.outlet_id = v_o.id and (s.opened_at at time zone v_o.timezone)::date between v_from and v_to) z;
    v_sum := jsonb_build_array(jsonb_build_object('label', 'Shift', 'value', v_n, 'fmt', 'num'),
      jsonb_build_object('label', 'Rata-rata durasi (jam)', 'value', round(coalesce(v_a, 0), 1), 'fmt', 'num'),
      jsonb_build_object('label', 'Terlama (jam)', 'value', round(coalesce(v_b, 0), 1), 'fmt', 'num'),
      jsonb_build_object('label', 'Shift > 16 jam', 'value', v_c, 'fmt', 'num'),
      jsonb_build_object('label', 'Shift tanpa transaksi', 'value', v_d, 'fmt', 'num'),
      jsonb_build_object('label', 'Dibuka otomatis', 'value', v_e, 'fmt', 'num'));
    if v_c > 0 then v_warn := v_c || ' shift lebih dari 16 jam (kemungkinan lupa ditutup atau sesi menggantung); durasinya menggelembungkan rata-rata.'; end if;
    v_warn := trim(coalesce(v_warn || ' ', '') || 'Durasi = buka kasir sampai tutup kasir (bukan lama proses tutup di layar; itu belum terukur). Shift yang masih buka dihitung sampai sekarang dan tidak masuk rata-rata.');
  end if;

  return jsonb_build_object('type', v_type, 'title', v_title, 'from', v_from, 'to', v_to, 'outlet_id', v_o.id,
    'columns', v_cols, 'fmt', v_fmt, 'rows', v_rows, 'summary', v_sum, 'peringatan', v_warn);
end $$;
revoke all on function app.report_ops(jsonb) from public, anon;
grant execute on function app.report_ops(jsonb) to authenticated;

create or replace function public.rpc_report_ops(p jsonb default '{}'::jsonb) returns jsonb
language sql security invoker set search_path = '' as $f$ select app.report_ops(p) $f$;
revoke all on function public.rpc_report_ops(jsonb) from public, anon;
grant execute on function public.rpc_report_ops(jsonb) to authenticated;
