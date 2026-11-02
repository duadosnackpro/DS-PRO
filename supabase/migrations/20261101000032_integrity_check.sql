-- 0032 Pemeriksaan integritas (Fase 1, aturan A7 di Framework-Efisiensi-End-to-End.md). HANYA BACA: tidak mengubah data, tidak mengubah fungsi lain,
-- tidak menyentuh stock_apply. Aman dijalankan ulang. Dipakai Diagnostik (Fase berikutnya) dan verifikasi pasca-restore (Fase 2).
--
-- Invarian yang diperiksa (per outlet):
--   K1  saldo = jumlah ledger        : inventory_balances / inventory_material_balances.quantity = SUM(stock_movements.quantity_delta)
--   K2  ledger konsisten             : value = round(quantity_delta x unit_cost, 4); balance_after = balance_after sebelumnya + quantity_delta
--   K3  penjualan                    : subtotal = SUM(line_total); total = subtotal - diskon (+ PPN bila eksklusif)
--   K4  pembelian (status posted)    : subtotal = SUM(qty x harga); total = subtotal + ongkir; SUM(qty x effective_cost) mendekati total
--                                      dalam batas pembulatan 4 desimal per satuan (lihat catatan K4)
--   K5  produksi selesai             : total = bahan + kemasan + tenaga kerja + overhead; unit_cost = round(total / hasil aktual, 4)
-- Catatan K4: effective_cost disimpan 4 desimal per SATUAN, sehingga qty x effective_cost tidak mungkin tepat sama dengan total untuk semua qty tanpa
-- mengubah presisi ledger (stock_apply). Batas selisih yang sah adalah SUM(qty) x 0,00005 ditambah 0,01 (subtotal disimpan 2 desimal). Selisih di luar
-- batas itu dianggap pelanggaran. Bila ongkir tidak dialokasikan (alokasi_ongkir = false), SUM(qty x effective_cost) harus mendekati subtotal.

create or replace function app.integrity_check(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_o public.outlets; v_checks jsonb := '[]'::jsonb; v_n bigint; v_bad bigint; v_ex jsonb; v_total bigint := 0;
begin
  v_o := app.active_outlet(nullif(p ->> 'outlet_id', '')::uuid);
  perform app.require_role(v_o.id, array['owner','admin','auditor']);

  -- K1 saldo = jumlah ledger (varian dan bahan)
  with led as (
    select item_type, item_id, sum(quantity_delta) as s from public.stock_movements where outlet_id = v_o.id group by 1, 2
  ), bal as (
    select 'variant'::text as item_type, variant_id as item_id, quantity from public.inventory_balances where outlet_id = v_o.id
    union all
    select 'material', material_id, quantity from public.inventory_material_balances where outlet_id = v_o.id
  ), j as (
    select coalesce(b.item_type, l.item_type) as item_type, coalesce(b.item_id, l.item_id) as item_id, b.quantity as saldo, l.s as ledger
    from bal b full join led l on l.item_type = b.item_type and l.item_id = b.item_id
  )
  select count(*), count(*) filter (where coalesce(saldo, 0) <> coalesce(ledger, 0)),
         coalesce(jsonb_agg(jsonb_build_object('item_type', item_type, 'item_id', item_id, 'saldo', saldo, 'ledger', ledger))
                  filter (where coalesce(saldo, 0) <> coalesce(ledger, 0)), '[]'::jsonb)
    into v_n, v_bad, v_ex from j;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object('kode', 'K1', 'nama', 'Saldo sama dengan jumlah ledger', 'diperiksa', v_n,
    'pelanggaran', v_bad, 'contoh', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_ex) e limit 5) x)));
  v_total := v_total + v_bad;

  -- K2 ledger konsisten: nilai per baris dan rantai saldo per item
  with m as (
    select id, item_type, item_id, quantity_delta, unit_cost, value, balance_after,
           lag(balance_after) over (partition by item_type, item_id order by id) as prev_after
    from public.stock_movements where outlet_id = v_o.id
  ), bad as (
    select id, item_type, item_id,
           (unit_cost is not null and value is not null and abs(value - round(quantity_delta * unit_cost, 4)) > 0.0001) as nilai_salah,
           (prev_after is not null and balance_after <> round(prev_after + quantity_delta, 4)) as rantai_putus
    from m
  )
  select (select count(*) from m), count(*) filter (where nilai_salah or rantai_putus),
         coalesce(jsonb_agg(jsonb_build_object('movement_id', id, 'item_id', item_id, 'nilai_salah', nilai_salah, 'rantai_putus', rantai_putus))
                  filter (where nilai_salah or rantai_putus), '[]'::jsonb)
    into v_n, v_bad, v_ex from bad;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object('kode', 'K2', 'nama', 'Ledger konsisten (nilai dan rantai saldo)', 'diperiksa', v_n,
    'pelanggaran', v_bad, 'contoh', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_ex) e limit 5) x)));
  v_total := v_total + v_bad;

  -- K3 penjualan
  with s as (
    select s.id, s.receipt_no, s.kind, s.subtotal, s.discount, s.tax_amount, s.total,
           coalesce((select sum(i.line_total) from public.sale_items i where i.sale_id = s.id), 0) as lines
    from public.sales s where s.outlet_id = v_o.id
  ), bad as (
    select *, (abs(subtotal - lines) > 0.005) as baris_salah,
           not (abs(abs(total) - abs(subtotal - discount)) <= 0.005 or abs(abs(total) - abs(subtotal - discount + tax_amount)) <= 0.005) as total_salah
    from s
  )
  select (select count(*) from s), count(*) filter (where baris_salah or total_salah),
         coalesce(jsonb_agg(jsonb_build_object('receipt_no', receipt_no, 'subtotal', subtotal, 'jumlah_baris', lines, 'total', total,
                  'baris_salah', baris_salah, 'total_salah', total_salah)) filter (where baris_salah or total_salah), '[]'::jsonb)
    into v_n, v_bad, v_ex from bad;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object('kode', 'K3', 'nama', 'Penjualan: baris dan total cocok', 'diperiksa', v_n,
    'pelanggaran', v_bad, 'contoh', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_ex) e limit 5) x)));
  v_total := v_total + v_bad;

  -- K4 pembelian (hanya yang berstatus posted)
  with pu as (
    select pu.id, pu.doc_ref, pu.subtotal, pu.shipping, pu.total,
           coalesce(sum(i.qty * i.unit_price), 0) as sum_harga, coalesce(sum(i.qty * i.effective_cost), 0) as sum_eff, coalesce(sum(i.qty), 0) as sum_qty
    from public.purchases pu left join public.purchase_items i on i.purchase_id = pu.id
    where pu.outlet_id = v_o.id and pu.status = 'posted' group by pu.id
  ), bad as (
    select *, (abs(subtotal - sum_harga) > 0.01) as subtotal_salah, (abs(total - (subtotal + shipping)) > 0.005) as total_salah,
           not (abs(sum_eff - total) <= sum_qty * 0.00005 + 0.01 or abs(sum_eff - subtotal) <= sum_qty * 0.00005 + 0.01) as biaya_salah
    from pu
  )
  select (select count(*) from pu), count(*) filter (where subtotal_salah or total_salah or biaya_salah),
         coalesce(jsonb_agg(jsonb_build_object('purchase_id', id, 'subtotal', subtotal, 'total', total, 'jumlah_harga', sum_harga, 'jumlah_biaya', sum_eff,
                  'subtotal_salah', subtotal_salah, 'total_salah', total_salah, 'biaya_salah', biaya_salah))
                  filter (where subtotal_salah or total_salah or biaya_salah), '[]'::jsonb)
    into v_n, v_bad, v_ex from bad;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object('kode', 'K4', 'nama', 'Pembelian: subtotal, total, dan biaya per satuan', 'diperiksa', v_n,
    'pelanggaran', v_bad, 'contoh', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_ex) e limit 5) x)));
  v_total := v_total + v_bad;

  -- K5 produksi selesai (per outlet dapur)
  with pc as (
    select o.id, c.materials_cost, c.packaging_cost, c.labor_cost, c.overhead_cost, c.total, c.unit_cost, o.actual_qty
    from public.production_orders o join public.production_costs c on c.production_id = o.id
    where o.kitchen_outlet_id = v_o.id and o.status = 'done'
  ), bad as (
    select *, (abs(total - (materials_cost + packaging_cost + labor_cost + overhead_cost)) > 0.015) as total_salah,
           (actual_qty > 0 and abs(unit_cost - round(total / actual_qty, 4)) > 0.0001) as unit_salah
    from pc
  )
  select (select count(*) from pc), count(*) filter (where total_salah or unit_salah),
         coalesce(jsonb_agg(jsonb_build_object('production_id', id, 'total', total, 'unit_cost', unit_cost, 'total_salah', total_salah, 'unit_salah', unit_salah))
                  filter (where total_salah or unit_salah), '[]'::jsonb)
    into v_n, v_bad, v_ex from bad;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object('kode', 'K5', 'nama', 'Produksi selesai: komponen biaya dan HPP per unit', 'diperiksa', v_n,
    'pelanggaran', v_bad, 'contoh', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_ex) e limit 5) x)));
  v_total := v_total + v_bad;

  return jsonb_build_object('ok', v_total = 0, 'outlet_id', v_o.id, 'diperiksa_pada', now(), 'total_pelanggaran', v_total, 'pemeriksaan', v_checks);
end $$;
revoke all on function app.integrity_check(jsonb) from public, anon;
grant execute on function app.integrity_check(jsonb) to authenticated;

create or replace function public.rpc_integrity_check(p jsonb default '{}'::jsonb) returns jsonb
language sql stable security invoker set search_path = '' as $f$ select app.integrity_check(p) $f$;
revoke all on function public.rpc_integrity_check(jsonb) from public, anon;
grant execute on function public.rpc_integrity_check(jsonb) to authenticated;
