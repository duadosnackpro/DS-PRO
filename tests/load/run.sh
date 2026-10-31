#!/usr/bin/env bash
# Satu skenario beban rpc_sale_create (pgbench). Mencetak SATU baris JSON. Database harus sudah disiapkan prepare.sh.
#   DATABASE_URL=... CLIENTS=4 ACTIVE_OUT=1 PERCASH=3 NVAR=30 DURATION=20 TRIGGERS=on tests/load/run.sh
# TRIGGERS=off menonaktifkan trigger sinyal sinkronisasi (sync_stock_signal) selama putaran, untuk mengukur biayanya.
# Catatan metode: pgbench memanggil fungsi langsung di Postgres (tanpa PostgREST/jaringan/TLS). Itu waktu DATABASE, bukan ujung-ke-ujung.
set -euo pipefail
cd "$(dirname "$0")"
: "${DATABASE_URL:?isi DATABASE_URL}"
C="${CLIENTS:-4}"; ACTIVE="${ACTIVE_OUT:-1}"; PERCASH="${PERCASH:-3}"; NVAR="${NVAR:-30}"; T="${DURATION:-20}"; W="${WARMUP:-3}"; TRG="${TRIGGERS:-on}"
DBNAME="$(basename "${DATABASE_URL%%\?*}")"; NCASH=$((ACTIVE * PERCASH)); WORK="$(mktemp -d)"; : >"$WORK/waits"; RUN=$(( $(date +%s) % 1000000000 ))
q() { command psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atq "$@"; }
cleanup() { [ "$TRG" = off ] && q -c "alter table public.inventory_balances enable trigger sync_stock_signal" || true; rm -rf "$WORK"; }
trap cleanup EXIT
[ "$TRG" = off ] && q -c "alter table public.inventory_balances disable trigger sync_stock_signal"
q -c "truncate public.sync_events" 2>/dev/null || true
[ -n "${PREFILL_SYNC:-}" ] && q -c "insert into public.sync_events (outlet_id, kind, created_at) select md5('outlet-' || (g % 10 + 1))::uuid, case when g % 2 = 0 then 'stock' else 'cat' end, now() - (g || ' seconds')::interval * 0.15 from generate_series(1, $PREFILL_SYNC) g"
ARGS=(-n -M simple -h "${PGHOST:-127.0.0.1}" -U "${PGUSER:-postgres}" -f sale.pgbench -D ncash=$NCASH -D percash=$PERCASH -D nvar=$NVAR -D seq=0)
export PGPASSWORD="${PGPASSWORD:-postgres}"
pgbench "${ARGS[@]}" -D run=$((RUN)) -c "$C" -j 1 -T "$W" "$DBNAME" >/dev/null 2>"$WORK/warm.err" || { cat "$WORK/warm.err" >&2; exit 1; }
# pencuplik kunci: sampling pg_stat_activity tiap 0,5 dtk selama putaran utama
( while [ ! -e "$WORK/stop" ]; do q -c "select count(*) filter (where wait_event_type = 'Lock'), count(*) filter (where state = 'active') from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'" >>"$WORK/waits" 2>/dev/null; sleep 0.5; done ) &
SAMP=$!
pgbench "${ARGS[@]}" -D run=$((RUN + 1)) -c "$C" -j 1 -T "$T" -r --log --log-prefix="$WORK/tx" "$DBNAME" >"$WORK/out" 2>"$WORK/err" || { cat "$WORK/err" "$WORK/out" >&2; touch "$WORK/stop"; exit 1; }
touch "$WORK/stop"; wait $SAMP 2>/dev/null || true
if grep -qi "aborted\|error" "$WORK/err"; then echo "GALAT dari pgbench:" >&2; head -5 "$WORK/err" >&2; exit 1; fi
PCT="$(node percentiles.js "$WORK/tx" "$T")"
STMT="$(awk '/statement latencies/{f=1;next} f && /rpc_sale_create/{print $1; exit}' "$WORK/out")"
LW="$(awk -F'|' '{n++; if ($1>0) l++; if ($1>m) m=$1; a+=$2} END {printf "{\"samples\":%d,\"lock_wait_samples\":%d,\"max_waiting\":%d,\"avg_active\":%.2f}", n, l+0, m+0, n? a/n:0}' "$WORK/waits")"
SYNC="$(q -c "select count(*) from public.sync_events")"
SALES="$(q -c "select count(*) from public.sales where request_id like 'ld-$((RUN + 1))%'")"
TXN="$(echo "$PCT" | node -e 'process.stdin.on("data", d => console.log(JSON.parse(d).n))')"
[ "$SALES" = "$TXN" ] || { echo "TIDAK KONSISTEN: pgbench mencatat $TXN transaksi tetapi hanya $SALES penjualan tersimpan" >&2; exit 1; }
echo "{\"clients\":$C,\"outlets\":$ACTIVE,\"triggers\":\"$TRG\",\"nvar\":$NVAR,\"prefill_sync\":${PREFILL_SYNC:-0},\"tx\":$PCT,\"rpc_stmt_avg_ms\":${STMT:-null},\"waits\":$LW,\"sync_events_after\":$SYNC,\"sales_saved\":$SALES}"
