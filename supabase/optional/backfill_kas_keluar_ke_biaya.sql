-- OPSIONAL, jalankan SADAR (SQL Editor, sebagai postgres). Tidak termasuk migrasi karena MENGUBAH laba rugi periode lampau.
-- Latar: sebelum v2.4.0, kas keluar laci tidak menjadi biaya (temuan F-05). Skrip ini membuat baris biaya untuk kas keluar lama
-- yang belum terhubung ke biaya, dengan kategori 'Lain-lain' (kategori aslinya tidak pernah dicatat). Aman dijalankan ulang (request_id 'cm:<id>').
-- 1) PRATINJAU dulu:
--   select outlet_id, count(*), sum(amount) from public.cash_movements
--    where kind = 'out' and expense_id is null and reason not like 'Biaya: %' group by 1;
-- 2) Jalankan blok di bawah bila hasilnya wajar.
with ins as (
  insert into public.expenses (outlet_id, category, amount, expense_date, note, user_id, cash_session_id, request_id)
  select m.outlet_id, 'Lain-lain', m.amount, (m.created_at at time zone o.timezone)::date,
         left('Kas keluar laci (backfill): ' || m.reason, 300), m.user_id, m.cash_session_id, 'cm:' || m.id::text
  from public.cash_movements m join public.outlets o on o.id = m.outlet_id
  where m.kind = 'out' and m.expense_id is null and m.reason not like 'Biaya: %'
  on conflict (request_id) where request_id is not null do nothing
  returning id, request_id
)
update public.cash_movements m set expense_id = ins.id, category = 'Lain-lain'
from ins where ins.request_id = 'cm:' || m.id::text;
