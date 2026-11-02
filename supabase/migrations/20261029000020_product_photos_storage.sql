-- 0020 Penyimpanan foto produk (bucket product-photos + kebijakan akses).
-- Sebelumnya hanya dibuat manual di project produksi sehingga tidak ada di repo.
-- Aman dijalankan ulang (idempoten) dan aman di Postgres biasa (CI): dilewati bila skema storage tidak ada.
-- Aturan: semua pengguna login boleh melihat; hanya owner/admin yang boleh unggah, ganti, dan hapus.
do $$
begin
  if to_regclass('storage.buckets') is not null and to_regclass('storage.objects') is not null then

    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('product-photos', 'product-photos', true, 262144, array['image/webp', 'image/jpeg', 'image/png'])
    on conflict (id) do update
      set public = excluded.public,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;

    drop policy if exists product_photos_read on storage.objects;
    create policy product_photos_read on storage.objects for select to authenticated
      using (bucket_id = 'product-photos');

    drop policy if exists product_photos_insert on storage.objects;
    create policy product_photos_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'product-photos' and (select app.has_role(null::uuid, array['owner', 'admin'])));

    drop policy if exists product_photos_update on storage.objects;
    create policy product_photos_update on storage.objects for update to authenticated
      using (bucket_id = 'product-photos' and (select app.has_role(null::uuid, array['owner', 'admin'])))
      with check (bucket_id = 'product-photos' and (select app.has_role(null::uuid, array['owner', 'admin'])));

    drop policy if exists product_photos_delete on storage.objects;
    create policy product_photos_delete on storage.objects for delete to authenticated
      using (bucket_id = 'product-photos' and (select app.has_role(null::uuid, array['owner', 'admin'])));

  else
    raise notice 'Skema storage tidak tersedia (Postgres biasa): migrasi foto produk dilewati.';
  end if;
end $$;
