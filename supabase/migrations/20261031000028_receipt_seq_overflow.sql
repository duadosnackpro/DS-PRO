-- 0028 Perbaikan: nomor struk/retur/transfer bentrok setelah urutan ke-999 dalam sehari per outlet.
--
-- Cacat: nomor dibentuk dengan lpad(v_seq::text, 3, '0'). lpad() di Postgres MEMOTONG teks yang lebih panjang dari panjang target,
-- jadi urutan 1000 menjadi '100', 1001 menjadi '100', 1100 menjadi '110'. Nomor itu bentrok dengan struk ke-100 (indeks unik
-- sales_receipt_key) sehingga penjualan ke-1000 dan SEMUA penjualan sesudahnya di outlet tersebut gagal sampai tanggal lokal berganti.
-- Kegagalannya permanen: counter ikut di-rollback bersama transaksi, jadi percobaan ulang memakai urutan 1000 lagi. Terukur lewat load test (tests/load).
--
-- Perbaikan: app.seq_text() menambah nol di depan sampai 3 digit dan TIDAK memotong. Urutan >= 1000 menjadi 4 digit (OUT-001-261031-1000).
-- Fungsi yang memakai pola lama ditulis ulang di tempat (definisi terpasang diambil dari katalog) supaya semua versi/semua pemakai ikut benar
-- tanpa menyalin ulang fungsi besar. Hak akses dan pemilik fungsi tidak berubah (CREATE OR REPLACE).

create or replace function app.seq_text(p_seq integer) returns text
language sql immutable parallel safe set search_path = '' as $$
  select case when p_seq < 1000 then lpad(p_seq::text, 3, '0') else p_seq::text end
$$;
revoke all on function app.seq_text(integer) from public, anon, authenticated;
-- Tanpa hak untuk peran klien: hanya dipanggil dari fungsi SECURITY DEFINER (berjalan sebagai pemilik).

do $$
declare r record; d text; n int := 0; left_ int;
begin
  for r in
    select p.oid, p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'app' and p.prokind = 'f' and pg_get_functiondef(p.oid) like '%lpad(v_seq::text, 3, ''0'')%'
  loop
    d := replace(pg_get_functiondef(r.oid), 'lpad(v_seq::text, 3, ''0'')', 'app.seq_text(v_seq)');
    execute d;
    n := n + 1;
    raise notice 'diperbaiki: app.%', r.proname;
  end loop;
  select count(*) into left_ from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'app' and p.prokind = 'f' and pg_get_functiondef(p.oid) like '%lpad(v_seq::text, 3%';
  if left_ > 0 then raise exception 'Masih ada % fungsi yang memotong nomor urut (lpad v_seq).', left_; end if;
end $$;
