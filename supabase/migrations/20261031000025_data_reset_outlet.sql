-- 0025 Reset data transaksi per outlet (khusus Owner), dipakai sebelum go-live untuk membuang data uji coba.
--
-- Satu fungsi, dua mode (pola sama dengan hpp_backfill):
--   terapkan = false (bawaan)  pratinjau: hanya menghitung apa yang akan dihapus, tidak mengubah apa pun.
--   terapkan = true            menghapus, dengan syarat kode outlet diketik persis, alasan diisi, dan request_id dikirim.
--
-- Cakupan: HANYA outlet yang dikirim (outlet aktif di klien). Outlet lain tidak disentuh.
-- Dihapus : penjualan + item + pembayaran, impor Shopee, sesi dan mutasi kas, biaya outlet, pembelian, produksi,
--           transfer stok yang menyentuh outlet ini, kerugian persediaan, ledger stok, penghitung nomor struk, persetujuan diskon.
-- Tetap   : produk, varian, harga, bahan, resep, supplier, pengguna, outlet, pengaturan, dan audit_logs (reset ini sendiri dicatat di sana).
-- Stok    : 'nol' (bawaan) mengosongkan saldo dan HPP rata-rata; 'pertahankan' menjaga jumlah dan HPP sekarang dan menuliskannya
--           kembali sebagai satu mutasi 'opening' per item, sehingga ledger tetap cocok dengan saldo.
--
-- Ditolak bila: bukan Owner; ada transfer stok yang masih berjalan (submitted/approved/sent) pada outlet ini; periode sudah dikunci.
-- stock_movements dan inventory_losses dilindungi trigger anti-hapus. Trigger itu dimatikan hanya di dalam transaksi fungsi ini
-- (ALTER TABLE ... DISABLE TRIGGER ikut dibatalkan bila transaksi gagal) dan dinyalakan lagi sebelum fungsi selesai.

create function app.data_reset(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := (select auth.uid());
  v_o     public.outlets;
  v_apply boolean := lower(coalesce(p ->> 'terapkan', 'false')) in ('true', 't', '1');
  v_mode  text := lower(coalesce(nullif(trim(p ->> 'stok'), ''), 'nol'));
  v_why   text := trim(coalesce(p ->> 'alasan', ''));
  v_req   text := nullif(trim(coalesce(p ->> 'request_id', '')), '');
  v_dup   jsonb; v_lock date; v_fly int; v_block text; v_n jsonb; v_res jsonb;
begin
  if v_uid is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  if not app.is_owner() then
    raise exception 'Hanya Owner yang dapat mereset data transaksi.' using errcode = '42501';
  end if;
  if v_mode not in ('nol', 'pertahankan') then
    raise exception 'Pilihan stok tidak dikenal (nol atau pertahankan).' using errcode = '22023';
  end if;
  select * into v_o from public.outlets where id = nullif(p ->> 'outlet_id', '')::uuid;
  if not found then raise exception 'Outlet tidak ditemukan.' using errcode = 'P0002'; end if;

  select count(*) into v_fly from public.stock_transfers t
   where (t.from_outlet_id = v_o.id or t.to_outlet_id = v_o.id) and t.status in ('submitted', 'approved', 'sent');
  v_lock := app.period_lock();
  v_block := case
    when v_fly > 0 then format('Masih ada %s transfer stok yang belum selesai. Selesaikan atau batalkan dulu.', v_fly)
    when v_lock is not null then format('Periode sudah dikunci sampai %s. Buka kunci periode di Pengaturan dulu.', to_char(v_lock, 'DD-MM-YYYY'))
  end;

  v_n := jsonb_build_object(
    'penjualan',  (select count(*) from public.sales where outlet_id = v_o.id),
    'total_rp',   (select coalesce(sum(total), 0) from public.sales where outlet_id = v_o.id and status = 'completed'),
    'pembayaran', (select count(*) from public.payments where outlet_id = v_o.id),
    'impor',      (select count(*) from public.external_orders where outlet_id = v_o.id),
    'sesi_kas',   (select count(*) from public.cash_sessions where outlet_id = v_o.id),
    'mutasi_kas', (select count(*) from public.cash_movements where outlet_id = v_o.id),
    'biaya',      (select count(*) from public.expenses where outlet_id = v_o.id),
    'pembelian',  (select count(*) from public.purchases where outlet_id = v_o.id),
    'produksi',   (select count(*) from public.production_orders where kitchen_outlet_id = v_o.id or output_outlet_id = v_o.id),
    'transfer',   (select count(*) from public.stock_transfers where from_outlet_id = v_o.id or to_outlet_id = v_o.id),
    'kerugian',   (select count(*) from public.inventory_losses where outlet_id = v_o.id),
    'mutasi_stok',(select count(*) from public.stock_movements where outlet_id = v_o.id),
    'saldo_stok', (select count(*) from public.inventory_balances where outlet_id = v_o.id and quantity <> 0)
                + (select count(*) from public.inventory_material_balances where outlet_id = v_o.id and quantity <> 0));

  if not v_apply then
    return jsonb_build_object('terapkan', false, 'blokir', v_block, 'jumlah', v_n,
      'outlet', jsonb_build_object('id', v_o.id, 'kode', v_o.code, 'nama', v_o.name));
  end if;

  if v_block is not null then raise exception '%', v_block using errcode = 'P0001'; end if;
  if upper(trim(coalesce(p ->> 'konfirmasi', ''))) <> upper(v_o.code) then
    raise exception 'Kode konfirmasi tidak cocok. Ketik kode outlet % persis seperti tertulis.', v_o.code using errcode = '22023';
  end if;
  if length(v_why) < 3 then raise exception 'Alasan reset wajib diisi (minimal 3 huruf).' using errcode = '22023'; end if;
  v_dup := app.idem_begin('data_reset', v_req, p);
  if v_dup is not null then return v_dup; end if;

  -- Kunci saldo outlet ini: penjualan yang sedang berjalan menunggu sampai reset selesai, bukan menulis di tengah penghapusan.
  perform 1 from public.inventory_balances where outlet_id = v_o.id for update;
  perform 1 from public.inventory_material_balances where outlet_id = v_o.id for update;

  -- Anak dulu, induk kemudian.
  delete from public.external_orders where outlet_id = v_o.id;
  delete from public.import_batches where outlet_id = v_o.id;
  delete from public.payments where outlet_id = v_o.id;
  delete from public.sale_items where outlet_id = v_o.id;
  delete from public.sales where outlet_id = v_o.id;          -- baris retur dan penjualan asalnya dihapus dalam satu perintah
  delete from public.cash_movements where outlet_id = v_o.id; -- sebelum biaya (cash_movements.expense_id) dan sesi kas
  delete from public.expenses where outlet_id = v_o.id;       -- biaya pusat (outlet NULL) tidak disentuh
  delete from public.cash_sessions where outlet_id = v_o.id;
  delete from public.purchase_items i using public.purchases u where u.id = i.purchase_id and u.outlet_id = v_o.id;
  delete from public.purchases where outlet_id = v_o.id;
  delete from public.production_costs c using public.production_orders o
   where o.id = c.production_id and (o.kitchen_outlet_id = v_o.id or o.output_outlet_id = v_o.id);
  delete from public.production_orders where kitchen_outlet_id = v_o.id or output_outlet_id = v_o.id;
  delete from public.stock_transfer_items i using public.stock_transfers t
   where t.id = i.transfer_id and (t.from_outlet_id = v_o.id or t.to_outlet_id = v_o.id);
  delete from public.stock_transfers where from_outlet_id = v_o.id or to_outlet_id = v_o.id;

  alter table public.stock_movements disable trigger stock_movements_immutable;
  alter table public.inventory_losses disable trigger inventory_losses_immutable;
  delete from public.inventory_losses where outlet_id = v_o.id;
  delete from public.stock_movements where outlet_id = v_o.id;
  alter table public.stock_movements enable trigger stock_movements_immutable;
  alter table public.inventory_losses enable trigger inventory_losses_immutable;

  delete from app.outlet_counters where outlet_id = v_o.id;
  delete from app.approvals where outlet_id = v_o.id;

  if v_mode = 'nol' then
    update public.inventory_balances set quantity = 0, avg_cost = 0, updated_at = now() where outlet_id = v_o.id;
    update public.inventory_material_balances set quantity = 0, avg_cost = 0, updated_at = now() where outlet_id = v_o.id;
  else
    insert into public.stock_movements (outlet_id, item_type, item_id, movement_type, quantity_delta, unit_cost, value, balance_after, reference_type, user_id, note)
    select outlet_id, 'variant', variant_id, 'opening', quantity, avg_cost, round(quantity * avg_cost, 4), quantity, 'data_reset', v_uid, 'Stok awal setelah reset data'
      from public.inventory_balances where outlet_id = v_o.id and quantity <> 0;
    insert into public.stock_movements (outlet_id, item_type, item_id, movement_type, quantity_delta, unit_cost, value, balance_after, reference_type, user_id, note)
    select outlet_id, 'material', material_id, 'opening', quantity, avg_cost, round(quantity * avg_cost, 4), quantity, 'data_reset', v_uid, 'Stok awal setelah reset data'
      from public.inventory_material_balances where outlet_id = v_o.id and quantity <> 0;
  end if;

  perform app.audit(v_o.id, 'data_reset', 'outlets', v_o.id::text, v_n,
                    jsonb_build_object('stok', v_mode, 'alasan', left(v_why, 300)));

  v_res := jsonb_build_object('terapkan', true, 'blokir', null, 'jumlah', v_n, 'stok', v_mode,
    'outlet', jsonb_build_object('id', v_o.id, 'kode', v_o.code, 'nama', v_o.name));
  return app.idem_finish('data_reset', v_req, v_res);
end $$;

-- ---------- Pembungkus RPC publik + hak eksekusi ----------
create function public.rpc_data_reset(p jsonb default '{}'::jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select app.data_reset(p) $$;
revoke all on function public.rpc_data_reset(jsonb) from public, anon;
grant execute on function public.rpc_data_reset(jsonb) to authenticated;
revoke all on function app.data_reset(jsonb) from public, anon;
grant execute on function app.data_reset(jsonb) to authenticated;
