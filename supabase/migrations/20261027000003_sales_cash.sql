-- 0003 Penjualan, pembayaran, sesi kasir, kas, pengeluaran

create table public.cash_sessions (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets(id),
  cashier_id uuid not null references public.profiles(id),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  opening_cash numeric(14,2) not null default 0 check (opening_cash >= 0),
  auto_opened boolean not null default false,
  txn_count integer,
  totals jsonb,
  cash_in numeric(14,2),
  cash_out numeric(14,2),
  expected_cash numeric(14,2),
  actual_cash numeric(14,2),
  difference numeric(14,2),
  status text not null default 'open' check (status in ('open','closed')),
  note text,
  approved_by uuid,
  approved_at timestamptz,
  legacy_id text,
  check (status = 'open' or closed_at is not null)
);
-- Satu kasir hanya boleh punya satu sesi aktif (tidak mungkin aktif di dua outlet sekaligus).
create unique index cash_sessions_one_open_per_cashier on public.cash_sessions (cashier_id) where status = 'open';
create index cash_sessions_outlet_time on public.cash_sessions (outlet_id, opened_at desc);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets(id),
  receipt_no text not null,
  request_id text not null,
  kind text not null default 'sale' check (kind in ('sale','return')),
  ref_sale_id uuid references public.sales(id),
  channel_id uuid not null references public.channels(id),
  cashier_id uuid not null references public.profiles(id),
  cash_session_id uuid references public.cash_sessions(id),
  status text not null default 'completed' check (status in ('completed','cancelled')),
  subtotal numeric(16,2) not null,
  discount numeric(16,2) not null default 0,
  fee_channel numeric(16,2) not null default 0,
  tax_rate numeric(6,3) not null default 0,
  tax_amount numeric(16,2) not null default 0,
  total numeric(16,2) not null,               -- negatif untuk retur (sama seperti v2.0.0)
  payment_method text not null check (payment_method in ('tunai','transfer','qris','lain')),
  client_total numeric(16,2),
  client_ts timestamptz,
  sold_at timestamptz not null default now(),
  note text,
  reason text,
  approved_by uuid,
  legacy_id text,
  created_at timestamptz not null default now(),
  check ((kind = 'return') = (ref_sale_id is not null)),
  check ((kind = 'sale' and total >= 0) or (kind = 'return' and total <= 0))
);
create unique index sales_request_id_key on public.sales (request_id);
create unique index sales_receipt_key on public.sales (outlet_id, receipt_no);
create index sales_outlet_time on public.sales (outlet_id, sold_at desc);
create index sales_cashier_time on public.sales (cashier_id, sold_at desc);
create index sales_ref on public.sales (ref_sale_id) where ref_sale_id is not null;
create index sales_session on public.sales (cash_session_id) where cash_session_id is not null;

create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id),
  outlet_id uuid not null references public.outlets(id),
  variant_id uuid not null references public.product_variants(id),
  sku_snapshot text not null,
  name_snapshot text not null,
  qty numeric(16,4) not null check (qty <> 0),     -- negatif pada baris retur
  unit_price numeric(14,2) not null check (unit_price >= 0),
  hpp_snapshot numeric(16,4),                        -- NULL = HPP belum tersedia (bukan nol)
  line_total numeric(16,2) generated always as (round(qty * unit_price, 2)) stored
);
create index sale_items_sale on public.sale_items (sale_id);
create index sale_items_outlet_variant on public.sale_items (outlet_id, variant_id);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id),
  outlet_id uuid not null references public.outlets(id),
  cash_session_id uuid references public.cash_sessions(id),
  method text not null check (method in ('tunai','transfer','qris','lain')),
  amount numeric(16,2) not null,                    -- negatif = pengembalian dana
  received numeric(16,2),
  change_given numeric(16,2),
  status text not null default 'confirmed' check (status in ('confirmed','pending','failed')),
  reference text,
  created_at timestamptz not null default now()
);
create index payments_sale on public.payments (sale_id);
create index payments_session on public.payments (cash_session_id) where cash_session_id is not null;

create table public.cash_movements (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets(id),
  cash_session_id uuid not null references public.cash_sessions(id),
  kind text not null check (kind in ('in','out')),
  amount numeric(14,2) not null check (amount > 0),
  reason text not null check (length(trim(reason)) >= 3),
  user_id uuid not null,
  created_at timestamptz not null default now()
);
create index cash_movements_session on public.cash_movements (cash_session_id);

-- outlet_id NULL = biaya pusat (tidak dialokasikan otomatis ke outlet).
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid references public.outlets(id),
  category text not null,
  amount numeric(14,2) not null check (amount > 0),
  expense_date date not null default current_date,
  note text,
  user_id uuid not null,
  cash_session_id uuid references public.cash_sessions(id),
  request_id text,
  legacy_id text,
  created_at timestamptz not null default now()
);
create unique index expenses_request_key on public.expenses (request_id) where request_id is not null;
create index expenses_outlet_date on public.expenses (outlet_id, expense_date desc);

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets(id),
  source text not null,
  file_name text,
  status text not null default 'posted' check (status in ('preview','posted','failed')),
  total_rows integer not null default 0,
  ok_rows integer not null default 0,
  rejected_rows integer not null default 0,
  errors jsonb,
  created_by uuid not null,
  created_at timestamptz not null default now()
);

-- Pesanan eksternal yang sudah diimpor: cegah impor ulang menjadi transaksi baru.
create table public.external_orders (
  source text not null,
  external_id text not null,
  sale_id uuid not null references public.sales(id),
  outlet_id uuid not null references public.outlets(id),
  batch_id uuid references public.import_batches(id),
  primary key (source, external_id)
);
