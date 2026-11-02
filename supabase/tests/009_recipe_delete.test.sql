-- Tes migrasi 0030: hapus resep (hapus lunak, hanya owner/admin, tercatat di audit). Dijalankan setelah 001-008.
\set ON_ERROR_STOP on
do $$
declare rid uuid; e text; r jsonb; n0 bigint;
begin
  insert into public.recipes (variant_id, name, standard_yield, kind, labor_cost) values (t.id('v1'), 'ZZ Resep Hapus', 10, 'batch', 1000) returning id into rid;
  insert into public.recipe_items (recipe_id, material_id, qty) select rid, id, 1 from public.materials limit 1;

  perform t.login(t.id('ka'));
  e := t.err('rpc_recipe_delete', jsonb_build_object('id', rid));
  perform t.ok(e like '42501%', 'kasir tidak boleh menghapus resep: ' || coalesce(e, 'NULL'));
  perform t.logout(); perform t.login(t.id('ks'));
  e := t.err('rpc_recipe_delete', jsonb_build_object('id', rid));
  perform t.ok(e like '42501%', 'peran stok tidak boleh menghapus resep: ' || coalesce(e, 'NULL'));
  perform t.logout();
  perform t.ok((select active from public.recipes where id = rid), 'resep masih aktif setelah percobaan ditolak');

  select count(*) into n0 from public.audit_logs where action = 'recipe_delete';
  perform t.login(t.id('owner'));
  r := public.rpc_recipe_delete(jsonb_build_object('id', rid));
  perform t.ok((r ->> 'id')::uuid = rid, 'owner berhasil menghapus resep');
  e := t.err('rpc_recipe_delete', jsonb_build_object('id', rid));
  perform t.ok(e like 'P0002%', 'hapus kedua kali ditolak (sudah dihapus): ' || coalesce(e, 'NULL'));
  e := t.err('rpc_recipe_delete', jsonb_build_object('id', gen_random_uuid()));
  perform t.ok(e like 'P0002%', 'id tidak ada ditolak: ' || coalesce(e, 'NULL'));
  e := t.err('rpc_recipe_delete', '{}'::jsonb);
  perform t.ok(e like 'P0002%', 'tanpa id ditolak: ' || coalesce(e, 'NULL'));
  perform t.logout();

  perform t.ok(exists (select 1 from public.recipes where id = rid and not active), 'hapus lunak: baris tetap ada dengan active = false (FK produksi aman)');
  perform t.ok((select count(*) from public.recipe_items where recipe_id = rid) = 1, 'bahan resep tidak ikut terhapus');
  perform t.ok((select count(*) from public.audit_logs where action = 'recipe_delete') = n0 + 1, 'tercatat di audit');
  -- resep yang dihapus tidak lagi ada di data awal klien (bootstrap memuat resep aktif saja)
  perform t.login(t.id('owner'));
  perform t.ok(not exists (select 1 from jsonb_array_elements(public.rpc_bootstrap(jsonb_build_object('outlet_id', t.id('o1'))) -> 'recipes') x where x ->> 'id' = rid::text), 'tidak muncul lagi di data klien');
  perform t.logout();
end $$;
select 'Tes hapus resep selesai' as hasil;
