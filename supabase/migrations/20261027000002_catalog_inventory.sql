-- 0002 Katalog (global) dan persediaan (per outlet/lokasi)

create table public.channels (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  fee_percent numeric(6,3) not null default 0 check (fee_percent >= 0 and fee_percent <= 100),
  fee_fixed numeric(14,2) not null default 0 check (fee_fixed >= 0),
  fee_basis text not null default 'total' check (fee_basis in ('total','subtotal','omzet')),
  active boolean not null default true,
  legacy_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text,
  active boolean not null default true,
  photo_url text,
  legacy_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  sku text not null check (length(trim(sku)) > 0),
  size text,
  spice_level text,
  active boolean not null default true,
  legacy_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index product_variants_sku_key on public.product_variants (lower(sku));
create index product_variants_product on public.product_variants (product_id);

-- Harga default global per channel; override per outlet bersifat opsional (P2).
create table public.channel_prices (
  variant_id uuid not null references public.product_variants(id),
  channel_id uuid not null references public.channels(id),
  price numeric(14,2) not null check (price >= 0),
  updated_at timestamptz not null default now(),
  primary key (variant_id, channel_id)
);

create table public.outlet_prices (
  outlet_id uuid not null references public.outlets(id),
  variant_id uuid not null references public.product_variants(id),
  channel_id uuid not null references public.channels(id),
  price numeric(14,2) not null check (price >= 0),
  effective_from date not null default current_date,
  created_by uuid,
  primary key (outlet_id, variant_id, channel_id, effective_from)
);

create table public.materials (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null default 'bahan' check (type in ('bahan','kemasan')),
  unit text not null,
  small_unit text,
  small_factor numeric(14,4),
  min_stock numeric(16,4) not null default 0,
  active boolean not null default true,
  legacy_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text,
  notes text,
  active boolean not null default true,
  legacy_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants(id),
  name text not null,
  standard_yield numeric(16,4) not null check (standard_yield > 0),
  kind text not null default 'batch' check (kind in ('batch','repack')),
  labor_cost numeric(14,2) not null default 0 check (labor_cost >= 0),
  active boolean not null default true,
  legacy_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.recipe_items (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  material_id uuid not null references public.materials(id),
  qty numeric(16,6) not null check (qty > 0)
);
create index recipe_items_recipe on public.recipe_items (recipe_id);

-- Saldo cepat. Hanya boleh diubah oleh app.stock_apply() yang SELALU menulis ledger yang sesuai.
create table public.inventory_balances (
  outlet_id uuid not null references public.outlets(id),
  variant_id uuid not null references public.product_variants(id),
  quantity numeric(16,4) not null default 0,
  avg_cost numeric(16,4) not null default 0 check (avg_cost >= 0),
  min_qty numeric(16,4) not null default 0 check (min_qty >= 0),
  updated_at timestamptz not null default now(),
  primary key (outlet_id, variant_id)
);

create table public.inventory_material_balances (
  outlet_id uuid not null references public.outlets(id),
  material_id uuid not null references public.materials(id),
  quantity numeric(16,4) not null default 0,
  avg_cost numeric(16,4) not null default 0 check (avg_cost >= 0),
  min_qty numeric(16,4) not null default 0 check (min_qty >= 0),
  updated_at timestamptz not null default now(),
  primary key (outlet_id, material_id)
);

-- Ledger mutasi: tidak pernah diubah/dihapus.
create table public.stock_movements (
  id bigint generated always as identity primary key,
  outlet_id uuid not null references public.outlets(id),
  item_type text not null check (item_type in ('variant','material')),
  item_id uuid not null,
  movement_type text not null check (movement_type in
    ('opening','sale','return_in','production_in','production_use','purchase','adjustment',
     'transfer_out','transfer_in','transfer_cancel','void_reverse')),
  quantity_delta numeric(16,4) not null check (quantity_delta <> 0),
  unit_cost numeric(16,4),
  value numeric(18,4),
  balance_after numeric(16,4) not null,
  reference_type text,
  reference_id uuid,
  user_id uuid,
  note text,
  legacy_id text,
  created_at timestamptz not null default now()
);
create index stock_movements_item on public.stock_movements (outlet_id, item_type, item_id, created_at desc);
create index stock_movements_ref on public.stock_movements (reference_type, reference_id);
create trigger stock_movements_immutable before update or delete on public.stock_movements
  for each row execute function app.forbid_mutation();

create trigger channels_touch before update on public.channels for each row execute function app.touch_updated_at();
create trigger products_touch before update on public.products for each row execute function app.touch_updated_at();
create trigger variants_touch before update on public.product_variants for each row execute function app.touch_updated_at();
create trigger materials_touch before update on public.materials for each row execute function app.touch_updated_at();
create trigger suppliers_touch before update on public.suppliers for each row execute function app.touch_updated_at();
create trigger recipes_touch before update on public.recipes for each row execute function app.touch_updated_at();
