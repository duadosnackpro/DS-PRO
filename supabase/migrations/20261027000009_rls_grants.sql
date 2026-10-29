-- 0009 RLS, hak akses, pemicu audit, pembungkus RPC publik, fungsi bootstrap owner.
-- Prinsip: klien hanya MEMBACA tabel (dibatasi RLS per outlet/role). Semua perubahan transaksional lewat RPC atomik.
-- Katalog/master dapat diubah owner/admin langsung (RLS + pemicu audit). Kolom biaya (avg_cost, hpp_snapshot, unit_cost) tidak dapat dibaca langsung.

create function app.has_backoffice() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m join public.profiles p on p.id = m.user_id
    where m.user_id = (select auth.uid()) and m.status = 'active' and p.status = 'active'
      and m.role in ('owner','admin','supervisor','stok','produksi'));
$$;

create function app.can_see_user(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user = (select auth.uid()) or exists (
    select 1 from public.memberships m
    where m.user_id = p_user and m.status = 'active'
      and (m.outlet_id is null or m.outlet_id in (select app.my_outlet_ids())));
$$;

create index inventory_balances_ping on public.inventory_balances (outlet_id, updated_at desc);
create trigger channel_prices_touch before update on public.channel_prices for each row execute function app.touch_updated_at();
create trigger settings_touch before update on public.settings for each row execute function app.touch_updated_at();

-- Audit perubahan master (tanpa kolom rahasia: tabel-tabel ini tidak menyimpan kredensial).
create function app.audit_row() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_logs (organization_id, outlet_id, actor_id, action, entity, entity_id, before, after)
  values ((select id from public.organizations limit 1), null, (select auth.uid()), lower(tg_op), tg_table_name,
          coalesce((to_jsonb(new) ->> 'id'), (to_jsonb(old) ->> 'id'), (to_jsonb(new) ->> 'variant_id')),
          case when tg_op <> 'INSERT' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;
do $$ declare t text; begin
  foreach t in array array['channels','products','product_variants','channel_prices','outlet_prices','materials','suppliers','recipes','recipe_items'] loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function app.audit_row()', t || '_audit', t);
  end loop;
end $$;

-- ---------- RLS ----------
do $$ declare t text; begin
  foreach t in array array['organizations','outlets','profiles','memberships','settings','audit_logs','channels','products','product_variants',
    'channel_prices','outlet_prices','materials','suppliers','recipes','recipe_items','inventory_balances','inventory_material_balances','stock_movements',
    'cash_sessions','sales','sale_items','payments','cash_movements','expenses','import_batches','external_orders','purchases','purchase_items',
    'production_orders','production_costs','stock_transfers','stock_transfer_items'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

create policy organizations_read on public.organizations for select to authenticated using ((select app.is_member_any()));
create policy outlets_read on public.outlets for select to authenticated using (id in (select app.my_outlet_ids()));
create policy profiles_read on public.profiles for select to authenticated using ((select app.can_see_user(id)));
create policy memberships_read on public.memberships for select to authenticated
  using (user_id = (select auth.uid()) or (select app.has_role(outlet_id, array['owner','admin'])));
create policy settings_read on public.settings for select to authenticated using (
  (select app.has_role(outlet_id, array['owner','admin']))
  or (key = any (app.public_setting_keys()) and (outlet_id is null or outlet_id in (select app.my_outlet_ids())) and (select app.is_member_any())));
create policy audit_read on public.audit_logs for select to authenticated using ((select app.has_role(outlet_id, array['owner','admin','auditor'])));

-- Katalog: dibaca semua anggota; diubah owner/admin global.
create policy channels_read on public.channels for select to authenticated using ((select app.is_member_any()));
create policy products_read on public.products for select to authenticated using ((select app.is_member_any()));
create policy variants_read on public.product_variants for select to authenticated using ((select app.is_member_any()));
create policy cprices_read on public.channel_prices for select to authenticated using ((select app.is_member_any()));
create policy oprices_read on public.outlet_prices for select to authenticated using (outlet_id in (select app.my_outlet_ids()));
create policy materials_read on public.materials for select to authenticated using ((select app.has_backoffice()));
create policy suppliers_read on public.suppliers for select to authenticated using ((select app.has_backoffice()));
create policy recipes_read on public.recipes for select to authenticated using ((select app.has_backoffice()));
create policy recipe_items_read on public.recipe_items for select to authenticated using ((select app.has_backoffice()));
do $$ declare t text; begin
  foreach t in array array['channels','products','product_variants','channel_prices','outlet_prices','materials','suppliers','recipes','recipe_items'] loop
    execute format('create policy %I on public.%I for insert to authenticated with check ((select app.has_role(null, array[''owner'',''admin''])))', t || '_ins', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select app.has_role(null, array[''owner'',''admin'']))) with check ((select app.has_role(null, array[''owner'',''admin''])))', t || '_upd', t);
  end loop;
end $$;
create policy cprices_del on public.channel_prices for delete to authenticated using ((select app.has_role(null, array['owner','admin'])));
create policy oprices_del on public.outlet_prices for delete to authenticated using ((select app.has_role(null, array['owner','admin'])));
create policy recipe_items_del on public.recipe_items for delete to authenticated using ((select app.has_role(null, array['owner','admin'])));

-- Persediaan dan ledger: dibaca sesuai outlet. Tidak ada kebijakan tulis => hanya RPC.
create policy balances_read on public.inventory_balances for select to authenticated using (outlet_id in (select app.my_outlet_ids()));
create policy mbalances_read on public.inventory_material_balances for select to authenticated
  using ((select app.has_role(outlet_id, array['owner','admin','supervisor','stok','produksi','auditor'])));
create policy movements_read on public.stock_movements for select to authenticated
  using ((select app.has_role(outlet_id, array['owner','admin','supervisor','stok','produksi','auditor'])));

-- Penjualan: supervisor ke atas melihat seluruh outlet; kasir hanya miliknya.
create policy sales_read on public.sales for select to authenticated using (
  (select app.has_role(outlet_id, array['owner','admin','supervisor','auditor']))
  or (cashier_id = (select auth.uid()) and (select app.has_role(outlet_id, array['kasir']))));
create policy sale_items_read on public.sale_items for select to authenticated
  using (exists (select 1 from public.sales s where s.id = sale_items.sale_id));
create policy payments_read on public.payments for select to authenticated
  using (exists (select 1 from public.sales s where s.id = payments.sale_id));
create policy sessions_read on public.cash_sessions for select to authenticated using (
  (select app.has_role(outlet_id, array['owner','admin','supervisor','auditor'])) or cashier_id = (select auth.uid()));
create policy cash_movements_read on public.cash_movements for select to authenticated using (
  (select app.has_role(outlet_id, array['owner','admin','supervisor','auditor'])) or user_id = (select auth.uid()));
create policy expenses_read on public.expenses for select to authenticated using ((select app.has_role(outlet_id, array['owner','admin','supervisor','auditor'])));
create policy imports_read on public.import_batches for select to authenticated using ((select app.has_role(outlet_id, array['owner','admin','supervisor','auditor'])));
create policy extorders_read on public.external_orders for select to authenticated using ((select app.has_role(outlet_id, array['owner','admin','supervisor','auditor'])));

create policy purchases_read on public.purchases for select to authenticated using ((select app.has_role(outlet_id, array['owner','admin','supervisor','stok','auditor'])));
create policy purchase_items_read on public.purchase_items for select to authenticated using (exists (select 1 from public.purchases x where x.id = purchase_items.purchase_id));
create policy production_read on public.production_orders for select to authenticated using (
  (select app.has_role(kitchen_outlet_id, array['owner','admin','supervisor','produksi','auditor'])) or (select app.has_role(output_outlet_id, array['owner','admin','supervisor','produksi','auditor'])));
create policy production_costs_read on public.production_costs for select to authenticated using ((select app.has_role(null, array['owner','admin','auditor'])));
create policy transfers_read on public.stock_transfers for select to authenticated using (
  (select app.has_role(from_outlet_id, array['owner','admin','supervisor','stok','auditor'])) or (select app.has_role(to_outlet_id, array['owner','admin','supervisor','stok','auditor'])));
create policy transfer_items_read on public.stock_transfer_items for select to authenticated using (exists (select 1 from public.stock_transfers x where x.id = stock_transfer_items.transfer_id));

-- ---------- Hak tabel (daftar putih; kolom biaya tidak diberikan) ----------
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon;
revoke all on all functions in schema app from public, anon, authenticated;

grant select on public.organizations, public.outlets, public.memberships, public.settings, public.audit_logs, public.channels, public.products,
  public.product_variants, public.channel_prices, public.outlet_prices, public.materials, public.suppliers, public.recipes, public.recipe_items,
  public.cash_sessions, public.sales, public.payments, public.cash_movements, public.expenses, public.import_batches, public.external_orders,
  public.purchases, public.purchase_items, public.production_orders, public.production_costs, public.stock_transfers to authenticated;
grant select (id, username, full_name, status, default_outlet_id) on public.profiles to authenticated;
grant select (outlet_id, variant_id, quantity, min_qty, updated_at) on public.inventory_balances to authenticated;
grant select (outlet_id, material_id, quantity, min_qty, updated_at) on public.inventory_material_balances to authenticated;
grant select (id, outlet_id, item_type, item_id, movement_type, quantity_delta, balance_after, reference_type, reference_id, user_id, note, created_at)
  on public.stock_movements to authenticated;
grant select (id, sale_id, outlet_id, variant_id, sku_snapshot, name_snapshot, qty, unit_price, line_total) on public.sale_items to authenticated;
grant select (id, transfer_id, item_type, item_id, qty_requested, qty_sent, qty_received, variance) on public.stock_transfer_items to authenticated;
grant insert, update on public.channels, public.products, public.product_variants, public.materials, public.suppliers, public.recipes to authenticated;
grant insert, update, delete on public.channel_prices, public.outlet_prices, public.recipe_items to authenticated;
-- Pembaruan kolom tertentu pada profil sendiri tidak diberikan: profil diubah lewat Edge Function admin-users / RPC.

grant usage on schema app to authenticated;
grant execute on function app.has_role(uuid, text[]), app.is_owner(), app.is_member_any(), app.my_outlet_ids(), app.has_backoffice(),
  app.can_see_user(uuid), app.public_setting_keys() to authenticated;

-- ---------- Pembungkus RPC publik (SECURITY INVOKER) -> fungsi app.* ----------
do $$ declare n text; begin
  foreach n in array array['sale_create','sale_batch','sale_return','cash_open','cash_summary','cash_movement_add','cash_close','cash_approve','expense_create',
    'outlet_create','outlet_update','membership_set','profile_set_status','stock_adjust','purchase_create','production_create','production_cancel',
    'production_complete','transfer_create','transfer_action','settings_set','ping','stock_get','bootstrap','sales_list','sale_detail',
    'report_sales','report_pnl','report_stock_value','stock_reconcile','cost_snapshot'] loop
    execute format('create function public.rpc_%1$s(p jsonb default ''{}''::jsonb) returns jsonb language sql security invoker set search_path = '''' as $f$ select app.%1$s(p) $f$', n);
    execute format('revoke all on function public.rpc_%1$s(jsonb) from public, anon', n);
    execute format('grant execute on function public.rpc_%1$s(jsonb) to authenticated', n);
    execute format('grant execute on function app.%1$s(jsonb) to authenticated', n);
  end loop;
end $$;

-- ---------- Bootstrap owner pertama (dijalankan manual oleh postgres/service_role; TIDAK dapat dipanggil klien) ----------
create function app.bootstrap_owner(p_user uuid, p_username text, p_full_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'Pengguna auth % tidak ada.', p_user; end if;
  insert into public.profiles (id, username, full_name) values (p_user, lower(p_username), p_full_name) on conflict (id) do nothing;
  insert into public.memberships (user_id, outlet_id, role) values (p_user, null, 'owner')
    on conflict (user_id, coalesce(outlet_id, '00000000-0000-0000-0000-000000000000'::uuid)) do update set role = 'owner', status = 'active';
end $$;
revoke all on function app.bootstrap_owner(uuid, text, text) from public, anon, authenticated;
