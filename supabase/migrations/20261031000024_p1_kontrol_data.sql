-- 0024 P1: kontrol data, kas, dan pelaporan (hasil analisis v2.3.2, Bagian 11 "P1").
--   F-08  Peringatan HPP kosong di Beranda; produksi menolak bahan tanpa harga; app.hpp_backfill (pratinjau lalu terapkan, beraudit).
--   F-09  Laporan "Penjualan per produk": diskon dan PPN inklusif dialokasikan proporsional ke tiap baris, jadi omzet per produk = omzet laba rugi.
--   F-10  Referensi pembayaran transfer/QRIS (payments.reference; wajib di atas ambang bayar_referensi_min) + laporan rekonsiliasi per metode.
--   F-11  Produksi lintas outlet memerlukan owner/admin/supervisor di outlet tujuan.
--   F-12  Laporan "Barang dalam perjalanan"; pemohon tidak boleh menyetujui sendiri transfer di atas ambang transfer_ambang_nilai.
--   F-13  Ambang opname bawaan Rp500.000 (kosongkan untuk menonaktifkan); mengubah HPP yang sudah ada perlu supervisor/owner; laporan "Penyesuaian stok".
--   F-14  Zona waktu OUTLET dipakai di semua format dan default tanggal (price_of, laporan, kas, biaya), bukan Asia/Jakarta tetap / current_date server.
--   F-15  client_ts dipercaya HANYA bila klien menandai transaksi sebagai tertunda (offline=true); waktu tidak boleh lebih awal dari buka kasir;
--         penguncian periode (kunci_periode_sampai, hanya Owner) menolak biaya/impor dan menggeser transaksi tertunda ke waktu server.
--   F-16  expense_void dan purchase_cancel (transaksi pembalik + alasan + audit; tidak ada data yang dihapus).
--   F-17  cash_approve terhubung (catatan tinjauan, tidak boleh menyetujui sesi sendiri), shift_list (nama kasir, sisa laci shift sebelumnya, status tinjauan),
--         laporan "Selisih kas per kasir".
-- Klien < 2.5.0 harus diperbarui (waktu transaksi tertunda kini bergantung pada bendera offline): min_client = 2.5.0.

-- ---------- Skema ----------
-- F-16: biaya tidak pernah diubah/dihapus. Pembatalan = baris pembalik bernominal negatif yang menunjuk biaya asal (void_of), sehingga semua
-- penjumlahan laporan otomatis netto tanpa perubahan rumus.
alter table public.expenses
  add column void_of uuid references public.expenses(id),
  add column void_reason text;
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'public.expenses'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%amount%' loop
    execute format('alter table public.expenses drop constraint %I', c);
  end loop;
end $$;
alter table public.expenses add constraint expenses_amount_check check (amount <> 0 and (amount > 0 or void_of is not null));
create unique index expenses_void_once on public.expenses (void_of) where void_of is not null;

alter table public.purchases
  add column cancelled_at timestamptz,
  add column cancelled_by uuid,
  add column cancel_reason text;

-- F-17: catatan hasil tinjauan selisih kas oleh supervisor/owner.
alter table public.cash_sessions add column approval_note text;

-- F-10: pencocokan referensi (mis. deteksi nomor referensi ganda) per outlet.
create index payments_reference on public.payments (outlet_id, reference) where reference is not null;


-- ---------- Fungsi pembantu internal (tidak dapat dipanggil klien) ----------
-- F-14: zona waktu dan "hari ini" menurut OUTLET (outlet NULL = Asia/Jakarta, untuk laporan lintas outlet/biaya pusat).
create function app.outlet_tz(p_outlet uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select o.timezone from public.outlets o where o.id = p_outlet), 'Asia/Jakarta');
$$;
create function app.outlet_today(p_outlet uuid) returns date
language sql stable security definer set search_path = '' as $$
  select (now() at time zone app.outlet_tz(p_outlet))::date;
$$;

-- Pengaturan angka yang aman: kosong/tidak berupa angka => NULL (fitur nonaktif), bukan galat konversi di tengah transaksi.
create function app.setting_num(p_outlet uuid, p_key text, p_default text default null) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when x.t ~ '^[0-9]+(\.[0-9]+)?$' then x.t::numeric else null end
  from (select trim(coalesce(app.setting(p_outlet, p_key, p_default), '')) as t) x;
$$;

-- F-15: penguncian periode (global). Tanggal <= kunci_periode_sampai tidak boleh menerima entri baru yang bertanggal (biaya, impor).
create function app.period_lock() returns date
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  select s.value into v from public.settings s where s.key = 'kunci_periode_sampai' and s.outlet_id is null limit 1;
  if v ~ '^\d{4}-\d{2}-\d{2}$' then return v::date; end if;
  return null;
exception when others then return null;
end $$;

create function app.period_assert(p_date date, p_what text) returns void
language plpgsql stable security definer set search_path = '' as $$
declare v date := app.period_lock();
begin
  if v is not null and p_date <= v then
    raise exception '% bertanggal % berada pada periode yang sudah dikunci (sampai %). Hubungi Owner.', p_what, to_char(p_date, 'YYYY-MM-DD'), to_char(v, 'YYYY-MM-DD')
      using errcode = 'P0001', hint = 'PERIOD_LOCKED';
  end if;
end $$;

revoke all on function app.outlet_tz(uuid) from public, anon, authenticated;
revoke all on function app.outlet_today(uuid) from public, anon, authenticated;
revoke all on function app.setting_num(uuid, text, text) from public, anon, authenticated;
revoke all on function app.period_lock() from public, anon, authenticated;
revoke all on function app.period_assert(date, text) from public, anon, authenticated;

-- F-14: harga override outlet berlaku menurut tanggal LOKAL outlet (sebelumnya current_date server = UTC).
create or replace function app.price_of(p_outlet uuid, p_variant uuid, p_channel uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select op.price from public.outlet_prices op
       where op.outlet_id = p_outlet and op.variant_id = p_variant and op.channel_id = p_channel
         and op.effective_from <= app.outlet_today(p_outlet) order by op.effective_from desc limit 1),
    (select cp.price from public.channel_prices cp where cp.variant_id = p_variant and cp.channel_id = p_channel));
$$;

-- bayar_referensi_min dibaca klien kasir (untuk mewajibkan kolom referensi sebelum Bayar).
create or replace function app.public_setting_keys() returns text[] language sql immutable as $$
  select array['nama_usaha','footer_struk','ppn_aktif','ppn_persen','ppn_inklusif','blokir_stok_minus','lebar_struk','auto_cetak',
               'stok_menipis','diskon_maks_persen','bayar_tunai','bayar_transfer','bayar_qris','logo_aktif','logo_nama','logo_data',
               'header_aktif','header_struk','footer_aktif','qr_struk','wajib_buka_kasir','block_negative_stock','bayar_referensi_min']::text[];
$$;

-- bendera offline (waktu perangkat dipercaya) tidak ikut hash idempotensi, sama seperti client_ts, kasir_id, terima_selisih.
create or replace function app.idem_begin(p_scope text, p_key text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_hash text := md5(coalesce(case when p_scope = 'sale' then p_payload - 'client_ts' - 'kasir_id' - 'terima_selisih' - 'offline' else p_payload end, 'null'::jsonb)::text);
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

-- Kunci periode hanya lewat period_lock_set (Owner); validasi angka untuk ambang agar teks salah ketik tidak merusak transaksi.


-- settings_set: kunci periode hanya lewat period_lock_set; ambang harus angka.
create or replace function app.settings_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_o uuid := nullif(p ->> 'outlet_id', '')::uuid; v_k text; v_v text; v_org uuid; v_n int := 0;
begin
  perform app.require_role(v_o, array['owner','admin']);
  select id into v_org from public.organizations limit 1;
  for v_k, v_v in select key, case when jsonb_typeof(value) = 'string' then value #>> '{}' else value::text end from jsonb_each(coalesce(p -> 'values', '{}'::jsonb)) loop
    if v_k !~ '^[a-z0-9_]{2,60}$' then raise exception 'Nama pengaturan tidak valid: %', v_k using errcode = '22023'; end if;
    if v_k = 'kunci_periode_sampai' then raise exception 'Kunci periode diatur lewat menu Kunci periode (khusus Owner).' using errcode = '42501'; end if;
    if v_k in ('opname_ambang_nilai','transfer_ambang_nilai','bayar_referensi_min') and trim(v_v) <> '' and trim(v_v) !~ '^[0-9]+(\.[0-9]+)?$' then
      raise exception 'Nilai % harus berupa angka (kosongkan untuk menonaktifkan).', v_k using errcode = '22023'; end if;
    if length(v_v) > 120000 then raise exception 'Nilai pengaturan % terlalu besar.', v_k using errcode = '22023'; end if;
    insert into public.settings (organization_id, outlet_id, key, value, updated_by, updated_at) values (v_org, v_o, v_k, v_v, (select auth.uid()), now())
    on conflict (organization_id, coalesce(outlet_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
    do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
    v_n := v_n + 1;
    perform app.audit(v_o, 'setting', 'settings', v_k, null, case when v_k like 'logo%' then jsonb_build_object('diubah', true) else jsonb_build_object('nilai', left(v_v, 200)) end);
  end loop;
  return jsonb_build_object('ok', true, 'jumlah', v_n);
end $$;

-- sale_create: F-10 referensi, F-15 waktu server/offline/buka kasir/kunci periode.
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
  v_off boolean := lower(coalesce(p ->> 'offline', '')) in ('true', '1', 'ya');
  v_ref text := nullif(left(trim(coalesce(p ->> 'referensi_bayar', '')), 60), ''); v_min numeric; v_ses public.cash_sessions;
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
  -- F-15: waktu perangkat dipercaya HANYA bila klien menandai transaksi tertunda (offline=true); selain itu waktu server.
  if v_cts is not null and v_off and v_cts <= now() + interval '5 minutes' and v_cts >= now() - interval '72 hours' then
    v_sold := least(v_cts, now());
  elsif v_cts is not null and v_off then
    v_note := trim(coalesce(v_note, '') || ' [waktu perangkat tidak valid, dipakai waktu server]');
  end if;
  -- P0-3 (F-04): transaksi yang tertunda (waktu perangkat valid tetapi lebih dari 3 menit lalu, mis. dibuat saat offline) atau yang kasirnya sengaja memilih
  -- "terima harga server" TIDAK ditolak bila total/stok berbeda: uang dan barang sudah berpindah. Dicatat dengan harga SERVER (klien tidak pernah dipercaya
  -- untuk harga), diberi tanda review_flag, dan total klien tersimpan di client_total untuk ditinjau Owner.
  v_accept := lower(coalesce(p ->> 'terima_selisih', '')) in ('true', '1', 'ya')
              or (v_off and v_cts is not null and v_cts <= now() + interval '5 minutes' and v_cts >= now() - interval '72 hours' and v_cts < now() - interval '3 minutes');

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

  -- F-10: referensi pembayaran non-tunai (wajib di atas ambang bayar_referensi_min; transaksi tertunda tetap diterima tetapi ditandai).
  v_min := app.setting_num(v_outlet.id, 'bayar_referensi_min');
  if v_method <> 'tunai' and v_ref is null and v_min is not null and v_total >= v_min then
    if v_accept then
      v_review := true; v_rnote := trim(v_rnote || ' Nomor referensi ' || upper(v_method) || ' belum diisi.');
    else
      raise exception 'Isi nomor referensi % (transaksi Rp% ke atas wajib punya referensi).', upper(v_method), v_min using errcode = 'P0001', hint = 'REFERENCE_REQUIRED';
    end if;
  end if;
  if v_ref is not null and v_method <> 'tunai' and exists (select 1 from public.payments pm where pm.outlet_id = v_outlet.id and pm.method = v_method and pm.reference = v_ref) then
    v_review := true; v_rnote := trim(v_rnote || ' Nomor referensi ' || v_ref || ' sudah pernah dipakai pada transaksi lain.');
  end if;

  v_session := app.ensure_session(v_outlet.id, v_cashier);
  -- F-15: waktu transaksi tidak boleh lebih awal dari buka kasir (kecuali sesi otomatis) dan tidak boleh jatuh di periode terkunci.
  select * into v_ses from public.cash_sessions where id = v_session;
  if not v_ses.auto_opened and v_sold < v_ses.opened_at then
    v_sold := v_ses.opened_at; v_review := true;
    v_rnote := trim(v_rnote || ' Waktu perangkat lebih awal dari buka kasir; dipakai waktu buka kasir.');
  end if;
  if (v_sold at time zone v_outlet.timezone)::date <= coalesce(app.period_lock(), date '0001-01-01') then
    v_sold := now(); v_review := true;
    v_rnote := trim(v_rnote || ' Tanggal transaksi jatuh pada periode terkunci; dicatat dengan waktu server.');
  end if;

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

  insert into public.payments (sale_id, outlet_id, cash_session_id, method, amount, received, change_given, reference)
  values (v_sale, v_outlet.id, v_session, v_method, v_total, v_recv, v_change, case when v_method <> 'tunai' then v_ref end);

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

create or replace function app.production_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_k public.outlets; v_out public.outlets; v_r public.recipes; v_b numeric := app.num(p, 'jumlah_batch'); v_id uuid; v_kind text := coalesce(p ->> 'jenis', 'batch');
begin
  v_k := app.active_outlet(nullif(p ->> 'kitchen_outlet_id', '')::uuid);
  v_out := app.active_outlet(coalesce(nullif(p ->> 'output_outlet_id', '')::uuid, v_k.id));
  perform app.require_role(v_k.id, array['owner','admin','supervisor','produksi']);
  -- F-11: mengisi stok outlet lain butuh wewenang di outlet tujuan (atau gunakan transfer).
  if v_out.id <> v_k.id then perform app.require_role(v_out.id, array['owner','admin','supervisor']); end if;
  select * into v_r from public.recipes where id = nullif(p ->> 'recipe_id', '')::uuid and active;
  if not found then raise exception 'Resep tidak ditemukan.' using errcode = 'P0002'; end if;
  if v_b is null or v_b <= 0 then raise exception 'Jumlah batch harus lebih dari 0.' using errcode = '22023'; end if;
  if v_kind not in ('batch','pesanan','repack') then v_kind := 'batch'; end if;
  insert into public.production_orders (kitchen_outlet_id, output_outlet_id, recipe_id, variant_id, kind, batches, standard_qty, note, user_id)
  values (v_k.id, v_out.id, v_r.id, v_r.variant_id, v_kind, v_b, v_r.standard_yield * v_b, nullif(p ->> 'catatan', ''), (select auth.uid())) returning id into v_id;
  perform app.audit(v_k.id, 'production_create', 'production_orders', v_id::text, null, jsonb_build_object('batch', v_b));
  return jsonb_build_object('id', v_id, 'status', 'planned');
end $$;

-- Produksi: F-11 wewenang outlet tujuan, F-08 bahan tanpa harga.
create or replace function app.production_complete(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v public.production_orders; v_r public.recipes; v_qty numeric := app.num(p, 'qty_hasil'); v_m record;
  v_bahan numeric := 0; v_kem numeric := 0; v_tk numeric; v_oh numeric; v_total numeric; v_unit numeric; v_c numeric; v_mats jsonb := '[]'::jsonb;
  v_new numeric; v_vnew numeric; v_vcost numeric; v_dup jsonb; v_nocost text;
begin
  select * into v from public.production_orders where id = nullif(p ->> 'id', '')::uuid for update;   -- kunci: tidak bisa diselesaikan dua kali
  if not found then raise exception 'Produksi tidak ditemukan.' using errcode = 'P0002'; end if;
  perform app.require_role(v.kitchen_outlet_id, array['owner','admin','supervisor','produksi']);
  if v.output_outlet_id <> v.kitchen_outlet_id then perform app.require_role(v.output_outlet_id, array['owner','admin','supervisor']); end if;
  if v.status <> 'planned' then raise exception 'Produksi ini sudah berstatus %.', v.status using errcode = 'P0001'; end if;
  if v_qty is null or v_qty <= 0 then raise exception 'Hasil aktual harus lebih dari 0.' using errcode = '22023'; end if;
  perform app.active_outlet(v.kitchen_outlet_id); perform app.active_outlet(v.output_outlet_id);
  select * into v_r from public.recipes where id = v.recipe_id;

  -- F-08: bahan tanpa harga (HPP 0) membuat HPP produk terlalu rendah. Ditolak, kecuali supervisor/owner sengaja mengizinkan (izinkan_bahan_tanpa_harga).
  if not (lower(coalesce(p ->> 'izinkan_bahan_tanpa_harga', '')) in ('true', '1', 'ya') and app.has_role(v.kitchen_outlet_id, array['owner','admin','supervisor'])) then
    select string_agg(distinct m.name, ', ') into v_nocost
      from public.recipe_items ri join public.materials m on m.id = ri.material_id
      left join public.inventory_material_balances b on b.outlet_id = v.kitchen_outlet_id and b.material_id = ri.material_id
     where ri.recipe_id = v.recipe_id and coalesce(b.avg_cost, 0) <= 0;
    if v_nocost is not null then
      raise exception 'Bahan belum punya harga (HPP 0): %. Catat pembelian atau isi HPP lewat Stok, agar HPP produk tidak terlalu rendah.', v_nocost
        using errcode = 'P0001', hint = 'MATERIAL_NO_COST';
    end if;
  end if;

  for v_m in
    select ri.material_id, sum(ri.qty * v.batches) as need, m.type, m.name
    from public.recipe_items ri join public.materials m on m.id = ri.material_id
    where ri.recipe_id = v.recipe_id group by ri.material_id, m.type, m.name order by ri.material_id
  loop
    v_new := app.stock_apply(v.kitchen_outlet_id, 'material', v_m.material_id, -v_m.need, 'production_use', 'production', v.id, null, false, null);
    select avg_cost into v_c from public.inventory_material_balances where outlet_id = v.kitchen_outlet_id and material_id = v_m.material_id;
    if v_m.type = 'kemasan' then v_kem := v_kem + v_m.need * v_c; else v_bahan := v_bahan + v_m.need * v_c; end if;
    v_mats := v_mats || jsonb_build_array(jsonb_build_object('id', v_m.material_id, 'stok', v_new));
  end loop;

  v_tk := coalesce(app.num(p, 'tenaga_kerja'), v_r.labor_cost * v.batches);
  v_oh := coalesce(app.num(p, 'overhead'), case when app.setting(v.kitchen_outlet_id, 'metode_overhead', 'per_unit') = 'per_batch'
                    then coalesce(nullif(app.setting(v.kitchen_outlet_id, 'overhead_per_batch', '0'), '')::numeric, 0) * v.batches
                    else coalesce(nullif(app.setting(v.kitchen_outlet_id, 'overhead_per_unit', '0'), '')::numeric, 0) * v_qty end);
  if v_tk < 0 or v_oh < 0 then raise exception 'Biaya tidak valid.' using errcode = '22023'; end if;
  v_total := round(v_bahan + v_kem + v_tk + v_oh, 2); v_unit := round(v_total / v_qty, 4);

  v_vnew := app.stock_apply(v.output_outlet_id, 'variant', v.variant_id, v_qty, 'production_in', 'production', v.id, v_unit, true, null);
  select avg_cost into v_vcost from public.inventory_balances where outlet_id = v.output_outlet_id and variant_id = v.variant_id;

  insert into public.production_costs (production_id, materials_cost, packaging_cost, labor_cost, overhead_cost, total, unit_cost)
  values (v.id, round(v_bahan, 2), round(v_kem, 2), v_tk, v_oh, v_total, v_unit);
  update public.production_orders set status = 'done', actual_qty = v_qty, completed_at = now() where id = v.id;
  perform app.audit(v.kitchen_outlet_id, 'production_complete', 'production_orders', v.id::text, null,
                    jsonb_build_object('qty', v_qty, 'total', v_total, 'hpp_unit', v_unit));
  return jsonb_build_object('id', v.id, 'status', 'done', 'qty_hasil', v_qty,
    'costs', jsonb_build_object('bahan', v_bahan, 'kemasan', v_kem, 'tenaga_kerja', v_tk, 'overhead', v_oh, 'total', v_total, 'hpp_per_unit', v_unit),
    'materials', v_mats, 'variant', jsonb_build_object('id', v.variant_id, 'stok', v_vnew, 'hpp_rata2', v_vcost));
end $$;

-- stock_adjust: F-13.
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
  v_thr := app.setting_num(v_o.id, 'opname_ambang_nilai', '500000');   -- F-13: bawaan Rp500.000; di atasnya perlu supervisor/admin/owner; kosong = nonaktif
  if v_thr is not null and abs(v_new - v_old) * coalesce(v_hpp, v_cost) > v_thr
     and not app.has_role(v_o.id, array['owner','admin','supervisor']) then
    raise exception 'Penyesuaian bernilai besar perlu persetujuan supervisor.' using errcode = '42501'; end if;
  v_first := not exists (select 1 from public.stock_movements where outlet_id = v_o.id and item_type = v_type and item_id = v_id);
  -- F-13: mengubah HPP yang SUDAH ada mengubah laba semua penjualan berikutnya: hanya supervisor/owner. Saldo awal dan pengisian HPP kosong tetap boleh.
  if v_hpp is not null and not v_first and coalesce(v_cost, 0) > 0 and abs(v_hpp - v_cost) > 0.0001
     and not app.has_role(v_o.id, array['owner','admin','supervisor']) then
    raise exception 'Mengubah HPP perlu persetujuan supervisor/owner.' using errcode = '42501', hint = 'HPP_APPROVAL';
  end if;
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

-- transfer_action: F-12.
create or replace function app.transfer_action(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v public.stock_transfers; v_act text := p ->> 'action'; v_i record; v_cost numeric; v_rc numeric; v_dup jsonb; v_need_appr boolean; v_var int := 0; v_thr numeric; v_val numeric;
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
    -- F-12: pemohon tidak boleh menyetujui sendiri transfer bernilai di atas transfer_ambang_nilai (kosong = nonaktif).
    if v_act = 'approve' and v.requested_by = (select auth.uid()) then
      v_thr := app.setting_num(v.from_outlet_id, 'transfer_ambang_nilai');
      if v_thr is not null then
        select coalesce(sum(i.qty_requested * coalesce(case when i.item_type = 'variant'
                 then (select b.avg_cost from public.inventory_balances b where b.outlet_id = v.from_outlet_id and b.variant_id = i.item_id)
                 else (select b.avg_cost from public.inventory_material_balances b where b.outlet_id = v.from_outlet_id and b.material_id = i.item_id) end, 0)), 0)
          into v_val from public.stock_transfer_items i where i.transfer_id = v.id;
        if v_val > v_thr then
          raise exception 'Transfer senilai Rp% melebihi ambang Rp%: pemohon tidak boleh menyetujui sendiri.', round(v_val), v_thr using errcode = '42501', hint = 'SELF_APPROVAL';
        end if;
      end if;
    end if;
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

-- cash_summary: F-14 zona waktu outlet.
create or replace function app.cash_summary(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v public.cash_sessions; v_n int; v_o uuid := nullif(p ->> 'outlet_id', '')::uuid; v_mv jsonb;
begin
  if (select auth.uid()) is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  select * into v from public.cash_sessions where cashier_id = (select auth.uid()) and status = 'open';
  if not found then
    return jsonb_build_object('sesi', null, 'dari', null, 'jumlah_trx', 0, 'modal_terakhir', 0, 'modal_awal', 0,
      'wajib_buka', case when v_o is null then true else app.setting_bool(v_o, 'wajib_buka_kasir', true) end, 'gerakan', '[]'::jsonb);
  end if;
  select count(*) into v_n from public.sales where cash_session_id = v.id and kind = 'sale' and status = 'completed';
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'jenis', m.kind, 'nominal', m.amount, 'alasan', m.reason,
           'waktu', to_char(m.created_at at time zone app.outlet_tz(v.outlet_id), 'YYYY-MM-DD HH24:MI:SS')) order by m.created_at), '[]'::jsonb)
    into v_mv from public.cash_movements m where m.cash_session_id = v.id;
  return jsonb_build_object('sesi', v.id, 'outlet_id', v.outlet_id, 'dari', to_char(v.opened_at at time zone app.outlet_tz(v.outlet_id), 'YYYY-MM-DD HH24:MI:SS'),
    'sampai', to_char(now() at time zone app.outlet_tz(v.outlet_id), 'YYYY-MM-DD HH24:MI:SS'), 'jumlah_trx', v_n,
    'modal_terakhir', v.opening_cash, 'modal_awal', v.opening_cash, 'auto_opened', v.auto_opened,
    'wajib_buka', app.setting_bool(v.outlet_id, 'wajib_buka_kasir', true), 'gerakan', v_mv);
end $$;

-- cash_close: F-14 zona waktu outlet.
create or replace function app.cash_close(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid()); v public.cash_sessions;
  v_fisik numeric := app.num(p, 'uang_fisik'); v_extra numeric := 0;   -- F4: kas keluar hanya lewat cash_movement_add (dengan alasan); angka dari klien saat tutup diabaikan
  v_modal numeric; v_in numeric; v_out numeric; v_tunai numeric; v_tf numeric; v_qr numeric; v_lain numeric; v_total numeric; v_retur numeric;
  v_n int; v_exp numeric; v_diff numeric; v_note text := trim(coalesce(p ->> 'catatan', '')); v_amb numeric;
begin
  if v_uid is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  if v_fisik is null or v_fisik < 0 then raise exception 'Isi jumlah uang tunai di laci (0 atau lebih).' using errcode = '22023'; end if;
  if v_extra < 0 then raise exception 'Kas keluar tidak boleh negatif.' using errcode = '22023'; end if;
  select * into v from public.cash_sessions where cashier_id = v_uid and status = 'open' for update;  -- menunggu penjualan yang sedang berjalan
  if not found then raise exception 'Tidak ada sesi kasir aktif untuk ditutup.' using errcode = 'P0001'; end if;
  perform app.require_role(v.outlet_id, array['owner','admin','supervisor','kasir']);

  v_modal := v.opening_cash;   -- F4: modal awal ditetapkan saat BUKA kasir, tidak bisa diketik ulang setelah uang dihitung
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
  return jsonb_build_object('id', v.id, 'dari', to_char(v.opened_at at time zone app.outlet_tz(v.outlet_id), 'YYYY-MM-DD HH24:MI:SS'),
    'sampai', to_char(now() at time zone app.outlet_tz(v.outlet_id), 'YYYY-MM-DD HH24:MI:SS'), 'jumlah_trx', v_n, 'tunai', v_tunai, 'transfer', v_tf,
    'qris', v_qr, 'lain', v_lain, 'total', v_total, 'retur', v_retur, 'modal_awal', v_modal, 'kas_keluar', v_out + v_extra,
    'tunai_diharapkan', v_exp, 'uang_fisik', v_fisik, 'selisih_tunai', v_diff);
end $$;

-- expense_create: F-14 tanggal lokal outlet, F-15 kunci periode.
create or replace function app.expense_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_outlet uuid := nullif(p ->> 'outlet_id', '')::uuid; v_amt numeric := app.num(p, 'nominal');
        v_id uuid; v_dup jsonb; v_sess uuid; v_date date := coalesce(nullif(p ->> 'tanggal', '')::date, app.outlet_today(v_outlet));
begin
  if v_uid is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  if v_outlet is null then perform app.require_role(null, array['owner','admin']);          -- biaya pusat
  else perform app.require_role(v_outlet, array['owner','admin','supervisor']); end if;
  v_dup := app.idem_begin('expense', p ->> 'request_id', p);
  if v_dup is not null then return v_dup; end if;
  if v_amt is null or v_amt <= 0 then raise exception 'Nominal biaya tidak valid.' using errcode = '22023'; end if;
  if length(trim(coalesce(p ->> 'kategori', ''))) < 2 then raise exception 'Kategori biaya wajib diisi.' using errcode = '22023'; end if;
  perform app.period_assert(v_date, 'Biaya');   -- F-15
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

-- shopee_import: F-15 kunci periode.
create or replace function app.shopee_import(p jsonb) returns jsonb
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

        perform app.period_assert((v_sold at time zone v_o.timezone)::date, 'Pesanan Shopee ' || v_oid);   -- F-15
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

-- dashboard: F-08 peringatan.
create or replace function app.dashboard(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_o public.outlets; v_per text := coalesce(nullif(p ->> 'period', ''), 'hari');
  v_today date; v_from date; v_to date; v_pfrom date; v_pto date; v_sfrom date;
  v_cur jsonb; v_prev jsonb; v_series jsonb; v_ch jsonb; v_top jsonb; v_low jsonb; v_neg jsonb;
  v_fee numeric; v_biaya numeric; v_laba numeric; v_loss numeric; v_rev bigint; v_miss bigint; v_vn bigint; v_warn jsonb := '[]'::jsonb;
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
  -- F-08: peringatan HPP kosong (laba/margin terlihat lebih tinggi dari kenyataan).
  select coalesce(sum(f.hpp_missing), 0) into v_miss from app.sales_facts(v_o.id, v_from, v_to) f;
  select count(*) into v_vn from public.inventory_balances b join public.product_variants v on v.id = b.variant_id join public.products pr on pr.id = v.product_id and pr.active
   where b.outlet_id = v_o.id and v.active and b.quantity > 0 and coalesce(b.avg_cost, 0) <= 0;
  if v_miss > 0 then
    v_warn := v_warn || jsonb_build_array(jsonb_build_object('aksi', 'hpp', 'teks', v_miss || ' baris penjualan periode ini belum punya HPP, jadi laba dan margin terlihat lebih tinggi dari kenyataan.'));
  end if;
  if v_vn > 0 then
    v_warn := v_warn || jsonb_build_array(jsonb_build_object('aksi', 'stok', 'teks', v_vn || ' varian yang ada stoknya belum punya HPP. Isi HPP lewat Stok (penyesuaian) supaya penjualan berikutnya punya HPP.'));
  end if;

  return jsonb_build_object('period', v_per, 'outlet_id', v_o.id, 'from', v_from, 'to', v_to, 'pfrom', v_pfrom, 'pto', v_pto,
    'cur', v_cur, 'prev', v_prev, 'series', v_series, 'channels', v_ch, 'top', v_top, 'low', v_low, 'stok_minus', v_neg,
    'peringatan', v_warn, 'biaya', v_biaya, 'fee_channel', v_fee, 'laba_bersih', v_laba,
    'kerugian', v_loss, 'review_trx', v_rev);
end $$;

-- report_legacy: F-09 alokasi diskon, laporan baru metode/transit/penyesuaian/selisih_kas.
create or replace function app.report_legacy(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_o public.outlets; v_type text := coalesce(p ->> 'type', 'labarugi'); v_role text; v_cost boolean;
  v_today date; v_from date; v_to date; v_title text; v_cols jsonb; v_fmt jsonb; v_rows jsonb := '[]'::jsonb; v_sum jsonb := '[]'::jsonb;
  v_om numeric; v_hpp numeric; v_fee numeric; v_exp numeric; v_miss bigint; v_warn text := null; v_n numeric; v_t numeric;
  v_cats text[]; v_exc numeric; v_loss numeric; v_a numeric; v_b numeric; v_c numeric; v_cnt bigint;
begin
  select * into v_o from public.outlets where id = nullif(p ->> 'outlet_id', '')::uuid;
  if not found then raise exception 'Outlet tidak ditemukan.' using errcode = 'P0002'; end if;
  v_role := app.role_at(v_o.id);
  if v_role is null then raise exception 'Akses ditolak untuk outlet ini.' using errcode = '42501'; end if;
  if v_type not in ('labarugi','penjualan','channel','hpp','stok','produksi','pembelian','pengeluaran','metode','transit','penyesuaian','selisih_kas') then
    raise exception 'Jenis laporan tidak dikenal: %', v_type using errcode = '22023'; end if;
  -- Matriks akses per jenis (sejalan dengan require_role di report_sales/report_pnl/report_stock_value).
  if (v_type in ('labarugi','hpp') and v_role not in ('owner','admin','auditor'))
     or (v_type in ('penjualan','channel') and v_role not in ('owner','admin','supervisor','auditor'))
     or (v_type = 'stok' and v_role not in ('owner','admin','supervisor','stok','produksi','auditor'))
     or (v_type = 'produksi' and v_role not in ('owner','admin','supervisor','produksi','stok','auditor'))
     or (v_type = 'pembelian' and v_role not in ('owner','admin','supervisor','stok','auditor'))
     or (v_type = 'pengeluaran' and v_role not in ('owner','admin','supervisor','auditor'))
     or (v_type in ('metode','penyesuaian','selisih_kas') and v_role not in ('owner','admin','supervisor','auditor'))
     or (v_type = 'transit' and v_role not in ('owner','admin','supervisor','stok','auditor')) then
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
             where e.outlet_id = v_o.id and e.expense_date between v_from and v_to and lower(trim(e.category)) <> all (v_cats) group by e.category having sum(e.amount) <> 0) q), '[]'::jsonb);
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
               sum(i.qty) as qty, coalesce(sum(i.line_total * i.k), 0) as omzet, coalesce(sum(i.qty * i.hpp_snapshot), 0) as hpp
        -- F-09: diskon dan PPN inklusif dialokasikan proporsional ke tiap baris (k = omzet transaksi / jumlah baris), jadi total = omzet laba rugi.
        from (select it.variant_id, it.qty, it.line_total, it.hpp_snapshot, it.name_snapshot,
                     case when sum(it.line_total) over (partition by it.sale_id) <> 0
                          then (s.total - s.tax_amount) / sum(it.line_total) over (partition by it.sale_id) else 1 end as k
                from public.sale_items it join public.sales s on s.id = it.sale_id
               where s.outlet_id = v_o.id and s.status = 'completed'
                 and s.sold_at >= (v_from::timestamp at time zone v_o.timezone) and s.sold_at < ((v_to + 1)::timestamp at time zone v_o.timezone)) i
        join public.product_variants v on v.id = i.variant_id left join public.products pr on pr.id = v.product_id
        group by i.variant_id, pr.name, v.size, v.spice_level) q;
    select coalesce(sum(f.om), 0), count(*) filter (where f.kind = 'sale') into v_om, v_n from app.sales_facts(v_o.id, v_from, v_to) f;
    select coalesce(sum(s.discount), 0) into v_a from public.sales s where s.outlet_id = v_o.id and s.status = 'completed'
       and s.sold_at >= (v_from::timestamp at time zone v_o.timezone) and s.sold_at < ((v_to + 1)::timestamp at time zone v_o.timezone);
    v_sum := jsonb_build_array(jsonb_build_object('label', 'Omzet', 'value', v_om, 'fmt', 'rp'), jsonb_build_object('label', 'Transaksi', 'value', v_n, 'fmt', 'num'),
                               jsonb_build_object('label', 'Diskon (sudah dikurangkan per produk)', 'value', v_a, 'fmt', 'rp'));

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

  elsif v_type = 'metode' then
    -- F-10: rekonsiliasi pembayaran per hari dan metode, untuk dicocokkan dengan mutasi QRIS/bank. Retur dihitung sebagai pengembalian pada metodenya.
    v_title := 'Pembayaran per metode'; v_cols := '["Tanggal","Metode","Transaksi","Penjualan","Retur","Neto","Tanpa referensi (trx)","Tanpa referensi (Rp)"]'; v_fmt := '["txt","txt","num","rp","rp","rp","num","rp"]';
    select coalesce(jsonb_agg(jsonb_build_array(q.d, upper(q.method), q.trx, q.jual, q.retur, q.jual - q.retur, q.noref, q.noref_rp) order by q.d desc, q.method), '[]'::jsonb)
      into v_rows from (
        select to_char((s.sold_at at time zone v_o.timezone)::date, 'YYYY-MM-DD') as d, pm.method,
               count(*) filter (where s.kind = 'sale') as trx,
               coalesce(sum(pm.amount) filter (where s.kind = 'sale'), 0) as jual,
               coalesce(sum(-pm.amount) filter (where s.kind = 'return'), 0) as retur,
               count(*) filter (where s.kind = 'sale' and pm.method in ('transfer','qris') and coalesce(pm.reference, '') = '') as noref,
               coalesce(sum(pm.amount) filter (where s.kind = 'sale' and pm.method in ('transfer','qris') and coalesce(pm.reference, '') = ''), 0) as noref_rp
          from public.payments pm join public.sales s on s.id = pm.sale_id
         where s.outlet_id = v_o.id and s.status = 'completed' and pm.status = 'confirmed'
           and s.sold_at >= (v_from::timestamp at time zone v_o.timezone) and s.sold_at < ((v_to + 1)::timestamp at time zone v_o.timezone)
         group by 1, pm.method) q;
    select coalesce(sum(pm.amount) filter (where pm.method = 'tunai'), 0), coalesce(sum(pm.amount) filter (where pm.method in ('transfer','qris')), 0),
           count(*) filter (where s.kind = 'sale' and pm.method in ('transfer','qris') and coalesce(pm.reference, '') = ''),
           coalesce(sum(pm.amount) filter (where s.kind = 'sale' and pm.method in ('transfer','qris') and coalesce(pm.reference, '') = ''), 0)
      into v_a, v_b, v_cnt, v_c
      from public.payments pm join public.sales s on s.id = pm.sale_id
     where s.outlet_id = v_o.id and s.status = 'completed' and pm.status = 'confirmed'
       and s.sold_at >= (v_from::timestamp at time zone v_o.timezone) and s.sold_at < ((v_to + 1)::timestamp at time zone v_o.timezone);
    v_sum := jsonb_build_array(jsonb_build_object('label', 'Tunai (neto)', 'value', v_a, 'fmt', 'rp'), jsonb_build_object('label', 'Transfer + QRIS (neto)', 'value', v_b, 'fmt', 'rp'),
                               jsonb_build_object('label', 'Tanpa referensi (Rp)', 'value', v_c, 'fmt', 'rp'));
    if v_cnt > 0 then v_warn := v_cnt || ' transaksi transfer/QRIS belum punya nomor referensi; sulit dicocokkan dengan mutasi penyedia.'; end if;
    select count(*) into v_miss from (select pm.method, pm.reference from public.payments pm join public.sales s on s.id = pm.sale_id
       where s.outlet_id = v_o.id and s.kind = 'sale' and s.status = 'completed' and pm.method in ('transfer','qris') and coalesce(pm.reference, '') <> ''
         and s.sold_at >= (v_from::timestamp at time zone v_o.timezone) and s.sold_at < ((v_to + 1)::timestamp at time zone v_o.timezone)
       group by pm.method, pm.reference having count(*) > 1) d;
    if v_miss > 0 then v_warn := trim(coalesce(v_warn || ' ', '') || v_miss || ' nomor referensi dipakai lebih dari sekali (transaksi ditandai "perlu ditinjau").'); end if;

  elsif v_type = 'transit' then
    -- F-12: transfer yang sudah dikirim tetapi belum diterima (stok keluar dari asal, belum masuk ke tujuan). Tanpa rentang tanggal: kondisi saat ini.
    v_title := 'Barang dalam perjalanan'; v_cols := '["Nomor","Dari","Ke","Dikirim","Hari di jalan","Item","Nilai"]'; v_fmt := '["txt","txt","txt","txt","num","num","rp"]';
    select coalesce(jsonb_agg(jsonb_build_array(q.number, q.dari, q.ke, to_char(q.sent_at at time zone v_o.timezone, 'YYYY-MM-DD HH24:MI'), q.hari, q.n,
             case when v_cost then q.nilai else null end) order by q.sent_at), '[]'::jsonb)
      into v_rows from (
        select t.number, fo.code as dari, tu.code as ke, t.sent_at, floor(extract(epoch from (now() - t.sent_at)) / 86400)::int as hari,
               (select count(*) from public.stock_transfer_items i where i.transfer_id = t.id) as n,
               (select coalesce(sum(i.qty_sent * coalesce(i.unit_cost, 0)), 0) from public.stock_transfer_items i where i.transfer_id = t.id) as nilai
          from public.stock_transfers t join public.outlets fo on fo.id = t.from_outlet_id join public.outlets tu on tu.id = t.to_outlet_id
         where t.status = 'sent' and (t.from_outlet_id = v_o.id or t.to_outlet_id = v_o.id)) q;
    select count(*), coalesce(sum((select sum(i.qty_sent * coalesce(i.unit_cost, 0)) from public.stock_transfer_items i where i.transfer_id = t.id)), 0),
           count(*) filter (where t.sent_at < now() - interval '3 days')
      into v_cnt, v_a, v_miss from public.stock_transfers t
     where t.status = 'sent' and (t.from_outlet_id = v_o.id or t.to_outlet_id = v_o.id);
    v_sum := jsonb_build_array(jsonb_build_object('label', 'Transfer dalam perjalanan', 'value', v_cnt, 'fmt', 'num'));
    if v_cost then v_sum := v_sum || jsonb_build_array(jsonb_build_object('label', 'Nilai dalam perjalanan', 'value', v_a, 'fmt', 'rp')); end if;
    if v_miss > 0 then v_warn := v_miss || ' transfer sudah lebih dari 3 hari belum diterima; konfirmasi ke outlet tujuan.'; end if;

  elsif v_type = 'penyesuaian' then
    -- F-13: semua penyesuaian stok (opname dan saldo awal) per pelaku. Nilai/HPP hanya untuk peran yang boleh melihat biaya.
    v_title := 'Penyesuaian stok'; v_cols := '["Waktu","Pelaku","Jenis","Item","Selisih","HPP","Nilai","Alasan"]'; v_fmt := '["txt","txt","txt","txt","num","rp","rp","txt"]';
    select coalesce(jsonb_agg(jsonb_build_array(to_char(q.created_at at time zone v_o.timezone, 'YYYY-MM-DD HH24:MI'), q.pelaku, q.jenis, q.item, q.qty,
             case when v_cost then q.unit_cost else null end, case when v_cost then q.nilai else null end, q.alasan) order by q.pelaku, q.created_at desc), '[]'::jsonb)
      into v_rows from (
        select sm.created_at, coalesce(pr.full_name, '?') as pelaku, case sm.movement_type when 'opening' then 'Saldo awal' else 'Opname' end as jenis,
               coalesce(nullif(trim(concat_ws(' ', pd.name, v.sku)), ''), m.name, '?') as item,
               sm.quantity_delta as qty, sm.unit_cost, round(sm.value, 2) as nilai, coalesce(sm.note, '') as alasan
          from public.stock_movements sm
          left join public.profiles pr on pr.id = sm.user_id
          left join public.product_variants v on sm.item_type = 'variant' and v.id = sm.item_id
          left join public.products pd on pd.id = v.product_id
          left join public.materials m on sm.item_type = 'material' and m.id = sm.item_id
         where sm.outlet_id = v_o.id and sm.movement_type in ('adjustment','opening')
           and sm.created_at >= (v_from::timestamp at time zone v_o.timezone) and sm.created_at < ((v_to + 1)::timestamp at time zone v_o.timezone)
         order by sm.created_at desc limit 500) q;
    select count(*), coalesce(sum(sm.value) filter (where sm.movement_type = 'adjustment' and sm.value < 0), 0), coalesce(sum(sm.value) filter (where sm.movement_type = 'adjustment' and sm.value > 0), 0)
      into v_cnt, v_a, v_b from public.stock_movements sm
     where sm.outlet_id = v_o.id and sm.movement_type in ('adjustment','opening')
       and sm.created_at >= (v_from::timestamp at time zone v_o.timezone) and sm.created_at < ((v_to + 1)::timestamp at time zone v_o.timezone);
    v_sum := jsonb_build_array(jsonb_build_object('label', 'Jumlah penyesuaian', 'value', v_cnt, 'fmt', 'num'));
    if v_cost then
      v_sum := v_sum || jsonb_build_array(jsonb_build_object('label', 'Nilai selisih kurang', 'value', v_a, 'fmt', 'rp'), jsonb_build_object('label', 'Nilai selisih lebih', 'value', v_b, 'fmt', 'rp'));
      v_sum := v_sum || coalesce((select jsonb_agg(jsonb_build_object('label', 'Neto: ' || z.pelaku, 'value', z.nilai, 'fmt', 'rp') order by abs(z.nilai) desc)
        from (select coalesce(pr.full_name, '?') as pelaku, sum(sm.value) as nilai from public.stock_movements sm left join public.profiles pr on pr.id = sm.user_id
               where sm.outlet_id = v_o.id and sm.movement_type = 'adjustment'
                 and sm.created_at >= (v_from::timestamp at time zone v_o.timezone) and sm.created_at < ((v_to + 1)::timestamp at time zone v_o.timezone)
               group by pr.full_name order by abs(sum(sm.value)) desc limit 4) z), '[]'::jsonb);
    end if;

  elsif v_type = 'selisih_kas' then
    -- F-17: selisih tunai tiap sesi yang ditutup, dirangkum per kasir (sesi dihitung pada tanggal lokal outlet saat ditutup).
    v_title := 'Selisih kas per kasir'; v_cols := '["Kasir","Sesi","Sesi berselisih","Selisih neto","Kurang","Lebih","Selisih terbesar","Belum ditinjau"]'; v_fmt := '["txt","num","num","rp","rp","rp","rp","num"]';
    select coalesce(jsonb_agg(jsonb_build_array(q.kasir, q.sesi, q.beda, q.neto, q.kurang, q.lebih, q.terbesar, q.belum) order by q.neto, q.kasir), '[]'::jsonb)
      into v_rows from (
        select coalesce(pr.full_name, '?') as kasir, count(*) as sesi, count(*) filter (where s.difference <> 0) as beda,
               coalesce(sum(s.difference), 0) as neto, coalesce(sum(s.difference) filter (where s.difference < 0), 0) as kurang,
               coalesce(sum(s.difference) filter (where s.difference > 0), 0) as lebih, coalesce(max(abs(s.difference)), 0) as terbesar,
               count(*) filter (where s.difference <> 0 and s.approved_at is null) as belum
          from public.cash_sessions s left join public.profiles pr on pr.id = s.cashier_id
         where s.outlet_id = v_o.id and s.status = 'closed' and (s.closed_at at time zone v_o.timezone)::date between v_from and v_to
         group by s.cashier_id, pr.full_name) q;
    select count(*), coalesce(sum(s.difference), 0), count(*) filter (where s.difference <> 0 and s.approved_at is null)
      into v_cnt, v_a, v_miss from public.cash_sessions s
     where s.outlet_id = v_o.id and s.status = 'closed' and (s.closed_at at time zone v_o.timezone)::date between v_from and v_to;
    v_sum := jsonb_build_array(jsonb_build_object('label', 'Sesi ditutup', 'value', v_cnt, 'fmt', 'num'), jsonb_build_object('label', 'Selisih neto', 'value', v_a, 'fmt', 'rp'),
                               jsonb_build_object('label', 'Belum ditinjau', 'value', v_miss, 'fmt', 'num'));
    if v_miss > 0 then v_warn := v_miss || ' sesi berselisih belum ditinjau. Buka Tutup kasir lalu tandai ditinjau dengan catatan.'; end if;

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

-- report_sales: F-14 tanggal bawaan menurut zona outlet.
create or replace function app.report_sales(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_o uuid := nullif(p ->> 'outlet_id', '')::uuid; v_from date := coalesce(nullif(p ->> 'from', '')::date, app.outlet_today(v_o));
        v_to date := coalesce(nullif(p ->> 'to', '')::date, app.outlet_today(v_o)); v_rows jsonb; v_tot jsonb; v_ch jsonb; v_day jsonb;
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

-- report_pnl: F-14 tanggal bawaan menurut zona outlet.
create or replace function app.report_pnl(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_o uuid := nullif(p ->> 'outlet_id', '')::uuid; v_from date := coalesce(nullif(p ->> 'from', '')::date, app.outlet_today(v_o));
        v_to date := coalesce(nullif(p ->> 'to', '')::date, app.outlet_today(v_o)); v_s jsonb; v_exp numeric; v_cen numeric; v_cat jsonb; v_net numeric; v_hpp numeric; v_fee numeric; v_loss numeric;
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

-- report_konsolidasi: F-14 tanggal bawaan menurut zona outlet.
create or replace function app.report_konsolidasi(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_type text := coalesce(p ->> 'type', 'konsolidasi');
  v_from date := coalesce(nullif(p ->> 'from', '')::date, app.outlet_today(null::uuid)); v_to date := coalesce(nullif(p ->> 'to', '')::date, app.outlet_today(null::uuid));
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

-- bootstrap: F-14 server_time menurut zona outlet aktif.
create or replace function app.bootstrap(p jsonb) returns jsonb
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

  v_res := jsonb_build_object('server_time', to_char(now() at time zone app.outlet_tz(v_out), 'YYYY-MM-DD HH24:MI:SS'),
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

-- ---------- F-15: kunci periode (khusus Owner global) ----------
-- sampai = 'YYYY-MM-DD' (tanggal terakhir yang dikunci) atau kosong untuk membuka semua kunci. Selalu beralasan dan tercatat di audit.
create function app.period_lock_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_old date := app.period_lock(); v_new date; v_why text := trim(coalesce(p ->> 'alasan', '')); v_org uuid;
begin
  perform app.require_role(null, array['owner']);
  if length(v_why) < 3 then raise exception 'Alasan wajib diisi.' using errcode = '22023'; end if;
  begin
    v_new := nullif(trim(coalesce(p ->> 'sampai', '')), '')::date;
  exception when others then
    raise exception 'Tanggal kunci tidak valid (format YYYY-MM-DD).' using errcode = '22023';
  end;
  if v_new is not null and v_new > app.outlet_today(null) then
    raise exception 'Tanggal kunci tidak boleh di masa depan.' using errcode = '22023';
  end if;
  select id into v_org from public.organizations limit 1;
  insert into public.settings (organization_id, outlet_id, key, value, updated_by, updated_at)
  values (v_org, null, 'kunci_periode_sampai', coalesce(to_char(v_new, 'YYYY-MM-DD'), ''), (select auth.uid()), now())
  on conflict (organization_id, coalesce(outlet_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
  do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
  perform app.audit(null, 'period_lock', 'settings', 'kunci_periode_sampai', jsonb_build_object('sampai', v_old),
                    jsonb_build_object('sampai', v_new, 'alasan', left(v_why, 300)));
  return jsonb_build_object('sampai', v_new, 'sebelumnya', v_old);
end $$;

-- ---------- F-17: tinjau selisih kas ----------
-- Menggantikan versi 0006: sesi sendiri tidak boleh disetujui; sesi berselisih wajib bercatatan; menyetujui ulang tidak mengubah apa pun.
create or replace function app.cash_approve(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.cash_sessions; v_note text := left(trim(coalesce(p ->> 'catatan', '')), 300);
begin
  select * into v from public.cash_sessions where id = nullif(p ->> 'id', '')::uuid for update;
  if not found or v.status <> 'closed' then raise exception 'Sesi kasir tidak ditemukan atau belum ditutup.' using errcode = 'P0002'; end if;
  perform app.require_role(v.outlet_id, array['owner','admin','supervisor']);
  if v.cashier_id = (select auth.uid()) then
    raise exception 'Tidak boleh meninjau sesi kasir milik sendiri. Minta supervisor/owner lain.' using errcode = '42501';
  end if;
  if v.approved_at is not null then return jsonb_build_object('id', v.id, 'approved', true, 'noop', true); end if;
  if coalesce(v.difference, 0) <> 0 and length(v_note) < 3 then
    raise exception 'Isi catatan hasil tinjauan untuk sesi yang berselisih (Rp%).', v.difference using errcode = '22023', hint = 'NOTE_REQUIRED';
  end if;
  update public.cash_sessions set approved_by = (select auth.uid()), approved_at = now(), approval_note = nullif(v_note, '') where id = v.id;
  perform app.audit(v.outlet_id, 'cash_approve', 'cash_sessions', v.id::text, null,
                    jsonb_build_object('selisih', v.difference, 'kasir', v.cashier_id, 'catatan', v_note));
  return jsonb_build_object('id', v.id, 'approved', true);
end $$;

-- Daftar penutupan kasir: nama kasir, sisa laci shift sebelumnya (fisik_sebelumnya, per outlet), status tinjauan. Waktu dalam zona OUTLET.
-- Kasir hanya melihat sesinya sendiri; supervisor/owner/admin/auditor melihat semua.
create function app.shift_list(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_o uuid := nullif(p ->> 'outlet_id', '')::uuid; v_lim int := least(greatest(coalesce(app.num(p, 'limit', 30), 30), 1), 100)::int;
        v_priv boolean; v_tz text; v_rows jsonb;
begin
  if (select auth.uid()) is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  if v_o is null then raise exception 'Outlet wajib dipilih.' using errcode = '22023'; end if;
  perform app.require_role(v_o, array['owner','admin','supervisor','kasir','auditor']);
  v_priv := app.has_role(v_o, array['owner','admin','supervisor','auditor']);
  v_tz := app.outlet_tz(v_o);
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'kasir_id', x.cashier_id, 'kasir', coalesce(x.full_name, '?'),
           'dari', to_char(x.opened_at at time zone v_tz, 'YYYY-MM-DD HH24:MI:SS'), 'sampai', to_char(x.closed_at at time zone v_tz, 'YYYY-MM-DD HH24:MI:SS'),
           'jumlah_trx', x.txn_count, 'total_tunai', (x.totals ->> 'tunai')::numeric, 'total_transfer', (x.totals ->> 'transfer')::numeric, 'total_qris', (x.totals ->> 'qris')::numeric,
           'total_lain', (x.totals ->> 'lain')::numeric, 'total_semua', (x.totals ->> 'total')::numeric, 'uang_fisik', x.actual_cash, 'selisih_tunai', x.difference,
           'catatan', x.note, 'modal_awal', x.opening_cash, 'kas_keluar', x.cash_out, 'tunai_diharapkan', x.expected_cash,
           'fisik_sebelumnya', case when v_priv then x.prev_cash end,
           'disetujui', x.approved_at is not null, 'disetujui_oleh', x.approver_name,
           'disetujui_pada', case when x.approved_at is not null then to_char(x.approved_at at time zone v_tz, 'YYYY-MM-DD HH24:MI') end,
           'catatan_tinjau', x.approval_note) order by x.closed_at desc), '[]'::jsonb)
    into v_rows
    from (select * from (
            select s.id, s.cashier_id, pr.full_name, s.opened_at, s.closed_at, s.txn_count, s.totals, s.actual_cash, s.difference, s.note, s.opening_cash,
                   s.cash_out, s.expected_cash, s.approved_at, ap.full_name as approver_name, s.approval_note,
                   lag(s.actual_cash) over (partition by s.outlet_id order by s.closed_at) as prev_cash
              from public.cash_sessions s
              join public.profiles pr on pr.id = s.cashier_id
              left join public.profiles ap on ap.id = s.approved_by
             where s.outlet_id = v_o and s.status = 'closed' and s.closed_at >= now() - interval '120 days') q
           where v_priv or q.cashier_id = (select auth.uid())
           order by q.closed_at desc limit v_lim) x;
  return v_rows;
end $$;

-- ---------- F-16: batalkan biaya ----------
-- Membuat baris pembalik (nominal negatif, void_of -> biaya asal). Biaya dari kas keluar laci tidak dapat dibatalkan (uang sudah keluar dari laci).
-- Bila tanggal biaya asal berada pada periode terkunci, pembalik bertanggal hari ini (periode terkunci tidak berubah).
create function app.expense_void(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v public.expenses; v_why text := trim(coalesce(p ->> 'alasan', ''));
        v_req text := nullif(trim(coalesce(p ->> 'request_id', '')), ''); v_dup jsonb; v_id uuid; v_date date;
begin
  if v_uid is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  select * into v from public.expenses where id = nullif(p ->> 'id', '')::uuid for update;
  if not found then raise exception 'Biaya tidak ditemukan.' using errcode = 'P0002'; end if;
  if v.outlet_id is null then perform app.require_role(null, array['owner','admin']);
  else perform app.require_role(v.outlet_id, array['owner','admin','supervisor']); end if;
  if v_req is not null then
    v_dup := app.idem_begin('expense_void', v_req, p);
    if v_dup is not null then return v_dup; end if;
  end if;
  if v.void_of is not null then raise exception 'Baris ini sendiri adalah pembatalan; tidak dapat dibatalkan lagi.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.expenses x where x.void_of = v.id) then raise exception 'Biaya ini sudah dibatalkan.' using errcode = 'P0001'; end if;
  if v.cash_session_id is not null then
    raise exception 'Biaya ini berasal dari kas keluar laci; uangnya sudah keluar dari laci sehingga tidak bisa dibatalkan di sini.' using errcode = 'P0001';
  end if;
  if length(v_why) < 3 then raise exception 'Alasan pembatalan wajib diisi.' using errcode = '22023'; end if;
  v_date := v.expense_date;
  if v_date <= coalesce(app.period_lock(), date '0001-01-01') then v_date := app.outlet_today(v.outlet_id); end if;
  insert into public.expenses (outlet_id, category, amount, expense_date, note, user_id, void_of, void_reason)
  values (v.outlet_id, v.category, -v.amount, v_date, left('PEMBATALAN: ' || v_why, 300), v_uid, v.id, left(v_why, 300))
  returning id into v_id;
  perform app.audit(v.outlet_id, 'expense_void', 'expenses', v.id::text, jsonb_build_object('nominal', v.amount, 'kategori', v.category, 'tanggal', v.expense_date),
                    jsonb_build_object('pembalik', v_id, 'alasan', left(v_why, 300)));
  return case when v_req is not null then app.idem_finish('expense_void', v_req, jsonb_build_object('id', v_id, 'void_of', v.id))
              else jsonb_build_object('id', v_id, 'void_of', v.id) end;
end $$;

-- ---------- F-16: batalkan pembelian ----------
-- Stok bahan dikurangi kembali (mutasi 'void_reverse' bernilai biaya efektif pembelian) dan HPP rata-rata dihitung ulang tanpa tranche pembelian itu.
-- Bila bahan sudah terpakai sehingga stok < jumlah dibeli, pembatalan ditolak (koreksi lewat opname).
create function app.purchase_cancel(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v public.purchases; v_i record; v_why text := trim(coalesce(p ->> 'alasan', ''));
        v_req text := nullif(trim(coalesce(p ->> 'request_id', '')), ''); v_dup jsonb; v_bal numeric; v_avg numeric; v_rest numeric; v_newavg numeric; v_name text;
begin
  if v_uid is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  select * into v from public.purchases where id = nullif(p ->> 'id', '')::uuid for update;
  if not found then raise exception 'Pembelian tidak ditemukan.' using errcode = 'P0002'; end if;
  perform app.require_role(v.outlet_id, array['owner','admin','supervisor']);
  if v_req is not null then
    v_dup := app.idem_begin('purchase_cancel', v_req, p);
    if v_dup is not null then return v_dup; end if;
  end if;
  if v.status <> 'posted' then raise exception 'Pembelian ini sudah dibatalkan.' using errcode = 'P0001'; end if;
  if length(v_why) < 3 then raise exception 'Alasan pembatalan wajib diisi.' using errcode = '22023'; end if;
  perform app.active_outlet(v.outlet_id);

  -- Periksa dulu seluruh bahan (terkunci berurutan): bila ada yang sudah terpakai, tidak ada yang berubah.
  for v_i in select i.material_id, sum(i.qty) as qty from public.purchase_items i where i.purchase_id = v.id group by i.material_id order by i.material_id loop
    select b.quantity into v_bal from public.inventory_material_balances b where b.outlet_id = v.outlet_id and b.material_id = v_i.material_id for update;
    if coalesce(v_bal, 0) + 0.0001 < v_i.qty then
      select m.name into v_name from public.materials m where m.id = v_i.material_id;
      raise exception 'Pembelian tidak dapat dibatalkan: stok % kini % (dibeli %), sebagian sudah terpakai. Koreksi lewat opname.',
        coalesce(v_name, '?'), coalesce(v_bal, 0), v_i.qty using errcode = 'P0001', hint = 'PURCHASE_CONSUMED';
    end if;
  end loop;

  for v_i in select i.material_id, i.qty, i.effective_cost from public.purchase_items i where i.purchase_id = v.id order by i.material_id, i.id loop
    select b.quantity, b.avg_cost into v_bal, v_avg from public.inventory_material_balances b where b.outlet_id = v.outlet_id and b.material_id = v_i.material_id for update;
    perform app.stock_apply(v.outlet_id, 'material', v_i.material_id, -v_i.qty, 'void_reverse', 'purchase', v.id, v_i.effective_cost, false, 'Batal pembelian: ' || left(v_why, 200));
    v_rest := v_bal - v_i.qty;
    if v_rest > 0.0001 then
      v_newavg := round((v_bal * v_avg - v_i.qty * v_i.effective_cost) / v_rest, 4);
      if v_newavg >= 0 then
        update public.inventory_material_balances set avg_cost = v_newavg, updated_at = now() where outlet_id = v.outlet_id and material_id = v_i.material_id;
      end if;
    end if;
  end loop;
  update public.purchases set status = 'cancelled', cancelled_at = now(), cancelled_by = v_uid, cancel_reason = left(v_why, 300) where id = v.id;
  perform app.audit(v.outlet_id, 'purchase_cancel', 'purchases', v.id::text, jsonb_build_object('total', v.total),
                    jsonb_build_object('alasan', left(v_why, 300)));
  return case when v_req is not null then app.idem_finish('purchase_cancel', v_req, jsonb_build_object('id', v.id, 'status', 'cancelled'))
              else jsonb_build_object('id', v.id, 'status', 'cancelled') end;
end $$;

-- ---------- F-08: perbaiki HPP kosong pada penjualan lama ----------
-- HPP baris penjualan yang belum diketahui (hpp_snapshot NULL) diisi dengan HPP rata-rata SAAT INI, hanya bila HPP itu sudah ada (> 0).
-- terapkan=false (bawaan) hanya menghitung dampak. Menerapkan mengubah laba periode itu, jadi hanya Owner/Admin, tidak boleh menyentuh periode terkunci,
-- dan dicatat di audit (rentang, jumlah baris, dampak nilai).
create function app.hpp_backfill(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_o public.outlets; v_from date; v_to date; v_apply boolean := lower(coalesce(p ->> 'terapkan', '')) in ('true', '1', 'ya');
        v_n int := 0; v_val numeric := 0; v_skip int := 0; v_t0 timestamptz; v_t1 timestamptz;
begin
  v_o := app.active_outlet(nullif(p ->> 'outlet_id', '')::uuid);
  perform app.require_role(v_o.id, array['owner','admin']);
  begin
    v_from := nullif(p ->> 'from', '')::date; v_to := nullif(p ->> 'to', '')::date;
  exception when others then
    raise exception 'Tanggal tidak valid.' using errcode = '22023';
  end;
  if v_from is null or v_to is null or v_to < v_from or v_to - v_from > 400 then
    raise exception 'Isi rentang tanggal yang valid (maksimal 400 hari).' using errcode = '22023';
  end if;
  v_t0 := v_from::timestamp at time zone v_o.timezone;
  v_t1 := (v_to + 1)::timestamp at time zone v_o.timezone;
  select count(*), coalesce(sum(i.qty * b.avg_cost), 0) into v_n, v_val
    from public.sale_items i join public.sales s on s.id = i.sale_id
    join public.inventory_balances b on b.outlet_id = s.outlet_id and b.variant_id = i.variant_id
   where s.outlet_id = v_o.id and s.status = 'completed' and s.sold_at >= v_t0 and s.sold_at < v_t1 and i.hpp_snapshot is null and b.avg_cost > 0;
  select count(*) into v_skip
    from public.sale_items i join public.sales s on s.id = i.sale_id
    left join public.inventory_balances b on b.outlet_id = s.outlet_id and b.variant_id = i.variant_id
   where s.outlet_id = v_o.id and s.status = 'completed' and s.sold_at >= v_t0 and s.sold_at < v_t1 and i.hpp_snapshot is null and coalesce(b.avg_cost, 0) <= 0;
  if v_apply and v_n > 0 then
    perform app.period_assert(v_from, 'Perbaikan HPP');
    update public.sale_items i set hpp_snapshot = b.avg_cost
      from public.sales s, public.inventory_balances b
     where s.id = i.sale_id and b.outlet_id = s.outlet_id and b.variant_id = i.variant_id
       and s.outlet_id = v_o.id and s.status = 'completed' and s.sold_at >= v_t0 and s.sold_at < v_t1 and i.hpp_snapshot is null and b.avg_cost > 0;
    perform app.audit(v_o.id, 'hpp_backfill', 'sale_items', null, null,
                      jsonb_build_object('dari', v_from, 'sampai', v_to, 'baris', v_n, 'dampak_hpp', v_val, 'tanpa_harga', v_skip));
  end if;
  return jsonb_build_object('terapkan', v_apply and v_n > 0, 'baris', v_n, 'dampak_hpp', v_val, 'tanpa_harga', v_skip, 'dari', v_from, 'sampai', v_to);
end $$;


-- ---------- Kontrak klien: waktu transaksi tertunda kini memakai bendera offline; klien < 2.5.0 harus diperbarui ----------
create or replace function public.rpc_schema_version(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    execute 'select max(version) from supabase_migrations.schema_migrations' into v;
  end if;
  return jsonb_build_object('version', coalesce(v, 'unknown'), 'min_client', '2.5.0');
end $$;

-- ---------- Pembungkus RPC publik + hak eksekusi ----------
do $$ declare n text; begin
  foreach n in array array['shift_list','cash_approve','expense_void','purchase_cancel','hpp_backfill','period_lock_set'] loop
    execute format('create or replace function public.rpc_%1$s(p jsonb default ''{}''::jsonb) returns jsonb language sql security invoker set search_path = '''' as $f$ select app.%1$s(p) $f$', n);
    execute format('revoke all on function public.rpc_%1$s(jsonb) from public, anon', n);
    execute format('grant execute on function public.rpc_%1$s(jsonb) to authenticated', n);
    execute format('revoke all on function app.%1$s(jsonb) from public, anon', n);
    execute format('grant execute on function app.%1$s(jsonb) to authenticated', n);
  end loop;
end $$;

