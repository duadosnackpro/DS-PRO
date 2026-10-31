-- 0031 Buka kembali penutupan kasir yang salah input.
-- Sebelumnya penutupan (cash_close) final: salah ketik uang laci/catatan tidak bisa diperbaiki. Sekarang owner/admin (atau supervisor untuk sesi
-- KASIR LAIN) dapat membuka kembali sesi yang sudah ditutup dengan ALASAN wajib, lalu kasir menutupnya ulang dengan angka yang benar.
-- Tidak ada baris yang dihapus: sesi yang sama kembali 'open' (penjualan/kas masuk-keluar tetap menempel), hasil penutupan lama dikosongkan,
-- dan seluruh nilai lama (uang fisik, selisih, catatan, tinjauan) disimpan di audit_logs.before.
-- Syarat: sesi adalah penutupan TERAKHIR milik kasirnya, kasir itu tidak sedang punya sesi terbuka (mis. hasil buka otomatis oleh penjualan baru),
-- dan tanggal penutupan belum berada pada periode yang dikunci.
create or replace function app.cash_reopen(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v public.cash_sessions; v_why text := trim(coalesce(p ->> 'alasan', ''));
        v_day date;
begin
  if v_uid is null then raise exception 'Sesi berakhir, silakan masuk lagi.' using errcode = '28000'; end if;
  select * into v from public.cash_sessions where id = nullif(p ->> 'id', '')::uuid for update;
  if not found then raise exception 'Sesi kasir tidak ditemukan.' using errcode = 'P0002'; end if;
  if v.status <> 'closed' then raise exception 'Sesi kasir ini masih terbuka; tidak ada yang perlu dibuka kembali.' using errcode = 'P0001'; end if;
  perform app.require_role(v.outlet_id, array['owner','admin','supervisor']);
  if v.cashier_id = v_uid and not app.has_role(v.outlet_id, array['owner','admin']) then
    raise exception 'Tidak boleh membuka kembali penutupan milik sendiri. Minta owner/admin.' using errcode = '42501';
  end if;
  if length(v_why) < 3 then raise exception 'Alasan membuka kembali wajib diisi (min. 3 huruf).' using errcode = '22023', hint = 'NOTE_REQUIRED'; end if;
  perform app.active_outlet(v.outlet_id);
  v_day := (v.closed_at at time zone app.outlet_tz(v.outlet_id))::date;
  perform app.period_assert(v_day, 'Penutupan kasir');
  if exists (select 1 from public.cash_sessions x where x.cashier_id = v.cashier_id and x.status = 'open') then
    raise exception 'Kasir ini sudah punya sesi yang sedang terbuka. Tutup sesi itu dulu, lalu buka kembali penutupan yang salah.' using errcode = 'P0001', hint = 'SESSION_OPEN';
  end if;
  if exists (select 1 from public.cash_sessions x where x.cashier_id = v.cashier_id and x.status = 'closed' and x.closed_at > v.closed_at) then
    raise exception 'Hanya penutupan TERAKHIR milik kasir ini yang dapat dibuka kembali.' using errcode = 'P0001', hint = 'NOT_LATEST';
  end if;

  update public.cash_sessions set status = 'open', closed_at = null, txn_count = null, totals = null, cash_in = null, cash_out = null,
    expected_cash = null, actual_cash = null, difference = null, note = null, approved_by = null, approved_at = null, approval_note = null
  where id = v.id;

  perform app.audit(v.outlet_id, 'cash_reopen', 'cash_sessions', v.id::text,
    jsonb_build_object('uang_fisik', v.actual_cash, 'diharapkan', v.expected_cash, 'selisih', v.difference, 'catatan', v.note, 'ditutup', v.closed_at,
                       'ditinjau_oleh', v.approved_by, 'catatan_tinjau', v.approval_note),
    jsonb_build_object('alasan', left(v_why, 300), 'kasir', v.cashier_id));
  return jsonb_build_object('id', v.id, 'kasir_id', v.cashier_id, 'dibuka_kembali', true);
end $$;
revoke all on function app.cash_reopen(jsonb) from public, anon;
grant execute on function app.cash_reopen(jsonb) to authenticated;

create or replace function public.rpc_cash_reopen(p jsonb default '{}'::jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select app.cash_reopen(p) $$;
revoke all on function public.rpc_cash_reopen(jsonb) from public, anon;
grant execute on function public.rpc_cash_reopen(jsonb) to authenticated;
