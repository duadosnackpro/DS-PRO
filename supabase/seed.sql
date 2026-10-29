-- Data awal: organisasi, satu outlet (OUT-001) dan pengaturan bawaan. Aman diulang.
insert into public.organizations (id, name)
select gen_random_uuid(), 'DUADO SNACK' where not exists (select 1 from public.organizations);

insert into public.outlets (organization_id, code, name, kind, status, opened_on)
select o.id, 'OUT-001', 'Outlet Utama', 'store', 'active', current_date from public.organizations o
where not exists (select 1 from public.outlets where code = 'OUT-001');

insert into public.settings (organization_id, outlet_id, key, value)
select o.id, null, s.k, s.v from public.organizations o,
 (values ('diskon_maks_persen','10'),('bayar_tunai','TRUE'),('bayar_transfer','TRUE'),('bayar_qris','TRUE'),('tolak_selisih_total','TRUE'),
         ('block_negative_stock','true'),('wajib_buka_kasir','true'),('retur_kasir','false'),('transfer_perlu_persetujuan','true'),
         ('selisih_ambang_catatan','0'),('ppn_aktif','FALSE'),('ppn_persen','0'),('ppn_inklusif','FALSE'),('nama_usaha','DUADO SNACK')) as s(k, v)
on conflict do nothing;

-- Owner pertama: buat pengguna di Supabase Auth (email username@users.duado.local, password = PIN 6 angka), lalu jalankan:
--   select app.bootstrap_owner('<uuid-auth-user>', 'owner', 'Nama Owner');
