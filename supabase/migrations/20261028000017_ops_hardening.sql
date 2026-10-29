-- 0017 Pengerasan operasional (P1-1, P1-2, P1-5).
-- P1-2  hash idempotensi 'sale' mengabaikan client_ts DAN kasir_id: kiriman ulang oleh Owner (ambil-alih antrean) tidak lagi bentrok 23505.
-- P1-1  retensi app.idempotency_keys (+ approvals) lewat app.purge_idempotency(), dijadwalkan pg_cron bila tersedia.
-- P1-5  persetujuan diskon yang diterbitkan server (app.approvals) menggantikan JWT approver yang sebelumnya ikut tersimpan di antrean perangkat.

-- ---------- P1-2: hash idempotensi ----------
-- Sengaja tidak mengembalikan hasil lama untuk request_id sama + payload BERBEDA: kiriman dengan isi lain tetapi id sama adalah bug klien,
-- dan menjawab "sukses" akan menghilangkan transaksi kedua tanpa jejak. Klien memulihkan kasus langka itu lewat sale.lookup.
create or replace function app.idem_begin(p_scope text, p_key text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_hash text := md5(coalesce(case when p_scope = 'sale' then p_payload - 'client_ts' - 'kasir_id' else p_payload end, 'null'::jsonb)::text);
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

-- ---------- P1-5: persetujuan diskon ----------
create table app.approvals (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('diskon')),
  request_id text not null,
  outlet_id uuid not null references public.outlets(id),
  approver_id uuid not null references public.profiles(id),
  amount numeric(16,2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '72 hours',   -- sama dengan jendela client_ts transaksi offline
  used_at timestamptz,
  unique (kind, request_id)
);
create index approvals_age on app.approvals (created_at);

-- Dipanggil dengan token PENYETUJU (PIN-nya diverifikasi Auth di klien), bukan token kasir. Kasir hanya menerima id persetujuan.
create function app.approval_issue(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_o public.outlets; v_req text := p ->> 'request_id'; v_amt numeric := app.num(p, 'amount'); v_id uuid;
begin
  v_o := app.active_outlet(nullif(p ->> 'outlet_id', '')::uuid, 'store');
  perform app.require_role(v_o.id, array['owner','admin','supervisor']);
  if coalesce(p ->> 'kind', '') <> 'diskon' then raise exception 'Jenis persetujuan tidak dikenal.' using errcode = '22023'; end if;
  if v_req is null or length(trim(v_req)) < 8 then raise exception 'request_id wajib (minimal 8 karakter).' using errcode = '22023'; end if;
  if v_amt is null or v_amt <= 0 then raise exception 'Nominal persetujuan tidak valid.' using errcode = '22023'; end if;
  insert into app.approvals (kind, request_id, outlet_id, approver_id, amount)
  values ('diskon', v_req, v_o.id, (select auth.uid()), v_amt)
  on conflict (kind, request_id) do update
     set approver_id = excluded.approver_id, amount = excluded.amount, outlet_id = excluded.outlet_id, created_at = now(), expires_at = now() + interval '72 hours'
   where app.approvals.used_at is null
  returning id into v_id;
  if v_id is null then raise exception 'Persetujuan untuk transaksi ini sudah dipakai.' using errcode = 'P0001'; end if;
  perform app.audit(v_o.id, 'approval_issue', 'approvals', v_id::text, null, jsonb_build_object('kind', 'diskon', 'amount', v_amt, 'request_id', v_req));
  return jsonb_build_object('approval_id', v_id);
end $$;
create function public.rpc_approval_issue(p jsonb default '{}'::jsonb) returns jsonb language sql security invoker set search_path = '' as $f$ select app.approval_issue(p) $f$;
revoke all on function public.rpc_approval_issue(jsonb) from public, anon;
grant execute on function public.rpc_approval_issue(jsonb) to authenticated;
revoke all on function app.approval_issue(jsonb) from public, anon;
grant execute on function app.approval_issue(jsonb) to authenticated;
revoke all on table app.approvals from public, anon, authenticated;

-- ---------- P1-1: retensi ----------
create function app.purge_idempotency(p_days int default 30) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_a bigint; v_b bigint;
begin
  if p_days < 4 then raise exception 'Retensi minimal 4 hari (jendela transaksi offline 72 jam).' using errcode = '22023'; end if;
  delete from app.idempotency_keys where created_at < now() - make_interval(days => p_days); get diagnostics v_a = row_count;
  delete from app.approvals where created_at < now() - make_interval(days => p_days);       get diagnostics v_b = row_count;
  return v_a + v_b;
end $$;
revoke all on function app.purge_idempotency(int) from public, anon, authenticated;

-- Jadwal harian 03:15 (WIB 10:15). pg_cron tidak ada di Postgres biasa (CI): dilewati dengan NOTICE, tidak menggagalkan migrasi.
do $m$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname = 'duado-purge-idempotency';
    perform cron.schedule('duado-purge-idempotency', '15 3 * * *', $cron$select app.purge_idempotency(30)$cron$);
  else
    raise notice 'pg_cron tidak tersedia: jadwalkan app.purge_idempotency(30) secara manual (lihat supabase/README.md).';
  end if;
exception when others then
  raise notice 'Penjadwalan pg_cron dilewati: %', sqlerrm;
end $m$;

-- ---------- P1-2 / P1-5: sale_create (satu-satunya perubahan: pemeriksaan batas diskon menerima approval_id, dan approved_by mencatat penyetujunya) ----------
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
          coalesce(v_approver, case when v_cashier <> v_uid then v_uid end));

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
