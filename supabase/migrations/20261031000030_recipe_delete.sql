-- 0030 Hapus resep. Tombol "Hapus resep" di UI memanggil master.remove(recipes), tetapi tidak ada jalur hapus di backend
-- (tabel recipes hanya punya policy baca; penulisan lewat RPC) sehingga selalu gagal: "Tabel ini belum didukung: recipes".
-- Hapus LUNAK (active = false): production_orders mereferensikan recipes lewat FK, dan resep yang pernah dipakai harus tetap ada untuk riwayat
-- serta penyelesaian pesanan produksi yang sudah berjalan (app.production_complete membaca resep tanpa memeriksa active).
-- Klien hanya memuat resep aktif, jadi resep langsung hilang dari layar. Hanya owner/admin; tercatat di audit.
create or replace function app.recipe_delete(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_r public.recipes;
begin
  perform app.require_role(null, array['owner','admin']);
  update public.recipes set active = false where id = nullif(p ->> 'id', '')::uuid and active returning * into v_r;
  if not found then raise exception 'Resep tidak ditemukan atau sudah dihapus.' using errcode = 'P0002'; end if;
  perform app.audit(null, 'recipe_delete', 'recipes', v_r.id::text, jsonb_build_object('nama', v_r.name, 'variant_id', v_r.variant_id), null);
  return jsonb_build_object('id', v_r.id);
end $$;
revoke all on function app.recipe_delete(jsonb) from public, anon;
grant execute on function app.recipe_delete(jsonb) to authenticated;

create or replace function public.rpc_recipe_delete(p jsonb default '{}'::jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select app.recipe_delete(p) $$;
revoke all on function public.rpc_recipe_delete(jsonb) from public, anon;
grant execute on function public.rpc_recipe_delete(jsonb) to authenticated;
