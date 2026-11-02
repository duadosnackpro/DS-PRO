-- Vektor uji uang bersama (tests/vectors/money.json): nilai harapan dihitung terpisah di Python (Decimal), lalu diperiksa terhadap RPC ASLI di sini
-- dan terhadap kode klien asli di tests/vectors_money.js. Dijalankan setelah 001-011 dari direktori supabase/.
\set ON_ERROR_STOP on
\set vec `cat ../tests/vectors/money.json`
create table if not exists t.vec (j jsonb);
delete from t.vec;
insert into t.vec values (:'vec'::jsonb);

do $$
declare j jsonb := (select j from t.vec); org uuid; o uuid; c jsonb; it jsonb; i int; mats uuid[]; m uuid; r jsonb; pid uuid; n int := 0;
  got numeric; k int := 0; ch uuid; pr uuid; vk uuid; rid uuid; po jsonb; b jsonb; cs record; n_ok int := 0;
begin
  select id into org from public.organizations limit 1;
  insert into public.outlets (organization_id, code, name, kind) values (org, 'VEC-001', 'Outlet Vektor', 'store') returning id into o;
  perform t.login(t.id('owner'));

  -- 1) Alokasi ongkir: biaya efektif per satuan, subtotal, total
  for c in select * from jsonb_array_elements(j -> 'purchase_alloc') loop
    k := k + 1; mats := '{}';
    for i in 0 .. jsonb_array_length(c -> 'items') - 1 loop
      insert into public.materials (name, unit) values ('ZZV alokasi ' || k || '-' || i, 'kg') returning id into m; mats := mats || m;
    end loop;
    r := public.rpc_purchase_create(jsonb_build_object('outlet_id', o, 'request_id', 'req-vec-a' || k, 'ongkir', (c ->> 'ongkir')::numeric, 'alokasi_ongkir', (c ->> 'alokasi')::boolean,
      'items', (select jsonb_agg(jsonb_build_object('material_id', mats[ord::int], 'qty', (e ->> 'qty')::numeric, 'harga_satuan', (e ->> 'harga')::numeric) order by ord)
                from jsonb_array_elements(c -> 'items') with ordinality as x(e, ord))));
    pid := (r ->> 'id')::uuid;
    perform t.ok((select subtotal from public.purchases where id = pid) = (c -> 'expect' ->> 'subtotal')::numeric, 'alokasi "' || (c ->> 'nama') || '": subtotal sama dengan harapan');
    perform t.ok((select total from public.purchases where id = pid) = (c -> 'expect' ->> 'total')::numeric, 'alokasi "' || (c ->> 'nama') || '": total sama dengan harapan');
    for i in 0 .. jsonb_array_length(c -> 'items') - 1 loop
      select effective_cost into got from public.purchase_items where purchase_id = pid and material_id = mats[i + 1];
      perform t.ok(got = ((c -> 'expect' -> 'eff') ->> i)::numeric, 'alokasi "' || (c ->> 'nama') || '": biaya efektif baris ' || (i + 1) || ' = ' || ((c -> 'expect' -> 'eff') ->> i) || ', server ' || got);
      n_ok := n_ok + 1;
    end loop;
  end loop;

  -- 2) Rata-rata tertimbang (stock_apply) setelah beberapa pembelian
  k := 0;
  for c in select * from jsonb_array_elements(j -> 'avg_cost') loop
    k := k + 1; insert into public.materials (name, unit) values ('ZZV rata ' || k, 'kg') returning id into m;
    i := 0;
    for it in select * from jsonb_array_elements(c -> 'pembelian') loop
      i := i + 1;
      perform public.rpc_purchase_create(jsonb_build_object('outlet_id', o, 'request_id', 'req-vec-r' || k || '-' || i, 'ongkir', 0,
        'items', jsonb_build_array(jsonb_build_object('material_id', m, 'qty', (it ->> 'qty')::numeric, 'harga_satuan', (it ->> 'harga')::numeric))));
    end loop;
    perform t.logout(); select * into cs from public.inventory_material_balances where outlet_id = o and material_id = m; perform t.login(t.id('owner'));   -- tabel saldo hanya dibaca superuser di tes
    perform t.ok(cs.avg_cost = (c -> 'expect' ->> 'avg')::numeric, 'rata-rata "' || (c ->> 'nama') || '": ' || cs.avg_cost || ' harapan ' || (c -> 'expect' ->> 'avg'));
    perform t.ok(cs.quantity = (c -> 'expect' ->> 'qty')::numeric, 'rata-rata "' || (c ->> 'nama') || '": qty ' || cs.quantity);
  end loop;

  -- 3) Biaya produksi: komponen, total, HPP per unit
  insert into public.channels (name) values ('Kanal Vektor') returning id into ch;
  insert into public.products (name, category) values ('ZZ Produk Vektor', 'Uji') returning id into pr;
  k := 0;
  for c in select * from jsonb_array_elements(j -> 'production') loop
    k := k + 1;
    insert into public.product_variants (product_id, sku) values (pr, 'ZZV-P' || k) returning id into vk;
    insert into public.recipes (variant_id, name, standard_yield, kind, labor_cost) values (vk, 'ZZ Resep Vektor ' || k, 10, 'batch', 0) returning id into rid;
    for b in select * from jsonb_array_elements(c -> 'bahan') loop
      insert into public.materials (name, unit, type) values ('ZZV prod ' || k || '-' || md5(b::text), 'kg', b ->> 'tipe') returning id into m;
      insert into public.recipe_items (recipe_id, material_id, qty) values (rid, m, (b ->> 'per_batch')::numeric);
      -- biaya rata-rata bahan dibuat lewat pembelian tanpa ongkir; stok besar agar cukup
      perform public.rpc_purchase_create(jsonb_build_object('outlet_id', o, 'request_id', 'req-vec-p' || k || '-' || md5(b::text), 'ongkir', 0,
        'items', jsonb_build_array(jsonb_build_object('material_id', m, 'qty', 1000, 'harga_satuan', (b ->> 'avg')::numeric))));
    end loop;
    po := public.rpc_production_create(jsonb_build_object('kitchen_outlet_id', o, 'output_outlet_id', o, 'recipe_id', rid, 'jumlah_batch', (c ->> 'batch')::numeric));
    r := public.rpc_production_complete(jsonb_build_object('id', po ->> 'id', 'qty_hasil', (c ->> 'qty_hasil')::numeric, 'tenaga_kerja', (c ->> 'tk')::numeric, 'overhead', (c ->> 'oh')::numeric));
    perform t.logout(); select * into cs from public.production_costs where production_id = (po ->> 'id')::uuid; perform t.login(t.id('owner'));
    perform t.ok(cs.materials_cost = (c -> 'expect' ->> 'bahan')::numeric, 'produksi "' || (c ->> 'nama') || '": biaya bahan ' || cs.materials_cost || ' harapan ' || (c -> 'expect' ->> 'bahan'));
    perform t.ok(cs.packaging_cost = (c -> 'expect' ->> 'kemasan')::numeric, 'produksi "' || (c ->> 'nama') || '": biaya kemasan ' || cs.packaging_cost);
    perform t.ok(cs.total = (c -> 'expect' ->> 'total')::numeric, 'produksi "' || (c ->> 'nama') || '": total ' || cs.total || ' harapan ' || (c -> 'expect' ->> 'total'));
    perform t.ok(cs.unit_cost = (c -> 'expect' ->> 'unit')::numeric, 'produksi "' || (c ->> 'nama') || '": HPP per unit ' || cs.unit_cost || ' harapan ' || (c -> 'expect' ->> 'unit'));
  end loop;

  -- Seluruh data vektor harus tetap lolos integrity_check
  r := public.rpc_integrity_check(jsonb_build_object('outlet_id', o));
  perform t.logout();
  perform t.ok((r ->> 'ok')::boolean, 'integrity_check bersih setelah semua vektor: ' || (r -> 'pemeriksaan')::text);
end $$;
select 'Tes vektor uang (SQL) selesai' as hasil;
