-- 0004 Pembelian, produksi, transfer stok

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets(id),   -- lokasi penerima
  supplier_id uuid references public.suppliers(id),
  request_id text not null,
  doc_ref text,
  purchased_at timestamptz not null default now(),
  subtotal numeric(16,2) not null,
  shipping numeric(16,2) not null default 0 check (shipping >= 0),
  total numeric(16,2) not null,
  status text not null default 'posted' check (status in ('posted','cancelled')),
  note text,
  user_id uuid not null,
  legacy_id text,
  created_at timestamptz not null default now()
);
create unique index purchases_request_key on public.purchases (request_id);
create index purchases_outlet_time on public.purchases (outlet_id, purchased_at desc);

create table public.purchase_items (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases(id),
  material_id uuid not null references public.materials(id),
  qty numeric(16,4) not null check (qty > 0),
  unit_price numeric(16,4) not null check (unit_price >= 0),
  effective_cost numeric(16,4) not null check (effective_cost >= 0)
);
create index purchase_items_purchase on public.purchase_items (purchase_id);

create table public.production_orders (
  id uuid primary key default gen_random_uuid(),
  kitchen_outlet_id uuid not null references public.outlets(id),  -- lokasi pemakaian bahan
  output_outlet_id uuid not null references public.outlets(id),   -- lokasi hasil masuk
  recipe_id uuid not null references public.recipes(id),
  variant_id uuid not null references public.product_variants(id),
  kind text not null default 'batch' check (kind in ('batch','pesanan','repack')),
  batches numeric(10,3) not null check (batches > 0),
  standard_qty numeric(16,4) not null,
  actual_qty numeric(16,4),
  status text not null default 'planned' check (status in ('planned','done','cancelled')),
  note text,
  user_id uuid not null,
  legacy_id text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index production_orders_kitchen on public.production_orders (kitchen_outlet_id, created_at desc);

-- Biaya batch disimpan sebagai snapshot: perubahan resep/harga tidak mengubah histori.
create table public.production_costs (
  production_id uuid primary key references public.production_orders(id),
  materials_cost numeric(16,2) not null,
  packaging_cost numeric(16,2) not null,
  labor_cost numeric(16,2) not null,
  overhead_cost numeric(16,2) not null,
  total numeric(16,2) not null,
  unit_cost numeric(16,4) not null
);

create table public.stock_transfers (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  from_outlet_id uuid not null references public.outlets(id),
  to_outlet_id uuid not null references public.outlets(id),
  status text not null default 'draft' check (status in
    ('draft','submitted','approved','sent','received','rejected','cancelled')),
  requested_by uuid not null,
  approved_by uuid,
  sent_by uuid,
  received_by uuid,
  sent_at timestamptz,
  received_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (from_outlet_id <> to_outlet_id)
);
create index stock_transfers_from on public.stock_transfers (from_outlet_id, created_at desc);
create index stock_transfers_to on public.stock_transfers (to_outlet_id, created_at desc);

create table public.stock_transfer_items (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.stock_transfers(id),
  item_type text not null check (item_type in ('variant','material')),
  item_id uuid not null,
  qty_requested numeric(16,4) not null check (qty_requested > 0),
  qty_sent numeric(16,4),
  qty_received numeric(16,4),
  unit_cost numeric(16,4),
  variance numeric(16,4) generated always as (case when qty_received is null then null else coalesce(qty_sent,0) - qty_received end) stored,
  unique (transfer_id, item_type, item_id)
);
create trigger transfers_touch before update on public.stock_transfers for each row execute function app.touch_updated_at();
