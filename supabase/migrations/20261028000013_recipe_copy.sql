-- 0013 Salin resep ke varian lain secara atomik: resep baru + seluruh bahannya dalam SATU transaksi.
-- Hanya owner/admin (sama dengan kebijakan RLS recipes). Perubahan juga tercatat oleh trigger audit_row pada recipes/recipe_items.

create or replace function app.recipe_copy(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_src public.recipes; v_t jsonb; v_new public.recipes; v_out jsonb := '[]'::jsonb; v_var uuid;
begin
  perform app.require_role(null, array['owner','admin']);
  select * into v_src from public.recipes where id = nullif(p ->> 'source_id', '')::uuid and active;
  if not found then raise exception 'Resep sumber tidak ditemukan.' using errcode = 'P0002'; end if;
  if jsonb_typeof(p -> 'targets') is distinct from 'array' or jsonb_array_length(p -> 'targets') = 0 then
    raise exception 'Pilih minimal satu varian tujuan.' using errcode = '22023';
  end if;
  if jsonb_array_length(p -> 'targets') > 100 then raise exception 'Terlalu banyak varian tujuan (maksimal 100).' using errcode = '22023'; end if;

  for v_t in select * from jsonb_array_elements(p -> 'targets') loop
    v_var := nullif(v_t ->> 'variant_id', '')::uuid;
    if v_var is null or not exists (select 1 from public.product_variants where id = v_var) then
      raise exception 'Varian tujuan tidak ditemukan.' using errcode = 'P0002';
    end if;
    insert into public.recipes (variant_id, name, standard_yield, kind, labor_cost)
    values (v_var, coalesce(nullif(trim(v_t ->> 'nama'), ''), v_src.name || ' (salinan)'), v_src.standard_yield, v_src.kind, v_src.labor_cost)
    returning * into v_new;
    insert into public.recipe_items (recipe_id, material_id, qty)
    select v_new.id, material_id, qty from public.recipe_items where recipe_id = v_src.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_new.id, 'nama', v_new.name, 'variant_id', v_new.variant_id,
      'hasil_standar', v_new.standard_yield, 'jenis', v_new.kind, 'tenaga_kerja', v_new.labor_cost, 'aktif', true));
  end loop;
  perform app.audit(null, 'recipe_copy', 'recipes', v_src.id::text, null, jsonb_build_object('jumlah', jsonb_array_length(v_out)));
  return jsonb_build_object('dibuat', v_out);
end $$;

create or replace function public.rpc_recipe_copy(p jsonb default '{}'::jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select app.recipe_copy(p) $$;

revoke all on function public.rpc_recipe_copy(jsonb) from public, anon;
grant execute on function public.rpc_recipe_copy(jsonb) to authenticated;
revoke all on function app.recipe_copy(jsonb) from public, anon;
grant execute on function app.recipe_copy(jsonb) to authenticated;
