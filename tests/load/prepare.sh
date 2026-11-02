#!/usr/bin/env bash
# Menyiapkan database beban dari NOL: harness auth palsu (Postgres biasa), semua migrasi, seed, lalu data beban.
#   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/load tests/load/prepare.sh
# JANGAN diarahkan ke database berisi data nyata. NOUT/PERCASH/NVAR mengatur ukuran data (bawaan 10 outlet x 3 kasir, 30 varian).
set -euo pipefail
cd "$(dirname "$0")/../../supabase"
: "${DATABASE_URL:?isi DATABASE_URL (database uji KOSONG)}"
psql() { command psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q "$@"; }
psql -f tests/harness_plain_pg.sql
for f in migrations/*.sql; do psql -f "$f" 2>&1 | grep -v NOTICE || true; done
psql -f seed.sql
psql -v nout="${NOUT:-10}" -v percash="${PERCASH:-3}" -v nvar="${NVAR:-30}" -f ../tests/load/setup.sql
echo "siap: ${NOUT:-10} outlet x ${PERCASH:-3} kasir, ${NVAR:-30} varian"
