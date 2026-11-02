-- Tes migrasi 0033 (manifest cadangan, status cadangan, integritas semua outlet). Dijalankan setelah 001-012.
-- Yang dibuktikan: (1) manifest mendeteksi perubahan SEKECIL Rp 0,01 dan perubahan isi non-uang, tetapi tidak terpengaruh urutan fisik baris,
-- (2) sidik jari hak akses berubah bila satu GRANT dicabut, (3) akses dibatasi menurut peran, fungsi internal tidak terjangkau aplikasi,
-- (4) status cadangan: belum ada, sehat, usang, dan percobaan terakhir gagal, (5) integritas semua outlet ikut mendeteksi kerusakan dan tidak membocorkan identitas sesi.
\set ON_ERROR_STOP on

-- Menjalankan mutasi di subtransaksi, membaca satu nilai, lalu membatalkan semuanya.
create or replace function t.bk_probe(mut text, probe text) returns text language plpgsql as $$
declare res text;
begin
  begin
    execute 'set local session_replication_role = replica';
    execute mut;
    execute 'set local session_replication_role = origin';
    execute probe into res;
    raise exception 'undo';
  exception when others then
    if sqlerrm <> 'undo' then raise; end if;
  end;
  return res;
end $$;

-- ===== Bentuk manifest =====
do $$ declare m jsonb; k text; begin
  m := app.backup_manifest_core(true);
  perform t.ok((m ->> 'versi_manifest')::int = 1, 'versi manifest 1');
  foreach k in array array['public.sales', 'public.stock_movements', 'public.purchases', 'public.production_costs', 'app.backup_runs', 'public.inventory_balances'] loop
    perform t.ok(m -> 'tabel' ? k, 'manifest memuat tabel ' || k);
  end loop;
  perform t.ok((m -> 'tabel' -> 'public.sales' ->> 'hash') is not null, 'tabel public memiliki hash isi');
  perform t.ok((m ->> 'jumlah_tabel')::int >= 35, 'jumlah tabel wajar: ' || (m ->> 'jumlah_tabel'));
  perform t.ok((m -> 'kendali' -> 'penjualan') is not null and (m -> 'kendali' -> 'ledger') is not null and (m -> 'kendali' -> 'biaya_produksi') is not null, 'total kendali ada');
  perform t.ok(jsonb_typeof(m -> 'kendali' -> 'biaya_produksi' -> 'total') = 'string', 'uang dikeluarkan sebagai TEKS (bukan float JSON)');
  perform t.ok((m -> 'keamanan' ->> 'hak_tabel_hash') is not null and (m -> 'keamanan' ->> 'kebijakan_hash') is not null and (m -> 'keamanan' ->> 'hak_fungsi_hash') is not null, 'sidik jari keamanan ada');
  perform t.ok((m -> 'struktur' ->> 'konstrain_hash') is not null and (m -> 'struktur' ->> 'indeks_hash') is not null and (m -> 'struktur' ->> 'trigger_hash') is not null
               and (m -> 'struktur' ->> 'kolom_hash') is not null and (m -> 'struktur' ->> 'fungsi_hash') is not null, 'sidik jari struktur ada');
  perform t.ok((app.backup_manifest_core(true) - 'dibuat_pada') = (m - 'dibuat_pada'), 'manifest deterministik pada data yang sama');
  perform t.ok((app.backup_manifest_core(false) -> 'tabel' -> 'public.sales' ->> 'hash') is null, 'tanpa hash bila diminta (untuk RPC aplikasi)');
end $$;

-- ===== Sensitivitas =====
do $$ declare base jsonb := app.backup_manifest_core(true); v text; b text; begin
  -- Rp 0,01 pada satu penjualan: jumlah baris SAMA, total kendali dan hash tabel berubah
  v := t.bk_probe($m$update public.sales set total = total + 0.01 where id = (select id from public.sales order by created_at limit 1)$m$,
                  $p$select (app.backup_manifest_core(true) -> 'kendali' -> 'penjualan')::text$p$);
  b := (base -> 'kendali' -> 'penjualan')::text;
  perform t.ok(v is distinct from b, 'M1 selisih Rp 0,01 pada total penjualan terdeteksi di total kendali');
  v := t.bk_probe($m$update public.sales set total = total + 0.01 where id = (select id from public.sales order by created_at limit 1)$m$,
                  $p$select (app.backup_manifest_core(true) -> 'tabel' -> 'public.sales' ->> 'hash')$p$);
  perform t.ok(v is distinct from (base -> 'tabel' -> 'public.sales' ->> 'hash'), 'M1 hash isi tabel sales berubah padahal jumlah barisnya sama');
  v := t.bk_probe($m$update public.sales set total = total + 0.01 where id = (select id from public.sales order by created_at limit 1)$m$,
                  $p$select (app.backup_manifest_core(true) -> 'tabel' -> 'public.sales' ->> 'baris')$p$);
  perform t.ok(v = (base -> 'tabel' -> 'public.sales' ->> 'baris'), 'M1 jumlah baris tidak berubah (bukti: hitung baris saja TIDAK cukup)');

  -- perubahan non-uang (nama produk): hanya hash isi yang menangkapnya
  v := t.bk_probe($m$update public.products set name = name || 'x' where id = (select id from public.products order by created_at limit 1)$m$,
                  $p$select (app.backup_manifest_core(true) -> 'tabel' -> 'public.products' ->> 'hash')$p$);
  perform t.ok(v is distinct from (base -> 'tabel' -> 'public.products' ->> 'hash'), 'M2 perubahan nama produk terdeteksi lewat hash isi');

  -- kuantitas ledger
  v := t.bk_probe($m$update public.stock_movements set quantity_delta = quantity_delta + 0.0001 where id = (select min(id) from public.stock_movements)$m$,
                  $p$select (app.backup_manifest_core(true) -> 'kendali' -> 'ledger')::text$p$);
  perform t.ok(v is distinct from (base -> 'kendali' -> 'ledger')::text, 'M3 selisih 0,0001 pada kuantitas ledger terdeteksi');

  -- baris hilang
  v := t.bk_probe($m$delete from public.payments where id = (select id from public.payments limit 1)$m$,
                  $p$select (app.backup_manifest_core(true) -> 'tabel' -> 'public.payments' ->> 'baris')$p$);
  perform t.ok(v is distinct from (base -> 'tabel' -> 'public.payments' ->> 'baris'), 'M4 baris hilang terdeteksi');

  -- urutan fisik baris tidak boleh memengaruhi hash (pemulihan tidak menjamin urutan). Hanya SATU baris ditulis ulang agar ia pindah ke ujung heap;
  -- bukti bahwa urutan fisik benar-benar berubah diperiksa terpisah, supaya tes ini tidak lulus karena kebetulan.
  v := t.bk_probe($m$update public.channels set name = name where ctid = (select ctid from public.channels order by ctid limit 1)$m$,
                  $p$select (select string_agg(id::text, ',') from public.channels)$p$);
  perform t.ok(v is distinct from (select string_agg(id::text, ',') from public.channels), 'M5 prasyarat: urutan fisik baris channels memang berubah setelah ditulis ulang');
  v := t.bk_probe($m$update public.channels set name = name where ctid = (select ctid from public.channels order by ctid limit 1)$m$,
                  $p$select (app.backup_manifest_core(true) -> 'tabel' -> 'public.channels' ->> 'hash')$p$);
  perform t.ok(v = (base -> 'tabel' -> 'public.channels' ->> 'hash'), 'M5 menulis ulang satu baris (urutan fisik berubah) TIDAK mengubah hash');

  -- hak akses: mencabut satu GRANT mengubah sidik jari
  v := t.bk_probe($m$revoke select on public.channels from authenticated$m$, $p$select (app.backup_manifest_core(true) -> 'keamanan' ->> 'hak_tabel_hash')$p$);
  perform t.ok(v is distinct from (base -> 'keamanan' ->> 'hak_tabel_hash'), 'M6 mencabut satu GRANT tabel mengubah sidik jari hak tabel');
  v := t.bk_probe($m$grant execute on function app.backup_record(jsonb) to authenticated$m$, $p$select (app.backup_manifest_core(true) -> 'keamanan' ->> 'hak_fungsi_hash')$p$);
  perform t.ok(v is distinct from (base -> 'keamanan' ->> 'hak_fungsi_hash'), 'M7 membuka EXECUTE fungsi internal mengubah sidik jari hak fungsi');
  v := t.bk_probe($m$alter table public.profiles drop constraint profiles_id_fkey$m$, $p$select (app.backup_manifest_core(true) -> 'struktur' ->> 'konstrain_hash')$p$);
  perform t.ok(v is distinct from (base -> 'struktur' ->> 'konstrain_hash'), 'M8 menghapus satu FK mengubah sidik jari konstrain');
  v := t.bk_probe($m$alter table public.channels add column zz_probe int$m$, $p$select (app.backup_manifest_core(true) -> 'struktur' ->> 'kolom_hash')$p$);
  perform t.ok(v is distinct from (base -> 'struktur' ->> 'kolom_hash'), 'M9 menambah satu kolom mengubah sidik jari kolom');
  v := t.bk_probe($m$alter table public.channels disable row level security$m$, $p$select (app.backup_manifest_core(true) -> 'keamanan' ->> 'rls_tabel_hash')$p$);
  perform t.ok(v is distinct from (base -> 'keamanan' ->> 'rls_tabel_hash'), 'M8 mematikan RLS mengubah sidik jari RLS');
  v := t.bk_probe($m$drop policy sync_events_read on public.sync_events$m$, $p$select (app.backup_manifest_core(true) -> 'keamanan' ->> 'kebijakan_hash')$p$);
  perform t.ok(v is distinct from (base -> 'keamanan' ->> 'kebijakan_hash'), 'M9 menghapus satu kebijakan RLS mengubah sidik jari kebijakan');

  -- setelah semua mutasi dibatalkan, manifest kembali sama
  perform t.ok((app.backup_manifest_core(true) - 'dibuat_pada') = (base - 'dibuat_pada'), 'mutasi dibatalkan: manifest kembali identik');
end $$;

-- ===== Akses =====
do $$ declare e text; begin
  perform t.logout();
  e := t.err('rpc_backup_manifest', '{}'::jsonb);
  perform t.ok(e like '28000%', 'manifest tanpa sesi ditolak: ' || coalesce(e, 'NULL'));
  e := t.err('rpc_backup_status', '{}'::jsonb);
  perform t.ok(e like '28000%', 'status tanpa sesi ditolak: ' || coalesce(e, 'NULL'));
  perform t.login(t.id('ka'));
  e := t.err('rpc_backup_manifest', '{}'::jsonb);
  perform t.ok(e like '42501%', 'kasir tidak boleh melihat manifest: ' || coalesce(e, 'NULL'));
  e := t.err('rpc_backup_status', '{}'::jsonb);
  perform t.ok(e like '42501%', 'kasir tidak boleh melihat status cadangan: ' || coalesce(e, 'NULL'));
  perform t.logout(); perform t.login(t.id('ks'));
  e := t.err('rpc_backup_manifest', '{}'::jsonb);
  perform t.ok(e like '42501%', 'peran stok tidak boleh: ' || coalesce(e, 'NULL'));
  perform t.logout();
end $$;

do $$ declare m jsonb; begin
  perform t.login(t.id('owner'));
  m := public.rpc_backup_manifest('{}'::jsonb);
  perform t.logout();
  perform t.ok(m ? 'tabel' and m ? 'kendali', 'owner boleh melihat manifest');
  perform t.ok((m -> 'tabel' -> 'public.sales' ->> 'hash') is null and (m -> 'tabel' -> 'public.sales' ->> 'baris')::int > 0, 'RPC aplikasi: jumlah baris ada, hash tidak (ringan)');
end $$;

-- fungsi internal tidak dapat dipanggil dari aplikasi (peran authenticated)
do $$ declare ok1 boolean := false; ok2 boolean := false; ok3 boolean := false; begin
  perform t.login(t.id('owner'));
  begin perform app.backup_record(jsonb_build_object('ok', true)); exception when insufficient_privilege then ok1 := true; end;
  begin perform app.backup_manifest_core(true); exception when insufficient_privilege then ok2 := true; end;
  begin perform app.backup_integrity_all(); exception when insufficient_privilege then ok3 := true; end;
  perform t.logout();
  perform t.ok(ok1, 'app.backup_record tidak terjangkau aplikasi (owner sekalipun)');
  perform t.ok(ok2, 'app.backup_manifest_core tidak terjangkau aplikasi');
  perform t.ok(ok3, 'app.backup_integrity_all tidak terjangkau aplikasi');
end $$;

-- ===== Status cadangan =====
do $$ declare s jsonb; id1 bigint; begin
  delete from app.backup_runs;
  perform t.login(t.id('owner'));
  s := public.rpc_backup_status('{}'::jsonb);
  perform t.ok(not (s ->> 'ada_cadangan')::boolean and (s ->> 'peringatan')::boolean, 'belum pernah ada cadangan => peringatan');
  perform t.logout();

  id1 := app.backup_record(jsonb_build_object('ok', true, 'file_name', 'duado-uji.dump.gpg', 'size_bytes', 12345, 'photos_count', 2, 'tables_count', 40, 'integrity_violations', 0, 'note', 'uji'));
  perform t.login(t.id('owner'));
  s := public.rpc_backup_status('{}'::jsonb);
  perform t.ok((s ->> 'ada_cadangan')::boolean and not (s ->> 'peringatan')::boolean, 'cadangan baru => sehat: ' || s::text);
  perform t.ok((s -> 'terakhir_sah' ->> 'umur_jam')::numeric < 1 and (s -> 'terakhir_sah' ->> 'foto')::int = 2 and (s -> 'terakhir_sah' ->> 'temuan_integritas')::int = 0, 'rincian cadangan terakhir benar');
  perform t.logout();

  update app.backup_runs set finished_at = now() - interval '40 hours' where id = id1;
  perform t.login(t.id('owner'));
  s := public.rpc_backup_status('{}'::jsonb);
  perform t.ok((s ->> 'peringatan')::boolean and (s -> 'terakhir_sah' ->> 'umur_jam')::numeric between 39.9 and 40.2, 'cadangan 40 jam lalu => peringatan (ambang 36 jam)');
  s := public.rpc_backup_status(jsonb_build_object('ambang_jam', 48));
  perform t.ok(not (s ->> 'peringatan')::boolean, 'ambang dapat diatur (48 jam => sehat)');
  perform t.logout();

  perform app.backup_record(jsonb_build_object('ok', true, 'file_name', 'duado-baru.dump.gpg'));
  perform app.backup_record(jsonb_build_object('ok', false, 'file_name', 'duado-gagal', 'note', 'dump gagal'));
  perform t.login(t.id('owner'));
  s := public.rpc_backup_status('{}'::jsonb);
  perform t.ok((s ->> 'percobaan_terakhir_gagal')::boolean and (s ->> 'peringatan')::boolean and s ->> 'catatan_gagal' = 'dump gagal', 'percobaan terakhir gagal => peringatan walau ada cadangan sah sebelumnya');
  perform t.ok(s -> 'terakhir_sah' ->> 'berkas' = 'duado-baru.dump.gpg', 'cadangan sah terakhir tetap yang sah, bukan yang gagal');
  perform t.logout();
end $$;
do $$ declare e text; begin
  e := null;
  begin perform app.backup_record(jsonb_build_object('file_name', 'tanpa-ok')); exception when others then e := sqlstate; end;
  perform t.ok(e = '22023', 'backup_record menolak payload tanpa ok: ' || coalesce(e, 'NULL'));
  delete from app.backup_runs;
end $$;

-- ===== Integritas semua outlet =====
do $$ declare r jsonb; o text; begin
  r := app.backup_integrity_all();
  perform t.ok((r ->> 'tersedia')::boolean and r ? 'outlet' and r ? 'total_pelanggaran', 'integrity_all tersedia');
  perform t.ok(coalesce(current_setting('request.jwt.claim.sub', true), '') = '', 'identitas sesi sementara tidak bocor setelah selesai');
  perform t.ok(r -> 'outlet' -> 'ICK-001' ->> 'ok' = 'true' and (r -> 'outlet' -> 'ICK-001' ->> 'diperiksa')::int > 0, 'outlet uji Fase 1 (ICK-001) bersih dan benar-benar diperiksa');
  for o in select jsonb_object_keys(r -> 'outlet') loop
    perform t.ok((r -> 'outlet' -> o) ? 'per_kode' or (r -> 'outlet' -> o) ? 'dilewati', 'setiap outlet punya hasil atau alasan dilewati: ' || o);
  end loop;
end $$;
do $$ declare base jsonb := app.backup_integrity_all(); v int; begin
  v := t.bk_probe($m$update public.inventory_material_balances set quantity = quantity + 1 where (outlet_id, material_id) = (select outlet_id, material_id from public.inventory_material_balances where outlet_id = (select id from public.outlets where code = 'ICK-001') limit 1)$m$,
                  $p$select (app.backup_integrity_all() ->> 'total_pelanggaran')$p$)::int;
  perform t.ok(v >= (base ->> 'total_pelanggaran')::int + 1, 'integrity_all mendeteksi saldo rusak (K1) di semua outlet');
  perform t.ok((app.backup_integrity_all() ->> 'total_pelanggaran')::int = (base ->> 'total_pelanggaran')::int, 'setelah dibatalkan, jumlah temuan kembali');
end $$;
select 'Tes manifest dan status cadangan selesai' as hasil;
