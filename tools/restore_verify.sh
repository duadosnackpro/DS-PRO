#!/usr/bin/env bash
# Verifikasi pemulihan: bandingkan database hasil pemulihan dengan manifest cadangan SAMPAI SEN, lalu jalankan integrity_check di target.
# Bagian 3.7 B2 di Framework-Efisiensi-End-to-End.md. Pemulihan dianggap sah HANYA bila skrip ini keluar dengan kode 0.
#
#   TARGET_DATABASE_URL=... tools/restore_verify.sh manifest.json [--skema public,app] [--ketat]
# manifest.json = hasil dekripsi duado-<STAMP>.manifest.json.gpg. --skema = skema yang ikut dipulihkan (bawaan public,app).
# Kode keluar: 0 sah, 1 tidak sah, 2 salah pakai atau target tidak terbaca.
set -euo pipefail
: "${TARGET_DATABASE_URL:?isi TARGET_DATABASE_URL}"
MAN="${1:-}"; [ -f "$MAN" ] || { echo "Pakai: TARGET_DATABASE_URL=... $0 manifest.json [--skema public,app] [--ketat]" >&2; exit 2; }; shift
HERE="$(cd "$(dirname "$0")" && pwd)"; PG_BIN="${PG_BIN:-$(dirname "$(command -v psql)")}"; PSQL="$PG_BIN/psql"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
"$PSQL" "$TARGET_DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
  -c "begin isolation level repeatable read read only" \
  -c "select app.backup_manifest_core(true)" -c "select app.backup_integrity_all()" -c "commit" > "$WORK/out.txt" \
  || { echo "Target tidak dapat dibaca. Apakah skema app hasil pemulihan ada (fungsi app.backup_manifest_core dari migrasi 0033)? Dump lama sebelum 0033 tidak dapat diverifikasi dengan skrip ini." >&2; exit 2; }
[ "$(wc -l < "$WORK/out.txt")" -ge 2 ] || { echo "Keluaran target tidak lengkap" >&2; exit 2; }
sed -n 1p "$WORK/out.txt" > "$WORK/inti.json"; sed -n 2p "$WORK/out.txt" > "$WORK/integ.json"
node "$HERE/backup_finalize.js" --inti "$WORK/inti.json" --integritas "$WORK/integ.json" --keluar "$WORK/target.json" >/dev/null
node "$HERE/restore_verify.js" --sumber "$MAN" --target "$WORK/target.json" "$@"
