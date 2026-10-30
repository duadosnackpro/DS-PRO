-- 0023 P0: kontrol laba, kas, retur, dan transaksi offline (hasil analisis v2.3.2).
--   P0-1  F-03  Retur memakai sesi kasir yang sedang terbuka; persetujuan Owner/Supervisor sekali pakai (app.approvals kind 'retur').
--   P0-2  F-02/F-01  Retur wajib memilih "kembali ke stok" atau "rusak/dibuang"; kerugian persediaan (opname, retur rusak, selisih transfer)
--                    dicatat di public.inventory_losses dan masuk laba rugi.
--   P0-3  F-04  Transaksi offline tertunda yang harganya/stoknya berubah di server DITERIMA dengan tanda "perlu ditinjau" (dicatat dengan harga server),
--                    bukan ditolak. Menghapus transaksi antrean oleh kasir wajib persetujuan Owner/Supervisor (approvals kind 'hapus').
--   P0-4  F-05  Kas keluar laci wajib berkategori dan otomatis menjadi biaya (expenses) bersama cash_movements.
--   P0-5  F-06  Kebijakan: biaya pada kategori "kategori_masuk_hpp" TIDAK dikurangkan lagi dari laba (sudah ada di HPP). Diterapkan di Beranda,
--                    laba rugi, laporan biaya, dan laporan konsolidasi.
--   P0-6  F-07  rpc_report_konsolidasi: laba rugi dan nilai stok semua outlet (kolom per outlet berdampingan + biaya pusat).
-- Klien lama tidak kompatibel (retur tanpa pilihan tindakan barang ditolak, kas keluar tanpa kategori ditolak): min_client dinaikkan ke 2.4.0.

-- ---------- Skema ----------
-- Persetujuan: jenis baru 'retur' (terikat transaksi asal + nilai maksimum) dan 'hapus' (hapus transaksi antrean yang ditolak server).
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'app.approvals'::regclass and contype = 'c' loop
    execute format('alter table app.approvals drop constraint %I', c);
  end loop;
end $$;
alter table app.approvals add column ref_id uuid;
alter table app.approvals add constraint approvals_kind_check check (kind in ('diskon','retur','hapus'));
alter table app.approvals add constraint approvals_amount_check check (amount >= 0 and (kind = 'hapus' or amount > 0));
alter table app.approvals add constraint approvals_retur_ref_check check (kind <> 'retur' or ref_id is not null);

-- Transaksi yang diterima dengan tanda (offline tertunda dengan harga/stok berubah).
alter table public.sales
  add column review_flag boolean not null default false,
  add column review_note text,
  add column reviewed_by uuid,
  add column reviewed_at timestamptz;
create index sales_review_open on public.sales (outlet_id, sold_at desc) where review_flag;

-- Kas keluar laci kini berkategori dan terhubung ke biaya.
alter table public.cash_movements
  add column category text,
  add column expense_id uuid references public.expenses(id);

-- Kerugian persediaan (bernilai rupiah). Tidak dapat diubah/dihapus; koreksi lewat baris baru.
-- quantity > 0 = barang hilang/rusak (kerugian); quantity < 0 = selisih lebih pada opname (mengurangi kerugian).
create table public.inventory_losses (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets(id),
  item_type text not null check (item_type in ('variant','material')),
  item_id uuid not null,
  reason text not null check (reason in ('retur_rusak','opname','selisih_transfer','rusak_buang')),
  quantity numeric(16,4) not null check (quantity <> 0),
  unit_cost numeric(16,4) not null default 0,
  value numeric(18,2) not null,
  ref_type text,
  ref_id uuid,
  note text,
  user_id uuid,
  loss_date date not null,                 -- tanggal lokal outlet saat kejadian
  created_at timestamptz not null default now()
);
create index inventory_losses_outlet_date on public.inventory_losses (outlet_id, loss_date);
create index inventory_losses_ref on public.inventory_losses (ref_type, ref_id);
create trigger inventory_losses_immutable before update or delete on public.inventory_losses
  for each row execute function app.forbid_mutation();
alter table public.inventory_losses enable row level security;
create policy inventory_losses_read on public.inventory_losses for select to authenticated
  using ((select app.has_role(outlet_id, array['owner','admin','auditor'])));
revoke all on public.inventory_losses from public, anon, authenticated;
grant select on public.inventory_losses to authenticated;

-- ---------- Fungsi pembantu internal (tidak dapat dipanggil klien) ----------
-- Mencatat kerugian persediaan. Biaya satuan kosong/0 => memakai HPP rata-rata saat ini.
create function app.loss_record(p_outlet uuid, p_item_type text, p_item_id uuid, p_reason text, p_qty numeric,
                                p_unit_cost numeric, p_ref_type text, p_ref_id uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_cost numeric := p_unit_cost; v_tz text;
begin
  if p_qty is null or p_qty = 0 then return; end if;
  if coalesce(v_cost, 0) <= 0 then
    if p_item_type = 'variant' then
      select b.avg_cost into v_cost from public.inventory_balances b where b.outlet_id = p_outlet and b.variant_id = p_item_id;
    else
      select b.avg_cost into v_cost from public.inventory_material_balances b where b.outlet_id = p_outlet and b.material_id = p_item_id;
    end if;
  end if;
  v_cost := coalesce(v_cost, 0);
  select o.timezone into v_tz from public.outlets o where o.id = p_outlet;
  insert into public.inventory_losses (outlet_id, item_type, item_id, reason, quantity, unit_cost, value, ref_type, ref_id, note, user_id, loss_date)
  values (p_outlet, p_item_type, p_item_id, p_reason, p_qty, v_cost, round(p_qty * v_cost, 2), p_ref_type, p_ref_id, left(p_note, 300),
          (select auth.uid()), (now() at time zone coalesce(v_tz, 'Asia/Jakarta'))::date);
end $$;
revoke all on function app.loss_record(uuid, text, uuid, text, numeric, numeric, text, uuid, text) from public, anon, authenticated;

-- Kategori biaya yang SUDAH masuk HPP (pengaturan kategori_masuk_hpp, dipisah koma), huruf kecil dan dipangkas.
create function app.hpp_cats(p_outlet uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array(
    select lower(trim(x)) from unnest(string_to_array(coalesce(app.setting(p_outlet, 'kategori_masuk_hpp', ''), ''), ',')) as x where trim(x) <> ''
  ), '{}'::text[]);
$$;
revoke all on function app.hpp_cats(uuid) from public, anon, authenticated;

-- Penyetuju masih aktif dan berwenang (owner/admin/supervisor) di outlet ini?
create function app.approver_ok(p_approver uuid, p_outlet uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m join public.profiles pr on pr.id = m.user_id
                 where m.user_id = p_approver and m.status = 'active' and pr.status = 'active'
                   and m.role in ('owner','admin','supervisor') and (m.outlet_id is null or m.outlet_id = p_outlet));
$$;
revoke all on function app.approver_ok(uuid, uuid) from public, anon, authenticated;

-- Sesi kasir tempat uang retur keluar dari laci:
--   1) sesi yang dipilih eksplisit (hanya supervisor ke atas);
--   2) sesi terbuka milik pemanggil di outlet ini (kasir yang melayani retur, juga bila Owner menyetujui dengan PIN-nya);
--   3) supervisor/owner tanpa sesi sendiri: laci kasir asal transaksi bila masih terbuka, atau satu-satunya sesi terbuka di outlet;
--   4) selain itu aturan biasa (wajib buka kasir / buka otomatis).
create function app.return_session(p_outlet uuid, p_uid uuid, p_orig uuid, p_priv boolean, p_pref uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v public.cash_sessions; v_n int;
begin
  if p_pref is not null then
    if not p_priv then raise exception 'Hanya supervisor/owner yang boleh memilih sesi kasir untuk retur.' using errcode = '42501'; end if;
    select * into v from public.cash_sessions where id = p_pref and outlet_id = p_outlet and status = 'open' for share;
    if not found then raise exception 'Sesi kasir yang dipilih tidak aktif di outlet ini.' using errcode = 'P0001'; end if;
    return v.id;
  end if;
  select * into v from public.cash_sessions where cashier_id = p_uid and status = 'open' for share;
  if found then
    if v.outlet_id = p_outlet then return v.id; end if;
    if not p_priv then raise exception 'Sesi kasir Anda masih aktif di outlet lain. Tutup kasir di sana lebih dulu.' using errcode = 'P0001'; end if;
  end if;
  if p_priv then
    select * into v from public.cash_sessions where cashier_id = p_orig and outlet_id = p_outlet and status = 'open' for share;
    if found then return v.id; end if;
    select count(*) into v_n from public.cash_sessions where outlet_id = p_outlet and status = 'open';
    if v_n = 1 then
      select * into v from public.cash_sessions where outlet_id = p_outlet and status = 'open' for share;
      if found then return v.id; end if;
    elsif v_n > 1 then
      raise exception 'Ada beberapa kasir yang sedang buka di outlet ini. Pilih sesi kasir untuk retur ini.' using errcode = 'P0001', hint = 'SESSION_REQUIRED';
    end if;
  end if;
  return app.ensure_session(p_outlet, p_uid);
end $$;
revoke all on function app.return_session(uuid, uuid, uuid, boolean, uuid) from public, anon, authenticated;

-- Baris tabel laporan konsolidasi: label + satu angka per outlet (urutan sama dengan kolom) + total (dijumlah bila tidak diberikan).
create function app.kons_row(p_label text, p_arr jsonb, p_key text, p_total numeric default null) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_array(p_label)
      || coalesce((select jsonb_agg(coalesce((x ->> p_key)::numeric, 0) order by ord)
                     from jsonb_array_elements(p_arr) with ordinality as t(x, ord)), '[]'::jsonb)
      || jsonb_build_array(coalesce(p_total, (select coalesce(sum(coalesce((x ->> p_key)::numeric, 0)), 0) from jsonb_array_elements(p_arr) as t(x))));
$$;
revoke all on function app.kons_row(text, jsonb, text, numeric) from public, anon, authenticated;

-- ---------- Persetujuan sekali pakai: diskon, retur, hapus antrean ----------
-- Dipanggil dengan token PENYETUJU (PIN-nya diverifikasi Auth di klien). Kasir hanya menerima id persetujuan.
--   diskon : amount = nilai diskon yang disetujui (> 0)
--   retur  : ref_id = id transaksi asal; amount = nilai kotor retur maksimum yang disetujui (> 0); berlaku 30 menit
--   hapus  : request_id = request_id transaksi antrean yang dibuang; amount = totalnya (boleh 0)
create or replace function app.approval_issue(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_o public.outlets; v_req text := p ->> 'request_id'; v_amt numeric := coalesce(app.num(p, 'amount', 0), 0);
        v_kind text := coalesce(p ->> 'kind', ''); v_ref uuid := nullif(p ->> 'ref_id', '')::uuid; v_id uuid; v_ttl interval;
begin
  v_o := app.active_outlet(nullif(p ->> 'outlet_id', '')::uuid, 'store');
  perform app.require_role(v_o.id, array['owner','admin','supervisor']);
  if v_kind not in ('diskon','retur','hapus') then raise exception 'Jenis persetujuan tidak dikenal.' using errcode = '22023'; end if;
  if v_req is null or length(trim(v_req)) < 8 then raise exception 'request_id wajib (minimal 8 karakter).' using errcode = '22023'; end if;
  if v_amt < 0 or (v_kind <> 'hapus' and v_amt <= 0) then raise exception 'Nominal persetujuan tidak valid.' using errcode = '22023'; end if;
  if v_kind = 'retur' then
    if v_ref is null or not exists (select 1 from public.sales s where s.id = v_ref and s.outlet_id = v_o.id and s.kind = 'sale' and s.status = 'completed') then
      raise exception 'Transaksi asal retur tidak ditemukan di outlet ini.' using errcode = 'P0001';
    end if;
    v_ttl := interval '30 minutes';
  else
    v_ref := null;
    v_ttl := interval '72 hours';          -- sama dengan jendela client_ts transaksi offline
  end if;
  insert into app.approvals (kind, request_id, outlet_id, approver_id, amount, ref_id, expires_at)
  values (v_kind, v_req, v_o.id, (select auth.uid()), v_amt, v_ref, now() + v_ttl)
  on conflict (kind, request_id) do update
     set approver_id = excluded.approver_id, amount = excluded.amount, outlet_id = excluded.outlet_id, ref_id = excluded.ref_id,
         created_at = now(), expires_at = now() + v_ttl
   where app.approvals.used_at is null
  returning id into v_id;
  if v_id is null then raise exception 'Persetujuan untuk transaksi ini sudah dipakai.' using errcode = 'P0001'; end if;
  perform app.audit(v_o.id, 'approval_issue', 'approvals', v_id::text, null,
                    jsonb_build_object('kind', v_kind, 'amount', v_amt, 'request_id', v_req, 'ref_id', v_ref));
  return jsonb_build_object('approval_id', v_id);
end $$;

-- P0-3: bendera terima_selisih (klien menerima harga server) tidak ikut hash idempotensi, sama seperti client_ts dan kasir_id.
create or replace function app.idem_begin(p_scope text, p_key text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_hash text := md5(coalesce(case when p_scope = 'sale' then p_payload - 'client_ts' - 'kasir_id' - 'terima_selisih' else p_payload end, 'null'::jsonb)::text);
        v_n int; v_row app.idempotency_keys;
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

-- ---------- Retur (P0-1 F-03, P0-2 F-02/F-01) ----------
-- Retur = transaksi BARU bernilai negatif yang menunjuk transaksi asal.
-- F-03: uang retur keluar dari laci kasir yang sedang melayani, jadi sesi/kasir retur = sesi kasir pemanggil (lihat app.return_session).
--       Kasir tanpa hak retur memakai approval_id (sekali pakai) dari supervisor/owner; JWT penyetuju tidak lagi dipakai untuk memanggil RPC ini.
-- F-02: tiap item wajib memilih tindakan barang: restock=true (kembali ke stok jual) atau restock=false (rusak/dibuang: stok tidak bertambah,
--       HPP barang dicatat sebagai kerugian persediaan). Tidak ada nilai bawaan: klien yang tidak memilih ditolak.
create or replace function app.sale_return(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_req text := p ->> 'request_id'; v_dup jsonb;
  v_o public.sales; v_outlet public.outlets;
  v_alasan text := trim(coalesce(p ->> 'alasan', ''));
  v_l record; v_sale uuid := gen_random_uuid(); v_no text; v_seq int; v_local timestamp;
  v_all boolean := coalesce((p ->> 'semua')::boolean, false);
  v_def boolean := case lower(coalesce(p ->> 'restock', '')) when 'true' then true when 'false' then false else null end;
  v_bruto numeric := 0; v_f numeric; v_subR numeric; v_disR numeric; v_taxR numeric; v_feeR numeric; v_totR numeric;
  v_excl boolean; v_final boolean := true; v_stock jsonb := '{}'::jsonb; v_new numeric;
  v_method text; v_session uuid; v_scash uuid; v_res jsonb; v_buang int := 0; v_loss numeric := 0; v_priv boolean;
  v_appr app.approvals; v_approver uuid; v_pref uuid := nullif(p ->> 'sesi_id', '')::uuid;
begin
  if v_uid is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  select * into v_o from public.sales where id = nullif(p ->> 'id', '')::uuid for update;   -- serialisasi retur pada transaksi yang sama
  if not found then raise exception 'Penjualan asal tidak ditemukan.' using errcode = 'P0002'; end if;
  perform app.require_role(v_o.outlet_id, array['owner','admin','supervisor','kasir']);
  v_outlet := app.active_outlet(v_o.outlet_id, 'store');
  v_dup := app.idem_begin('sale_return', v_req, p);
  if v_dup is not null then return v_dup; end if;

  -- Wewenang: supervisor/owner/admin langsung; kasir hanya bila retur_kasir aktif atau membawa persetujuan sekali pakai.
  v_priv := app.has_role(v_o.outlet_id, array['owner','admin','supervisor']);
  if not v_priv and not app.setting_bool(v_o.outlet_id, 'retur_kasir', false) then
    if (p ->> 'approval_id') ~* '^[0-9a-f-]{36}$' then
      select * into v_appr from app.approvals
       where id = (p ->> 'approval_id')::uuid and kind = 'retur' and request_id = v_req and outlet_id = v_o.outlet_id
         and ref_id = v_o.id and used_at is null and expires_at > now() for update;
      if found and app.approver_ok(v_appr.approver_id, v_o.outlet_id) then v_approver := v_appr.approver_id; end if;
    end if;
    if v_approver is null then
      raise exception 'Retur memerlukan persetujuan supervisor/owner.' using errcode = '42501', hint = 'RETUR_APPROVAL';
    end if;
  end if;

  if length(v_alasan) < 3 then raise exception 'Alasan retur wajib diisi.' using errcode = '22023'; end if;
  if v_o.kind <> 'sale' or v_o.status <> 'completed' then raise exception 'Hanya transaksi penjualan selesai yang bisa diretur.' using errcode = 'P0001'; end if;

  create temp table if not exists _rl (variant_id uuid, remaining numeric, price numeric, hpp numeric, sku text, nm text, want numeric, restock boolean) on commit drop;
  truncate _rl;
  insert into _rl (variant_id, remaining, price, hpp, sku, nm)
  select i.variant_id, sum(i.qty), max(i.unit_price) filter (where i.qty > 0), max(i.hpp_snapshot) filter (where i.qty > 0),
         max(i.sku_snapshot), max(i.name_snapshot)
  from public.sale_items i join public.sales s on s.id = i.sale_id
  where s.id = v_o.id or (s.ref_sale_id = v_o.id and s.status = 'completed')
  group by i.variant_id;

  if v_all then
    update _rl set want = remaining, restock = v_def where remaining > 0;
  else
    if jsonb_typeof(p -> 'items') <> 'array' then raise exception 'Pilih minimal satu item yang diretur.' using errcode = '22023'; end if;
    update _rl r set want = x.q, restock = coalesce(x.rs, v_def) from (
      select (e ->> 'variant_id')::uuid as vid, sum((e ->> 'qty')::numeric) as q,
             bool_and(case lower(coalesce(e ->> 'restock', '')) when 'true' then true when 'false' then false end) as rs   -- campuran => false (dibuang)
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
  if exists (select 1 from _rl where want > 0 and restock is null) then
    raise exception 'Pilih tindakan barang retur: kembali ke stok atau rusak/dibuang.' using errcode = '22023', hint = 'RESTOCK_REQUIRED';
  end if;

  select coalesce(sum(price * want), 0) into v_bruto from _rl where want > 0;
  if v_approver is not null then
    if v_appr.amount + 0.5 < v_bruto then
      raise exception 'Nilai retur Rp% melebihi yang disetujui (Rp%).', v_bruto, v_appr.amount using errcode = '42501', hint = 'RETUR_APPROVAL';
    end if;
    update app.approvals set used_at = now() where id = v_appr.id;
  end if;
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
  v_session := app.return_session(v_o.outlet_id, v_uid, v_o.cashier_id, v_priv, v_pref);
  select cs.cashier_id into v_scash from public.cash_sessions cs where cs.id = v_session;
  v_local := now() at time zone v_outlet.timezone;
  v_seq := app.next_seq(v_o.outlet_id, 'return', v_local::date);
  v_no := 'RT-' || v_outlet.code || '-' || to_char(v_local, 'YYMMDD') || '-' || lpad(v_seq::text, 3, '0');

  insert into public.sales (id, outlet_id, receipt_no, request_id, kind, ref_sale_id, channel_id, cashier_id, cash_session_id,
                            status, subtotal, discount, fee_channel, tax_rate, tax_amount, total, payment_method, note, reason, approved_by)
  values (v_sale, v_o.outlet_id, v_no, v_req, 'return', v_o.id, v_o.channel_id, coalesce(v_scash, v_uid), v_session, 'completed',
          -v_subR, -v_disR, -v_feeR, v_o.tax_rate, -v_taxR, -v_totR, v_method,
          left('RETUR ' || v_o.receipt_no || ': ' || v_alasan, 300), v_alasan, coalesce(v_approver, v_uid));

  for v_l in select * from _rl where want > 0 order by variant_id loop
    -- HPP asal tetap dibalik pada baris retur; bila barang tidak kembali ke stok, nilainya diakui sebagai kerugian persediaan (bukan hilang diam-diam).
    insert into public.sale_items (sale_id, outlet_id, variant_id, sku_snapshot, name_snapshot, qty, unit_price, hpp_snapshot)
    values (v_sale, v_o.outlet_id, v_l.variant_id, v_l.sku, v_l.nm, -v_l.want, v_l.price, v_l.hpp);
    if v_l.restock then
      v_new := app.stock_apply(v_o.outlet_id, 'variant', v_l.variant_id, v_l.want, 'return_in', 'sale', v_sale, v_l.hpp, true, null);
      v_stock := v_stock || jsonb_build_object(v_l.variant_id::text, v_new);
    else
      v_buang := v_buang + 1;
      perform app.loss_record(v_o.outlet_id, 'variant', v_l.variant_id, 'retur_rusak', v_l.want, v_l.hpp, 'sale', v_sale, v_alasan);
    end if;
  end loop;
  select coalesce(sum(l.value), 0) into v_loss from public.inventory_losses l where l.ref_type = 'sale' and l.ref_id = v_sale;

  insert into public.payments (sale_id, outlet_id, cash_session_id, method, amount)
  values (v_sale, v_o.outlet_id, v_session, v_method, -v_totR);

  perform app.audit(v_o.outlet_id, 'return', 'sales', v_sale::text, jsonb_build_object('nomor', v_o.receipt_no),
                    jsonb_build_object('nomor', v_no, 'total', -v_totR, 'alasan', v_alasan, 'item_dibuang', v_buang, 'kerugian', v_loss,
                                       'sesi', v_session, 'kasir', coalesce(v_scash, v_uid), 'disetujui_oleh', v_approver));

  v_res := jsonb_build_object('sale', jsonb_build_object('id', v_sale, 'nomor', v_no, 'subtotal', -v_subR, 'diskon', -v_disR,
                                'ppn_nominal', -v_taxR, 'total', -v_totR),
                              'refund', v_totR, 'metode', v_method, 'stok', v_stock, 'restock', v_buang = 0, 'buang', v_buang,
                              'kerugian', v_loss, 'sesi', v_session);
  return app.idem_finish('sale_return', v_req, v_res);
end $$;

-- ---------- sale_create: terima-dengan-tanda (P0-3 F-04) ----------
create or replace function app.sale_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_appr app.approvals; v_approver uuid;
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
  v_accept boolean := false; v_review boolean := false; v_rnote text := '';
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
  -- P0-3 (F-04): transaksi yang tertunda (waktu perangkat valid tetapi lebih dari 3 menit lalu, mis. dibuat saat offline) atau yang kasirnya sengaja memilih
  -- "terima harga server" TIDAK ditolak bila total/stok berbeda: uang dan barang sudah berpindah. Dicatat dengan harga SERVER (klien tidak pernah dipercaya
  -- untuk harga), diberi tanda review_flag, dan total klien tersimpan di client_total untuk ditinjau Owner.
  v_accept := lower(coalesce(p ->> 'terima_selisih', '')) in ('true', '1', 'ya')
              or (v_cts is not null and v_cts <= now() + interval '5 minutes' and v_cts >= now() - interval '72 hours' and v_cts < now() - interval '3 minutes');

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
    -- P1-5: persetujuan yang diterbitkan supervisor/owner (rpc_approval_issue) untuk request_id ini, sekali pakai, masih berlaku, dan penerbitnya
    -- masih berwenang di outlet ini. Tidak ada JWT approver yang perlu disimpan di antrean perangkat.
    if nullif(p ->> 'approval_id', '') is not null and (p ->> 'approval_id') ~* '^[0-9a-f-]{36}$' then
      select * into v_appr from app.approvals
       where id = (p ->> 'approval_id')::uuid and kind = 'diskon' and request_id = v_req and outlet_id = v_outlet.id
         and used_at is null and expires_at > now() and amount + 0.5 >= v_discount for update;
      if found and exists (select 1 from public.memberships m join public.profiles pr on pr.id = m.user_id
                           where m.user_id = v_appr.approver_id and m.status = 'active' and pr.status = 'active'
                             and m.role in ('owner','admin','supervisor') and (m.outlet_id is null or m.outlet_id = v_outlet.id)) then
        v_approver := v_appr.approver_id;
        update app.approvals set used_at = now() where id = v_appr.id;
      end if;
    end if;
    if v_approver is null then
      raise exception 'Diskon Rp% melebihi batas % persen dari subtotal. Perlu supervisor/owner.', v_discount, v_maxpct using errcode = 'P0001';
    end if;
  end if;

  v_rate := coalesce(nullif(app.setting(v_outlet.id, 'ppn_persen', '0'), '')::numeric, 0);
  v_total := v_base;
  if app.setting_bool(v_outlet.id, 'ppn_aktif', false) and v_rate > 0 then
    if app.setting_bool(v_outlet.id, 'ppn_inklusif', false) then v_tax := round(v_base * v_rate / (100 + v_rate));
    else v_tax := round(v_base * v_rate / 100); v_total := v_base + v_tax; end if;
  else v_rate := 0; end if;

  if v_ctotal is not null and abs(v_ctotal - v_total) > 0.5 and app.setting_bool(v_outlet.id, 'tolak_selisih_total', true) then
    if not v_accept then
      raise exception 'Total struk Rp% berbeda dari server Rp% (harga atau pengaturan berubah). Muat ulang data lalu ulangi.', v_ctotal, v_total
        using errcode = 'P0001', hint = 'TOTAL_MISMATCH';
    end if;
    v_review := true;
    v_rnote := trim(v_rnote || ' Total di struk Rp' || v_ctotal || ' berbeda dari harga server Rp' || v_total || ' (harga/pengaturan berubah saat transaksi tertunda); dicatat dengan harga server.');
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
                             null, (not v_noneg) or v_accept, null);
    if v_new < 0 and v_noneg then
      v_review := true;
      v_rnote := trim(v_rnote || ' Stok server kurang untuk ' || v_l.sku || '; stok menjadi minus (perlu opname).');
    end if;
    v_stock := v_stock || jsonb_build_object(v_l.variant_id::text, v_new);
  end loop;

  -- 3) Nomor struk: kode outlet + tanggal lokal outlet + urutan.
  v_local := v_sold at time zone v_outlet.timezone;
  v_seq := app.next_seq(v_outlet.id, 'sale', v_local::date);
  v_no := v_outlet.code || '-' || to_char(v_local, 'YYMMDD') || '-' || lpad(v_seq::text, 3, '0');

  insert into public.sales (id, outlet_id, receipt_no, request_id, kind, channel_id, cashier_id, cash_session_id, status,
                            subtotal, discount, fee_channel, tax_rate, tax_amount, total, payment_method,
                            client_total, client_ts, sold_at, note, approved_by, review_flag, review_note)
  values (v_sale, v_outlet.id, v_no, v_req, 'sale', v_channel.id, v_cashier, v_session, 'completed',
          v_subtotal, v_discount, v_fee, v_rate, v_tax, v_total, v_method, v_ctotal, v_cts, v_sold, v_note,
          coalesce(v_approver, case when v_cashier <> v_uid then v_uid end), v_review, nullif(v_rnote, ''));

  insert into public.sale_items (sale_id, outlet_id, variant_id, sku_snapshot, name_snapshot, qty, unit_price, hpp_snapshot)
  select v_sale, v_outlet.id, s.variant_id, s.sku, s.nm, s.qty, s.price, nullif(b.avg_cost, 0)
  from _sl s join public.inventory_balances b on b.outlet_id = v_outlet.id and b.variant_id = s.variant_id;

  insert into public.payments (sale_id, outlet_id, cash_session_id, method, amount, received, change_given)
  values (v_sale, v_outlet.id, v_session, v_method, v_total, v_recv, v_change);

  perform app.audit(v_outlet.id, 'sale', 'sales', v_sale::text, null,
                    jsonb_build_object('nomor', v_no, 'total', v_total, 'metode', v_method, 'kasir', v_cashier, 'review', v_review));

  v_res := jsonb_build_object(
    'sale', jsonb_build_object('id', v_sale, 'nomor', v_no, 'outlet_id', v_outlet.id,
                               'tanggal', to_char(v_local, 'YYYY-MM-DD HH24:MI:SS'),
                               'subtotal', v_subtotal, 'diskon', v_discount, 'ppn_nominal', v_tax, 'total', v_total),
    'stok', v_stock, 'diterima', v_recv, 'kembalian', v_change, 'sesi', v_session, 'review', v_review);
  if v_review then v_res := v_res || jsonb_build_object('peringatan', 'Transaksi tercatat dengan tanda "perlu ditinjau":' || ' ' || v_rnote); end if;
  return app.idem_finish('sale', v_req, v_res);
end $$;

-- Owner/admin/supervisor menandai transaksi bertanda "perlu ditinjau" sebagai sudah ditinjau (angka transaksi tidak diubah).
create function app.sale_review(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.sales;
begin
  if (select auth.uid()) is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  select * into v from public.sales where id = nullif(p ->> 'id', '')::uuid for update;
  if not found then raise exception 'Transaksi tidak ditemukan.' using errcode = 'P0002'; end if;
  perform app.require_role(v.outlet_id, array['owner','admin','supervisor']);
  if not v.review_flag then return jsonb_build_object('id', v.id, 'review', false, 'noop', true); end if;
  update public.sales set review_flag = false, reviewed_by = (select auth.uid()), reviewed_at = now() where id = v.id;
  perform app.audit(v.outlet_id, 'sale_review', 'sales', v.id::text, jsonb_build_object('catatan', v.review_note),
                    jsonb_build_object('catatan_peninjau', left(coalesce(p ->> 'catatan', ''), 300), 'total', v.total, 'client_total', v.client_total));
  return jsonb_build_object('id', v.id, 'review', false);
end $$;

create or replace function app.sales_list(p jsonb) returns jsonb
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
      'catatan', s.note, 'ref_sale_id', s.ref_sale_id, 'outlet_id', s.outlet_id,
      'review', s.review_flag, 'review_note', s.review_note) as x
    from public.sales s where s.outlet_id = v_o.id and s.sold_at >= v_from and s.sold_at < v_to and (v_all or s.cashier_id = (select auth.uid()))
    order by s.sold_at desc limit v_lim offset v_off) q;
  select jsonb_build_object('omzet', coalesce(sum(s.total), 0), 'nTrx', count(*) filter (where s.kind = 'sale'), 'nDone', count(*))
    into v_sum from public.sales s where s.outlet_id = v_o.id and s.status = 'completed' and s.sold_at >= v_from and s.sold_at < v_to and (v_all or s.cashier_id = (select auth.uid()));
  return jsonb_build_object('rows', v_rows, 'total', v_total, 'offset', v_off, 'summary', v_sum);
end $$;

-- ---------- sale_reject_log: persetujuan untuk hapus (P0-3) ----------
create or replace function app.sale_reject_log(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_o uuid := nullif(p ->> 'outlet_id', '')::uuid; v_req text := left(coalesce(p ->> 'request_id', ''), 80);
        v_why text := left(coalesce(p ->> 'alasan', ''), 300); v_aksi text := coalesce(nullif(p ->> 'aksi', ''), 'hapus');
        v_appr app.approvals; v_approver uuid;
begin
  if v_uid is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  if v_o is null then raise exception 'Outlet wajib diisi.' using errcode = '22023'; end if;
  perform app.require_role(v_o, array['owner','admin','supervisor','kasir']);
  if length(v_req) < 8 then raise exception 'request_id wajib (minimal 8 karakter).' using errcode = '22023'; end if;
  if v_aksi not in ('hapus','tinjau') then raise exception 'Aksi tidak dikenal.' using errcode = '22023'; end if;
  -- P0-3: kasir tidak boleh membuang transaksi antrean sendirian (uang pelanggan mungkin sudah diterima): wajib persetujuan supervisor/owner (sekali pakai).
  if v_aksi = 'hapus' and not app.has_role(v_o, array['owner','admin','supervisor']) then
    if (p ->> 'approval_id') ~* '^[0-9a-f-]{36}$' then
      select * into v_appr from app.approvals
       where id = (p ->> 'approval_id')::uuid and kind = 'hapus' and request_id = (p ->> 'request_id') and outlet_id = v_o
         and used_at is null and expires_at > now() for update;
      if found and app.approver_ok(v_appr.approver_id, v_o) then
        v_approver := v_appr.approver_id;
        update app.approvals set used_at = now() where id = v_appr.id;
      end if;
    end if;
    if v_approver is null then
      raise exception 'Menghapus transaksi antrean memerlukan persetujuan supervisor/owner.' using errcode = '42501', hint = 'HAPUS_APPROVAL';
    end if;
  end if;
  perform app.audit(v_o, 'sale_queue_' || v_aksi, 'sales_queue', v_req, null,
    jsonb_build_object('alasan', v_why, 'total', app.num(p, 'total'), 'nomor', left(coalesce(p ->> 'nomor', ''), 40), 'galat', left(coalesce(p ->> 'galat', ''), 300), 'disetujui_oleh', v_approver));
  return jsonb_build_object('logged', true);
end $$;

-- ---------- Kas masuk/keluar laci (P0-4 F-05) ----------
-- Kas keluar wajib berkategori dan otomatis menjadi biaya (public.expenses) pada outlet sesi, di transaksi yang sama.
-- Biaya itu tidak dihitung dua kali: laporan biaya hanya membaca expenses; cash_movements hanya memengaruhi kas diharapkan.
-- request_id (opsional) membuat pengiriman ulang setelah timeout aman.
create or replace function app.cash_movement_add(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v public.cash_sessions; v_id uuid; v_amt numeric := app.num(p, 'nominal');
        v_kind text := coalesce(p ->> 'jenis', 'out'); v_cat text := trim(coalesce(p ->> 'kategori', '')); v_reason text := trim(coalesce(p ->> 'alasan', ''));
        v_req text := nullif(trim(coalesce(p ->> 'request_id', '')), ''); v_dup jsonb; v_exp uuid; v_tz text; v_date date;
begin
  if v_uid is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  select * into v from public.cash_sessions where cashier_id = v_uid and status = 'open' for update;
  if not found then raise exception 'Tidak ada sesi kasir aktif.' using errcode = 'P0001'; end if;
  perform app.require_role(v.outlet_id, array['owner','admin','supervisor','kasir']);
  if v_req is not null then
    v_dup := app.idem_begin('cash_move', v_req, p);
    if v_dup is not null then return v_dup; end if;
  end if;
  if v_kind not in ('in','out') or v_amt is null or v_amt <= 0 then raise exception 'Nominal atau jenis kas tidak valid.' using errcode = '22023'; end if;
  if length(v_reason) < 3 then raise exception 'Alasan wajib diisi.' using errcode = '22023'; end if;
  if v_kind = 'out' then
    if length(v_cat) < 2 then raise exception 'Pilih kategori biaya untuk kas keluar.' using errcode = '22023', hint = 'CATEGORY_REQUIRED'; end if;
    select o.timezone into v_tz from public.outlets o where o.id = v.outlet_id;
    v_date := (now() at time zone coalesce(v_tz, 'Asia/Jakarta'))::date;
    insert into public.expenses (outlet_id, category, amount, expense_date, note, user_id, cash_session_id, request_id)
    values (v.outlet_id, v_cat, v_amt, v_date, v_reason, v_uid, v.id, case when v_req is not null then 'cm:' || v_req end)
    returning id into v_exp;
  end if;
  insert into public.cash_movements (outlet_id, cash_session_id, kind, amount, reason, user_id, category, expense_id)
  values (v.outlet_id, v.id, v_kind, v_amt, v_reason, v_uid, case when v_kind = 'out' then v_cat end, v_exp) returning id into v_id;
  perform app.audit(v.outlet_id, 'cash_' || v_kind, 'cash_movements', v_id::text, null,
                    jsonb_build_object('nominal', v_amt, 'alasan', v_reason, 'kategori', case when v_kind = 'out' then v_cat end, 'expense_id', v_exp));
  return case when v_req is not null
              then app.idem_finish('cash_move', v_req, jsonb_build_object('id', v_id, 'expense_id', v_exp))
              else jsonb_build_object('id', v_id, 'expense_id', v_exp) end;
end $$;

-- ---------- stock_adjust: kerugian opname (P0-2 F-01) ----------
create or replace function app.stock_adjust(p jsonb) returns jsonb
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
    -- F-01: selisih opname (setelah saldo pembukaan) diakui sebagai kerugian persediaan; selisih lebih bernilai minus (neto).
    if not v_first then
      perform app.loss_record(v_o.id, v_type, v_id, 'opname', v_old - v_new, coalesce(v_hpp, v_cost), 'adjust', null, v_alasan);
    end if;
  elsif v_hpp is not null then
    if v_type = 'variant' then update public.inventory_balances set avg_cost = v_hpp, updated_at = now() where outlet_id = v_o.id and variant_id = v_id;
    else update public.inventory_material_balances set avg_cost = v_hpp, updated_at = now() where outlet_id = v_o.id and material_id = v_id; end if;
    v_res := v_old;
  else v_res := v_old; end if;
  perform app.audit(v_o.id, case when v_first then 'stock_opening' else 'opname' end, v_type, v_id::text,
                    jsonb_build_object('stok', v_old, 'hpp', v_cost), jsonb_build_object('stok', v_new, 'hpp', coalesce(v_hpp, v_cost), 'alasan', v_alasan));
  return jsonb_build_object('id', v_id, 'stok', v_res, 'hpp_rata2', coalesce(v_hpp, v_cost));
end $$;

-- ---------- transfer_action: kerugian selisih transfer (P0-2 F-01) ----------
create or replace function app.transfer_action(p jsonb) returns jsonb
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
      -- F-01/F-12: barang yang dikirim tetapi tidak diterima diakui sebagai kerugian persediaan outlet PENERIMA (yang menghitung penerimaan menanggungnya).
      if v_rc < v_i.qty_sent - 0.0001 then
        perform app.loss_record(v.to_outlet_id, v_i.item_type, v_i.item_id, 'selisih_transfer', v_i.qty_sent - v_rc, v_i.unit_cost, 'transfer', v.id, 'Selisih transfer ' || v.number);
      end if;
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

-- ---------- dashboard: kebijakan F-06 + kerugian persediaan + jumlah transaksi bertanda ----------
create or replace function app.dashboard(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_o public.outlets; v_per text := coalesce(nullif(p ->> 'period', ''), 'hari');
  v_today date; v_from date; v_to date; v_pfrom date; v_pto date; v_sfrom date;
  v_cur jsonb; v_prev jsonb; v_series jsonb; v_ch jsonb; v_top jsonb; v_low jsonb; v_neg jsonb;
  v_fee numeric; v_biaya numeric; v_laba numeric; v_loss numeric; v_rev bigint;
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

  -- F-06: biaya pada kategori "sudah masuk HPP" tidak dikurangkan lagi. F-01: kerugian persediaan mengurangi laba.
  select coalesce(sum(e.amount), 0) into v_biaya from public.expenses e
    where e.outlet_id = v_o.id and e.expense_date between v_from and v_to and lower(trim(e.category)) <> all (app.hpp_cats(v_o.id));
  select coalesce(sum(l.value), 0) into v_loss from public.inventory_losses l
    where l.outlet_id = v_o.id and l.loss_date between v_from and v_to;
  select count(*) into v_rev from public.sales s where s.outlet_id = v_o.id and s.review_flag;
  v_laba := (v_cur ->> 'laba')::numeric - v_fee - v_biaya - v_loss;

  return jsonb_build_object('period', v_per, 'outlet_id', v_o.id, 'from', v_from, 'to', v_to, 'pfrom', v_pfrom, 'pto', v_pto,
    'cur', v_cur, 'prev', v_prev, 'series', v_series, 'channels', v_ch, 'top', v_top, 'low', v_low, 'stok_minus', v_neg,
    'peringatan', '[]'::jsonb, 'biaya', v_biaya, 'fee_channel', v_fee, 'laba_bersih', v_laba,
    'kerugian', v_loss, 'review_trx', v_rev);
end $$;

-- ---------- report_legacy: laba rugi (F-06 + kerugian persediaan) dan laporan biaya ----------
create or replace function app.report_legacy(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_o public.outlets; v_type text := coalesce(p ->> 'type', 'labarugi'); v_role text; v_cost boolean;
  v_today date; v_from date; v_to date; v_title text; v_cols jsonb; v_fmt jsonb; v_rows jsonb := '[]'::jsonb; v_sum jsonb := '[]'::jsonb;
  v_om numeric; v_hpp numeric; v_fee numeric; v_exp numeric; v_miss bigint; v_warn text := null; v_n numeric; v_t numeric;
  v_cats text[]; v_exc numeric; v_loss numeric;
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
    v_cats := app.hpp_cats(v_o.id);
    select coalesce(sum(f.om), 0), coalesce(sum(f.hpp), 0), coalesce(sum(f.fee), 0), coalesce(sum(f.hpp_missing), 0)
      into v_om, v_hpp, v_fee, v_miss from app.sales_facts(v_o.id, v_from, v_to) f;
    -- F-06: kategori yang tercatat "sudah masuk HPP" (pengaturan kategori_masuk_hpp) tidak dikurangkan lagi dari laba.
    select coalesce(sum(e.amount) filter (where lower(trim(e.category)) <> all (v_cats)), 0), coalesce(sum(e.amount) filter (where lower(trim(e.category)) = any (v_cats)), 0)
      into v_exp, v_exc from public.expenses e where e.outlet_id = v_o.id and e.expense_date between v_from and v_to;
    -- F-01: kerugian persediaan (opname, retur rusak/dibuang, selisih transfer).
    select coalesce(sum(l.value), 0) into v_loss from public.inventory_losses l where l.outlet_id = v_o.id and l.loss_date between v_from and v_to;
    v_rows := jsonb_build_array(jsonb_build_array('Omzet (tanpa PPN, setelah retur)', v_om), jsonb_build_array('HPP', v_hpp),
      jsonb_build_array('Laba kotor', v_om - v_hpp), jsonb_build_array('Fee channel', v_fee));
    v_rows := v_rows || coalesce((select jsonb_agg(jsonb_build_array('Biaya: ' || q.category, q.t) order by q.t desc)
      from (select e.category, sum(e.amount) as t from public.expenses e
             where e.outlet_id = v_o.id and e.expense_date between v_from and v_to and lower(trim(e.category)) <> all (v_cats) group by e.category) q), '[]'::jsonb);
    v_rows := v_rows || coalesce((select jsonb_agg(jsonb_build_array('Kerugian persediaan: ' || case q.reason when 'opname' then 'selisih opname (neto)'
                                       when 'retur_rusak' then 'retur rusak/dibuang' when 'selisih_transfer' then 'selisih transfer' else 'barang rusak/dibuang' end, q.t) order by q.t desc)
      from (select l.reason, sum(l.value) as t from public.inventory_losses l
             where l.outlet_id = v_o.id and l.loss_date between v_from and v_to group by l.reason having sum(l.value) <> 0) q), '[]'::jsonb);
    v_rows := v_rows || jsonb_build_array(jsonb_build_array('Laba bersih', v_om - v_hpp - v_fee - v_exp - v_loss));
    v_sum := jsonb_build_array(jsonb_build_object('label', 'Omzet', 'value', v_om, 'fmt', 'rp'), jsonb_build_object('label', 'Laba kotor', 'value', v_om - v_hpp, 'fmt', 'rp'),
      jsonb_build_object('label', 'Laba bersih', 'value', v_om - v_hpp - v_fee - v_exp - v_loss, 'fmt', 'rp'),
      jsonb_build_object('label', 'Margin kotor', 'value', case when v_om > 0 then round((v_om - v_hpp) / v_om * 100, 1) else 0 end, 'fmt', 'pct'));
    if v_miss > 0 then v_warn := v_miss || ' baris penjualan belum punya HPP; laba kotor bisa terlalu tinggi.'; end if;
    if v_exc > 0 then
      v_warn := trim(coalesce(v_warn || ' ', '') || 'Biaya Rp' || round(v_exc)::text || ' pada kategori "sudah masuk HPP" (Pengaturan) tidak dikurangkan lagi dari laba.');
    end if;

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
    select coalesce(sum(e.amount), 0), coalesce(sum(e.amount) filter (where lower(trim(e.category)) = any (app.hpp_cats(v_o.id))), 0)
      into v_n, v_t from public.expenses e where e.outlet_id = v_o.id and e.expense_date between v_from and v_to;
    v_sum := jsonb_build_array(jsonb_build_object('label', 'Total biaya', 'value', v_n, 'fmt', 'rp'));
    if v_t > 0 then
      v_sum := v_sum || jsonb_build_array(jsonb_build_object('label', 'Sudah masuk HPP (tidak dikurangkan dari laba)', 'value', v_t, 'fmt', 'rp'));
    end if;
  end if;

  return jsonb_build_object('type', v_type, 'title', v_title, 'from', v_from, 'to', v_to, 'outlet_id', v_o.id,
    'columns', v_cols, 'fmt', v_fmt, 'rows', v_rows, 'summary', v_sum, 'peringatan', v_warn);
end $$;

-- ---------- Laba rugi konsolidasi (menggantikan versi lama; mengikuti kebijakan F-06 dan memuat kerugian persediaan) ----------
create or replace function app.report_pnl(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_o uuid := nullif(p ->> 'outlet_id', '')::uuid; v_from date := coalesce(nullif(p ->> 'from', '')::date, current_date);
        v_to date := coalesce(nullif(p ->> 'to', '')::date, current_date); v_s jsonb; v_exp numeric; v_cen numeric; v_cat jsonb; v_net numeric; v_hpp numeric; v_fee numeric; v_loss numeric;
begin
  if v_o is null then perform app.require_role(null, array['owner','admin','auditor']); else perform app.require_role(v_o, array['owner','admin','auditor']); end if;
  v_s := app.report_sales(p);
  select coalesce(sum(e.amount), 0) into v_exp from public.expenses e
   where e.outlet_id is not null and (v_o is null or e.outlet_id = v_o) and e.expense_date between v_from and v_to
     and lower(trim(e.category)) <> all (app.hpp_cats(e.outlet_id));
  select coalesce(sum(e.amount), 0) into v_cen from public.expenses e
   where e.outlet_id is null and v_o is null and e.expense_date between v_from and v_to
     and lower(trim(e.category)) <> all (app.hpp_cats(null::uuid));
  select coalesce(sum(l.value), 0) into v_loss from public.inventory_losses l
   where (v_o is null or l.outlet_id = v_o) and l.loss_date between v_from and v_to;
  select coalesce(jsonb_agg(jsonb_build_object('kategori', category, 'nominal', t)), '[]'::jsonb) into v_cat from (
    select e.category, sum(e.amount) t from public.expenses e
     where (v_o is null or e.outlet_id = v_o or (e.outlet_id is null and v_o is null)) and e.expense_date between v_from and v_to
       and lower(trim(e.category)) <> all (app.hpp_cats(e.outlet_id))
     group by e.category order by 2 desc) e;
  v_net := (v_s -> 'total' ->> 'penjualan_bersih')::numeric - (v_s -> 'total' ->> 'pajak')::numeric;
  v_hpp := (v_s -> 'total' ->> 'hpp')::numeric; v_fee := (v_s -> 'total' ->> 'fee_channel')::numeric;
  return jsonb_build_object('from', v_from, 'to', v_to, 'omzet_bersih_tanpa_pajak', v_net, 'hpp', v_hpp, 'fee_channel', v_fee, 'biaya_outlet', v_exp, 'biaya_pusat', v_cen,
    'kerugian_persediaan', v_loss,
    'laba_outlet', v_net - v_hpp - v_fee - v_exp - v_loss, 'laba_setelah_biaya_pusat', v_net - v_hpp - v_fee - v_exp - v_loss - v_cen,
    'per_kategori_biaya', v_cat, 'hpp_lengkap', (v_s -> 'total' ->> 'baris_tanpa_hpp')::numeric = 0, 'baris_tanpa_hpp', v_s -> 'total' -> 'baris_tanpa_hpp');
end $$;

-- ---------- Laporan semua outlet (P0-6 F-07) ----------
-- Keluaran berbentuk sama dengan report_legacy (columns/fmt/rows/summary/peringatan) sehingga layar Laporan yang ada dapat menampilkannya.
-- Angka per outlet memakai sales_facts yang sama dengan laba rugi per outlet, jadi total konsolidasi = jumlah laporan tiap outlet.
--   type 'konsolidasi'      : laba rugi, satu kolom per outlet + Total, ditambah biaya pusat (tidak dialokasikan otomatis)
--   type 'konsolidasi_stok' : nilai persediaan per outlet + barang dalam perjalanan (transfer terkirim, belum diterima)
-- Hanya keanggotaan GLOBAL owner/admin/auditor.
create function app.report_konsolidasi(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_type text := coalesce(p ->> 'type', 'konsolidasi');
  v_from date := coalesce(nullif(p ->> 'from', '')::date, current_date); v_to date := coalesce(nullif(p ->> 'to', '')::date, current_date);
  v_arr jsonb; v_cols jsonb; v_fmt jsonb; v_rows jsonb := '[]'::jsonb; v_sum jsonb := '[]'::jsonb; v_warn text := null; v_title text;
  v_om numeric; v_hpp numeric; v_fee numeric; v_exp numeric; v_exc numeric; v_loss numeric; v_cen numeric; v_miss numeric; v_n numeric; v_nb numeric; v_tr numeric;
begin
  perform app.require_role(null, array['owner','admin','auditor']);
  if v_type not in ('konsolidasi','konsolidasi_stok') then raise exception 'Jenis laporan tidak dikenal: %', v_type using errcode = '22023'; end if;
  if v_to < v_from or v_to - v_from > 400 then raise exception 'Rentang tanggal tidak valid (maksimal 400 hari).' using errcode = '22023'; end if;

  if v_type = 'konsolidasi' then
    v_title := 'Laba rugi semua outlet';
    select coalesce(jsonb_agg(jsonb_build_object('kode', r.code, 'om', r.om, 'hpp', r.hpp, 'lk', r.om - r.hpp, 'fee', r.fee, 'biaya', r.biaya, 'rugi', r.rugi,
                    'laba', r.om - r.hpp - r.fee - r.biaya - r.rugi, 'miss', r.miss, 'exc', r.exc) order by r.code), '[]'::jsonb)
      into v_arr from (
        select o.code, x.om, x.hpp, x.fee, x.miss, e.biaya, e.exc, l.rugi
        from public.outlets o
        cross join lateral (select coalesce(sum(f.om), 0) as om, coalesce(sum(f.hpp), 0) as hpp, coalesce(sum(f.fee), 0) as fee, coalesce(sum(f.hpp_missing), 0) as miss
                              from app.sales_facts(o.id, v_from, v_to) f) x
        cross join lateral (select coalesce(sum(ex.amount) filter (where lower(trim(ex.category)) <> all (app.hpp_cats(o.id))), 0) as biaya,
                                   coalesce(sum(ex.amount) filter (where lower(trim(ex.category)) = any (app.hpp_cats(o.id))), 0) as exc
                              from public.expenses ex where ex.outlet_id = o.id and ex.expense_date between v_from and v_to) e
        cross join lateral (select coalesce(sum(il.value), 0) as rugi from public.inventory_losses il
                             where il.outlet_id = o.id and il.loss_date between v_from and v_to) l
        where o.status = 'active' or x.om <> 0 or e.biaya <> 0 or l.rugi <> 0) r;
    select coalesce(sum(ex.amount) filter (where lower(trim(ex.category)) <> all (app.hpp_cats(null::uuid))), 0),
           coalesce(sum(ex.amount) filter (where lower(trim(ex.category)) = any (app.hpp_cats(null::uuid))), 0)
      into v_cen, v_n from public.expenses ex where ex.outlet_id is null and ex.expense_date between v_from and v_to;
    select coalesce(sum((x ->> 'om')::numeric), 0), coalesce(sum((x ->> 'hpp')::numeric), 0), coalesce(sum((x ->> 'fee')::numeric), 0),
           coalesce(sum((x ->> 'biaya')::numeric), 0), coalesce(sum((x ->> 'rugi')::numeric), 0), coalesce(sum((x ->> 'miss')::numeric), 0),
           coalesce(sum((x ->> 'exc')::numeric), 0)
      into v_om, v_hpp, v_fee, v_exp, v_loss, v_miss, v_exc from jsonb_array_elements(v_arr) x;
    v_exc := v_exc + v_n;
    v_cols := jsonb_build_array('Komponen') || coalesce((select jsonb_agg(x ->> 'kode' order by ord) from jsonb_array_elements(v_arr) with ordinality as t(x, ord)), '[]'::jsonb) || jsonb_build_array('Total');
    v_fmt := jsonb_build_array('txt') || coalesce((select jsonb_agg('rp'::text) from jsonb_array_elements(v_arr)), '[]'::jsonb) || jsonb_build_array('rp');
    v_rows := jsonb_build_array(
      app.kons_row('Omzet (tanpa PPN, setelah retur)', v_arr, 'om'),
      app.kons_row('HPP', v_arr, 'hpp'),
      app.kons_row('Laba kotor', v_arr, 'lk'),
      app.kons_row('Fee channel', v_arr, 'fee'),
      app.kons_row('Biaya operasional', v_arr, 'biaya'),
      app.kons_row('Kerugian persediaan', v_arr, 'rugi'),
      app.kons_row('Laba outlet', v_arr, 'laba'),
      app.kons_row('Biaya pusat (tidak dialokasikan)', v_arr, 'nol', v_cen),
      app.kons_row('Laba setelah biaya pusat', v_arr, 'nol', v_om - v_hpp - v_fee - v_exp - v_loss - v_cen));
    v_sum := jsonb_build_array(
      jsonb_build_object('label', 'Omzet', 'value', v_om, 'fmt', 'rp'),
      jsonb_build_object('label', 'Laba kotor', 'value', v_om - v_hpp, 'fmt', 'rp'),
      jsonb_build_object('label', 'Laba setelah biaya pusat', 'value', v_om - v_hpp - v_fee - v_exp - v_loss - v_cen, 'fmt', 'rp'),
      jsonb_build_object('label', 'Margin kotor', 'value', case when v_om > 0 then round((v_om - v_hpp) / v_om * 100, 1) else 0 end, 'fmt', 'pct'));
    if v_miss > 0 then v_warn := round(v_miss)::text || ' baris penjualan belum punya HPP; laba kotor bisa terlalu tinggi.'; end if;
    if v_exc > 0 then
      v_warn := trim(coalesce(v_warn || ' ', '') || 'Biaya Rp' || round(v_exc)::text || ' pada kategori "sudah masuk HPP" (Pengaturan) tidak dikurangkan lagi dari laba.');
    end if;

  else  -- konsolidasi_stok
    v_title := 'Nilai stok semua outlet';
    select coalesce(jsonb_agg(jsonb_build_object('kode', r.code, 'pj', r.pj, 'bh', r.bh, 'tot', r.pj + r.bh, 'menipis', r.menipis, 'minus', r.minus) order by r.code), '[]'::jsonb)
      into v_arr from (
        select o.code,
          coalesce((select sum(b.quantity * b.avg_cost) from public.inventory_balances b where b.outlet_id = o.id), 0) as pj,
          coalesce((select sum(b.quantity * b.avg_cost) from public.inventory_material_balances b where b.outlet_id = o.id), 0) as bh,
          (select count(*) from public.inventory_balances b where b.outlet_id = o.id and b.min_qty > 0 and b.quantity <= b.min_qty) as menipis,
          (select count(*) from public.inventory_balances b where b.outlet_id = o.id and b.quantity < 0)
            + (select count(*) from public.inventory_material_balances b where b.outlet_id = o.id and b.quantity < 0) as minus
        from public.outlets o where o.status = 'active') r;
    select coalesce(sum(i.qty_sent * coalesce(i.unit_cost, 0)), 0) into v_tr
      from public.stock_transfer_items i join public.stock_transfers t on t.id = i.transfer_id where t.status = 'sent';
    v_cols := '["Outlet","Nilai produk jadi","Nilai bahan","Total nilai stok","Produk menipis","Stok minus"]'::jsonb;
    v_fmt := '["txt","rp","rp","rp","num","num"]'::jsonb;
    select coalesce(jsonb_agg(jsonb_build_array(x ->> 'kode', (x ->> 'pj')::numeric, (x ->> 'bh')::numeric, (x ->> 'tot')::numeric, (x ->> 'menipis')::numeric, (x ->> 'minus')::numeric)
                              order by ord), '[]'::jsonb)
      into v_rows from jsonb_array_elements(v_arr) with ordinality as t(x, ord);
    v_rows := v_rows || jsonb_build_array(jsonb_build_array('Dalam perjalanan (transfer terkirim, belum diterima)', 0, 0, v_tr, 0, 0));
    select coalesce(sum((x ->> 'pj')::numeric), 0), coalesce(sum((x ->> 'bh')::numeric), 0), coalesce(sum((x ->> 'minus')::numeric), 0)
      into v_om, v_hpp, v_nb from jsonb_array_elements(v_arr) x;
    v_rows := v_rows || jsonb_build_array(jsonb_build_array('TOTAL', v_om, v_hpp, v_om + v_hpp + v_tr, 0, v_nb));
    v_sum := jsonb_build_array(
      jsonb_build_object('label', 'Nilai produk jadi', 'value', v_om, 'fmt', 'rp'),
      jsonb_build_object('label', 'Nilai bahan', 'value', v_hpp, 'fmt', 'rp'),
      jsonb_build_object('label', 'Dalam perjalanan', 'value', v_tr, 'fmt', 'rp'),
      jsonb_build_object('label', 'Total nilai stok', 'value', v_om + v_hpp + v_tr, 'fmt', 'rp'));
    if v_nb > 0 then v_warn := round(v_nb)::text || ' item bersaldo minus; nilai stok bisa kurang dari kenyataan. Lakukan opname.'; end if;
  end if;

  return jsonb_build_object('type', v_type, 'title', v_title, 'from', v_from, 'to', v_to, 'outlet_id', null,
    'columns', v_cols, 'fmt', v_fmt, 'rows', v_rows, 'summary', v_sum, 'peringatan', v_warn);
end $$;

-- ---------- Kontrak klien: retur dan kas keluar berubah, klien < 2.4.0 harus diperbarui ----------
create or replace function public.rpc_schema_version(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    execute 'select max(version) from supabase_migrations.schema_migrations' into v;
  end if;
  return jsonb_build_object('version', coalesce(v, 'unknown'), 'min_client', '2.4.0');
end $$;

-- ---------- Pembungkus RPC publik + hak eksekusi untuk fungsi baru ----------
do $$ declare n text; begin
  foreach n in array array['sale_review','report_konsolidasi'] loop
    execute format('create or replace function public.rpc_%1$s(p jsonb default ''{}''::jsonb) returns jsonb language sql security invoker set search_path = '''' as $f$ select app.%1$s(p) $f$', n);
    execute format('revoke all on function public.rpc_%1$s(jsonb) from public, anon', n);
    execute format('grant execute on function public.rpc_%1$s(jsonb) to authenticated', n);
    execute format('revoke all on function app.%1$s(jsonb) from public, anon', n);
    execute format('grant execute on function app.%1$s(jsonb) to authenticated', n);
  end loop;
end $$;
