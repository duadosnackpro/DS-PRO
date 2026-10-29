-- DUADO POS v2.1.0 :: 0001 Fondasi multi-outlet
-- Organisasi, outlet (toko/dapur), profil, keanggotaan (role per outlet), pengaturan, audit.
-- Skema `app` = privat (tidak diekspos ke Data API). Skema `public` = tabel yang dibaca klien lewat RLS.

create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- "Lokasi" = outlet. kind 'store' boleh berjualan; 'kitchen' = dapur/gudang produksi (tidak boleh menerima penjualan).
create table public.outlets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9-]{1,19}$'),
  name text not null check (length(trim(name)) between 2 and 80),
  kind text not null default 'store' check (kind in ('store','kitchen')),
  address text,
  phone text,
  status text not null default 'active' check (status in ('active','inactive','closed')),
  timezone text not null default 'Asia/Jakarta',
  opened_on date,
  receipt_header text,
  receipt_footer text,
  notes text,
  legacy_id text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code)
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  username text not null check (username ~ '^[a-z0-9._-]{3,30}$'),
  full_name text not null,
  status text not null default 'active' check (status in ('active','inactive')),
  default_outlet_id uuid references public.outlets(id),
  legacy_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index profiles_username_key on public.profiles (lower(username));

-- outlet_id NULL = berlaku di semua outlet; hanya untuk owner/admin/auditor.
create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  outlet_id uuid references public.outlets(id),
  role text not null check (role in ('owner','admin','supervisor','kasir','stok','produksi','auditor')),
  status text not null default 'active' check (status in ('active','inactive')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (outlet_id is not null or role in ('owner','admin','auditor'))
);
create unique index memberships_user_outlet_key
  on public.memberships (user_id, coalesce(outlet_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index memberships_outlet_idx on public.memberships (outlet_id) where status = 'active';

-- Pengaturan: outlet_id NULL = global organisasi; baris dengan outlet_id menimpa nilai global untuk outlet itu.
create table public.settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  outlet_id uuid references public.outlets(id),
  key text not null check (key ~ '^[a-z0-9_]{2,60}$'),
  value text not null default '',
  updated_by uuid,
  updated_at timestamptz not null default now()
);
create unique index settings_scope_key
  on public.settings (organization_id, coalesce(outlet_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid,
  outlet_id uuid,
  actor_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_outlet_time on public.audit_logs (outlet_id, created_at desc);
create index audit_logs_entity on public.audit_logs (entity, entity_id);

-- Tabel privat (tidak terjangkau Data API)
create table app.idempotency_keys (
  scope text not null,
  key text not null,
  request_hash text not null,
  user_id uuid,
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (scope, key)
);
create index idempotency_keys_age on app.idempotency_keys (created_at);

create table app.outlet_counters (
  outlet_id uuid not null references public.outlets(id),
  kind text not null,
  day date not null,
  last_seq integer not null default 0,
  primary key (outlet_id, kind, day)
);

-- Jejak audit dan ledger tidak boleh diubah/dihapus lewat jalur normal.
create function app.forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'Data % bersifat tetap (tidak boleh diubah atau dihapus). Lakukan koreksi lewat transaksi baru.', tg_table_name
    using errcode = '23000';
end $$;
create trigger audit_logs_immutable before update or delete on public.audit_logs
  for each row execute function app.forbid_mutation();

-- Outlet yang pernah dipakai tidak boleh dihapus; kodenya tidak dapat dipakai ulang.
create trigger outlets_no_delete before delete on public.outlets
  for each row execute function app.forbid_mutation();

create function app.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger outlets_touch before update on public.outlets for each row execute function app.touch_updated_at();
create trigger profiles_touch before update on public.profiles for each row execute function app.touch_updated_at();
create trigger memberships_touch before update on public.memberships for each row execute function app.touch_updated_at();
