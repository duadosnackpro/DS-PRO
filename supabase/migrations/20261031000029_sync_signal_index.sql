-- 0029 Perbaikan performa: app.sync_signal() melakukan seq scan pada sync_events.
-- Penyebab: kondisi "created_at > clock_timestamp() - interval '2 seconds'" memakai fungsi VOLATILE sehingga Postgres tidak boleh memakainya
-- sebagai kondisi indeks, dan "outlet_id IS NOT DISTINCT FROM x" juga tidak dapat memakai indeks btree. Pada 400 ribu baris (kira-kira satu hari
-- penjualan ramai di banyak outlet) tiap pemanggilan ~27 ms dan dipanggil dua kali per penjualan; throughput penjualan jatuh ~12x (tests/load).
-- Perbaikan: hitung batas waktu ke variabel (stabil) lalu pakai kondisi sama-dengan / IS NULL yang bisa memakai indeks (kind, outlet_id, created_at).
-- Perilaku tetap sama: satu sinyal per outlet per jenis per 2 detik.
create or replace function app.sync_signal(p_outlet uuid, p_kind text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_cut timestamptz := clock_timestamp() - interval '2 seconds'; v_has boolean;
begin
  if p_outlet is null then
    select exists (select 1 from public.sync_events e where e.kind = p_kind and e.outlet_id is null and e.created_at > v_cut) into v_has;
  else
    select exists (select 1 from public.sync_events e where e.kind = p_kind and e.outlet_id = p_outlet and e.created_at > v_cut) into v_has;
  end if;
  if not v_has then insert into public.sync_events (outlet_id, kind) values (p_outlet, p_kind); end if;
  if random() < 0.01 then delete from public.sync_events where created_at < now() - interval '1 day'; end if;
end $$;
revoke all on function app.sync_signal(uuid, text) from public, anon, authenticated;
