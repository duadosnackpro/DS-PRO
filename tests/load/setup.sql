-- Data beban untuk tests/load. HANYA untuk database uji kosong (jangan arahkan ke produksi!).
-- Dipakai: psql -v nout=10 -v percash=3 -v nvar=30 -f setup.sql   (nout outlet, percash kasir per outlet, nvar varian)
-- ID deterministik (md5) supaya skrip pgbench tidak perlu mencari ID: outlet-i, cashier-n, variant-v, channel.
\set ON_ERROR_STOP on
select set_config('load.nout', :'nout', false), set_config('load.percash', :'percash', false), set_config('load.nvar', :'nvar', false);
do $$
declare nout int := current_setting('load.nout')::int; percash int := current_setting('load.percash')::int; nvar int := current_setting('load.nvar')::int;
  org uuid; i int; n int; v int; ch uuid := md5('channel')::uuid; o uuid; pr uuid;
begin
  select id into org from public.organizations limit 1;
  insert into public.channels (id, name) values (ch, 'Kasir Toko');
  insert into public.products (id, name, category) values (md5('product')::uuid, 'Produk Beban', 'Uji') returning id into pr;
  for v in 1 .. nvar loop
    insert into public.product_variants (id, product_id, sku, size) values (md5('variant-' || v)::uuid, pr, 'LD-' || v, v || 'g');
    insert into public.channel_prices (variant_id, channel_id, price) values (md5('variant-' || v)::uuid, ch, 5000 + v * 500);
  end loop;
  for i in 1 .. nout loop
    o := md5('outlet-' || i)::uuid;
    insert into public.outlets (id, organization_id, code, name) values (o, org, 'LD-' || lpad(i::text, 3, '0'), 'Outlet Beban ' || i);
    insert into public.inventory_balances (outlet_id, variant_id, quantity, avg_cost)
      select o, md5('variant-' || g)::uuid, 10000000, 3000 from generate_series(1, nvar) g;
  end loop;
  for n in 0 .. nout * percash - 1 loop
    i := n / percash + 1; o := md5('outlet-' || i)::uuid;
    insert into auth.users (id, email) values (md5('cashier-' || n)::uuid, 'ld' || n || '@t');
    insert into public.profiles (id, username, full_name) values (md5('cashier-' || n)::uuid, 'ld.kasir.' || n, 'Kasir Beban ' || n);
    insert into public.memberships (user_id, outlet_id, role) values (md5('cashier-' || n)::uuid, o, 'kasir');
    insert into public.cash_sessions (outlet_id, cashier_id, opening_cash, status) values (o, md5('cashier-' || n)::uuid, 100000, 'open');
  end loop;
end $$;
analyze;
