#!/usr/bin/env bash
# Menjalankan migrasi + seed + tes pada database KOSONG (jangan arahkan ke produksi!).
#   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres supabase/tests/run.sh      (Supabase lokal: `supabase start`)
#   PLAIN_PG=1 DATABASE_URL=... supabase/tests/run.sh                                                  (Postgres 15+ biasa; memuat harness auth palsu)
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?isi DATABASE_URL (database uji kosong)}"
psql() { command psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q "$@"; }
[ "${PLAIN_PG:-}" = 1 ] && psql -f tests/harness_plain_pg.sql
for f in migrations/*.sql; do echo "== $f"; psql -f "$f"; done
psql -f seed.sql
psql -f tests/001_multi_outlet.test.sql
psql -f tests/002_p0_kontrol.test.sql
psql -f tests/003_p1_kontrol.test.sql
psql -f tests/004_data_reset.test.sql
