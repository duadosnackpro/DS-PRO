#!/usr/bin/env bash
# Pulihkan cadangan terenkripsi ke database TARGET (staging atau lokal), lalu verifikasi sampai sen. Bagian 3.7 B3 di Framework-Efisiensi-End-to-End.md.
#
#   TARGET_DATABASE_URL=postgresql://... BACKUP_PASSPHRASE=... \
#   tools/restore.sh --konfirmasi <nama-database-target> [opsi] duado-XXXX.dump.gpg
#
# Opsi:
#   --konfirmasi NAMA  WAJIB. Harus sama dengan nama database target (select current_database()). Pengaman agar tidak memulihkan ke database yang salah.
#   --semua-skema      pulihkan juga auth dan supabase_migrations (untuk Postgres kosong/lokal). Bawaan: hanya public dan app,
#                      karena pada proyek Supabase skema auth dikelola Supabase dan memulihkannya ke proyek berisi dapat bentrok (belum teruji).
#   --timpa            izinkan target yang sudah berisi data (public.sales tidak kosong). Tanpa ini skrip berhenti.
#   --foto             unggah foto produk dari duado-XXXX.photos.tar.gpg (butuh TARGET_SUPABASE_URL dan TARGET_SERVICE_KEY)
#   --stub-auth        (hanya tanpa --semua-skema) buat baris auth.users PENGGANTI (id + email palsu, tanpa kata sandi) untuk tiap id di public.profiles pada dump, bila belum ada di target.
#                      Perlu karena public.profiles.id berelasi ke auth.users; tanpa akun yang cocok FK itu gagal dibuat dan pemulihan dinyatakan TIDAK SAH. Akun pengganti tidak bisa dipakai login;
#                      hanya untuk target uji/staging, JANGAN dipakai pada proyek yang berisi akun asli yang dipakai orang.
#   --buat-peran       buat (NOLOGIN) peran yang disebut GRANT/kebijakan di dump tetapi belum ada di target, mis. service_role. Hanya untuk Postgres uji/CI (butuh hak CREATEROLE); jangan dipakai di Supabase.
#   --ketat            pemulihan sah hanya bila integrity_check target NOL temuan (bawaan: tidak menambah temuan milik sumber)
# Env opsional: PG_BIN, BACKUP_DATABASE_URL (bila diisi dan sama dengan target, skrip menolak: itu produksi), PHOTO_BUCKET
# Berkas pendamping dicari di folder yang sama: duado-XXXX.manifest.json.gpg (wajib) dan duado-XXXX.photos.tar.gpg (bila --foto).
# Kode keluar: 0 pemulihan SAH, 1 tidak sah atau gagal, 2 salah pakai/pengaman menolak.
set -euo pipefail
: "${TARGET_DATABASE_URL:?isi TARGET_DATABASE_URL}"; : "${BACKUP_PASSPHRASE:?isi BACKUP_PASSPHRASE}"
KONF=""; SEMUA=0; STUB=0; PERAN=0; TIMPA=0; FOTO=0; KETAT=""; DUMP=""
while [ $# -gt 0 ]; do case "$1" in
  --konfirmasi) KONF="${2:-}"; shift 2;; --semua-skema) SEMUA=1; shift;; --stub-auth) STUB=1; shift;; --buat-peran) PERAN=1; shift;; --timpa) TIMPA=1; shift;; --foto) FOTO=1; shift;; --ketat) KETAT="--ketat"; shift;;
  -*) echo "Opsi tidak dikenal: $1" >&2; exit 2;; *) DUMP="$1"; shift;; esac; done
[ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "Berkas dump tidak ditemukan. Pakai: $0 --konfirmasi NAMA_DB [opsi] duado-XXXX.dump.gpg" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
PG_BIN="${PG_BIN:-$(dirname "$(command -v pg_restore)")}"; PSQL="$PG_BIN/psql"; PGRESTORE="$PG_BIN/pg_restore"; BUCKET="${PHOTO_BUCKET:-product-photos}"
BASE="${DUMP%.dump.gpg}"; MANGPG="$BASE.manifest.json.gpg"; FOTOGPG="$BASE.photos.tar.gpg"
log() { printf '[restore] %s\n' "$*" >&2; }
T0=$(date +%s)

# ---- pengaman ----
if [ -n "${BACKUP_DATABASE_URL:-}" ] && [ "$BACKUP_DATABASE_URL" = "$TARGET_DATABASE_URL" ]; then echo "DITOLAK: TARGET_DATABASE_URL sama dengan BACKUP_DATABASE_URL (produksi)." >&2; exit 2; fi
[ -n "$KONF" ] || { echo "DITOLAK: --konfirmasi NAMA_DB wajib (nama database target)." >&2; exit 2; }
ACT="$("$PSQL" "$TARGET_DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -c "select current_database()")" || { echo "Target tidak dapat dihubungi." >&2; exit 2; }
[ "$ACT" = "$KONF" ] || { echo "DITOLAK: --konfirmasi '$KONF' tidak sama dengan database target '$ACT'." >&2; exit 2; }
[ -f "$MANGPG" ] || { echo "DITOLAK: manifest $MANGPG tidak ada di samping dump. Tanpa manifest pemulihan tidak dapat diverifikasi." >&2; exit 2; }
if [ "$FOTO" = 1 ]; then
  [ -f "$FOTOGPG" ] || { echo "DITOLAK: --foto diminta tetapi $FOTOGPG tidak ada." >&2; exit 2; }
  : "${TARGET_SUPABASE_URL:?isi TARGET_SUPABASE_URL untuk unggah foto}"; : "${TARGET_SERVICE_KEY:?isi TARGET_SERVICE_KEY (service role proyek TARGET) untuk unggah foto}"
fi
HAS="$("$PSQL" "$TARGET_DATABASE_URL" -X -q -A -t -c "select coalesce(to_regclass('public.sales')::text, '')")"
if [ -n "$HAS" ]; then
  N="$("$PSQL" "$TARGET_DATABASE_URL" -X -q -A -t -c "select count(*) from public.sales")"
  if [ "$N" -gt 0 ] && [ "$TIMPA" != 1 ]; then echo "DITOLAK: target sudah berisi $N penjualan. Tambahkan --timpa bila memang sengaja menimpa." >&2; exit 2; fi
fi

umask 077; WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
dec() { printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --pinentry-mode loopback --passphrase-fd 0 -o "$2" -d "$1" 2>/dev/null || { echo "Dekripsi gagal ($1). Passphrase salah atau berkas rusak." >&2; exit 1; }; }
dec "$DUMP" "$WORK/d.dump"; dec "$MANGPG" "$WORK/manifest.json"
"$PGRESTORE" --list "$WORK/d.dump" > "$WORK/toc.txt" || { echo "Dump tidak terbaca oleh pg_restore." >&2; exit 1; }
log "Dump terbaca: $(wc -l < "$WORK/toc.txt") entri. Memulihkan ke '$ACT'..."

# ---- pulihkan (dengan hak akses: RLS/GRANT ikut; pemilik tidak) ----
[ "$STUB" = 1 ] && [ "$SEMUA" = 1 ] && { echo "DITOLAK: --stub-auth tidak dipakai bersama --semua-skema (auth ikut dipulihkan dari dump)." >&2; exit 2; }
SCH=(--schema=public --schema=app); VSKEMA="public,app"
if [ "$SEMUA" = 1 ]; then SCH=(--schema=public --schema=app --schema=auth --schema=supabase_migrations); VSKEMA="public,app,auth,supabase_migrations"; fi
# pg_restore --schema hanya memulihkan ISI skema, bukan perintah CREATE SCHEMA-nya; siapkan skema yang belum ada (tidak mengubah yang sudah ada).
for sc in ${VSKEMA//,/ }; do "$PSQL" "$TARGET_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "create schema if not exists $sc" >/dev/null; done
# ---- peran yang dibutuhkan dump (opsional; Postgres uji) ----
if [ "$PERAN" = 1 ]; then
  "$PGRESTORE" --schema-only --schema=public --schema=app -f "$WORK/skema.sql" "$WORK/d.dump" 2>/dev/null || true
  { perl -ne 'if (/^(?:GRANT|REVOKE) .*? (?:TO|FROM) (.+?)(?: WITH GRANT OPTION)?(?: GRANTED BY .*)?;\s*$/) { print "$1\n" }
              if (/^CREATE POLICY \S+ ON \S+(?: AS \w+)?(?: FOR \w+)? TO ([\w", ]+?)(?: USING| WITH CHECK|;|\s*$)/) { print "$1\n" }
              if (/^ALTER DEFAULT PRIVILEGES .*? (?:TO|FROM) (.+?);\s*$/) { print "$1\n" }' "$WORK/skema.sql" | tr ',' '\n' | sed 's/^ *//; s/ *$//; s/^"//; s/"$//' | grep -v '^$' | grep -vi '^public$' | sort -u > "$WORK/peran.txt"; } || true
  NP=0
  while IFS= read -r rl; do
    EX="$("$PSQL" "$TARGET_DATABASE_URL" -X -q -A -t -c "select 1 from pg_roles where rolname = '${rl//\'/}'")"
    if [ -z "$EX" ]; then "$PSQL" "$TARGET_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "create role \"${rl//\"/}\" nologin" >/dev/null && NP=$((NP + 1)) || { echo "Gagal membuat peran $rl (butuh CREATEROLE)." >&2; exit 1; }; fi
  done < "$WORK/peran.txt"
  log "Peran: $NP peran baru dibuat dari $(wc -l < "$WORK/peran.txt") yang disebut dump."
fi
# ---- akun pengganti (opsional) ----
if [ "$STUB" = 1 ]; then
  "$PGRESTORE" --data-only --schema=public --table=profiles -f "$WORK/profiles.sql" "$WORK/d.dump" 2>/dev/null || true
  awk '/^COPY public\.profiles \(/ { h=$0; sub(/^[^(]*\(/, "", h); sub(/\).*/, "", h); n=split(h, c, ", "); for (i=1;i<=n;i++) if (c[i]=="id") col=i; f=1; next }
       /^\\\.$/ { f=0 } f && col { split($0, a, "\t"); print a[col] }' "$WORK/profiles.sql" > "$WORK/profile_ids.txt"
  NID="$(wc -l < "$WORK/profile_ids.txt")"
  if [ "$NID" -gt 0 ]; then
    "$PSQL" "$TARGET_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "create temp table _ids(id uuid)" -c "\\copy _ids from '$WORK/profile_ids.txt'" \
      -c "insert into auth.users (id, email) select id, 'pemulihan-' || id || '@invalid.invalid' from _ids on conflict (id) do nothing" \
      || { echo "Gagal membuat akun pengganti di auth.users target (kolom wajib berbeda?)." >&2; exit 1; }
    log "Akun pengganti: $NID id profil dipastikan ada di auth.users target (yang sudah ada tidak diubah)."
  else log "--stub-auth: tidak ada baris profiles di dump."; fi
fi
set +e
"$PGRESTORE" --no-owner --clean --if-exists "${SCH[@]}" --dbname "$TARGET_DATABASE_URL" "$WORK/d.dump" 2> "$WORK/restore.err"; RC=$?
set -e
NERR="$(grep -c 'error:' "$WORK/restore.err" || true)"
log "pg_restore selesai (kode $RC, $NERR galat). Galat yang tercatat TIDAK otomatis menggagalkan; putusan akhir dari verifikasi di bawah."
[ "$NERR" -eq 0 ] || { log "Cuplikan galat pg_restore:"; grep 'error:' "$WORK/restore.err" | head -8 >&2; }

# ---- foto ----
FOTO_OK=1
if [ "$FOTO" = 1 ]; then
  dec "$FOTOGPG" "$WORK/foto.tar"; mkdir -p "$WORK/foto"; tar -C "$WORK/foto" -xf "$WORK/foto.tar"
  node "$HERE/restore_foto.js" --manifest "$WORK/manifest.json" --folder "$WORK/foto" --url "$TARGET_SUPABASE_URL" --kunci "$TARGET_SERVICE_KEY" --bucket "$BUCKET" || FOTO_OK=0
fi

# ---- verifikasi: SATU-SATUNYA penentu sah/tidak ----
set +e
TARGET_DATABASE_URL="$TARGET_DATABASE_URL" PG_BIN="$PG_BIN" bash "$HERE/restore_verify.sh" "$WORK/manifest.json" --skema "$VSKEMA" $KETAT | tee "$WORK/verify.txt"
VRC=${PIPESTATUS[0]}
set -e
DUR=$(( $(date +%s) - T0 ))
VERD="$(grep '^PUTUSAN:' "$WORK/verify.txt" | sed 's/^PUTUSAN: //')"
[ "$FOTO_OK" = 1 ] || { VRC=1; VERD="TIDAK SAH (foto produk tidak lengkap)"; }
echo
echo "Baris untuk tabel catatan di docs/BACKUP-RESTORE.md:"
echo "| $(date -u +%F) | dump $(basename "$DUMP") | $ACT | ${VERD:-tidak ada putusan}; selisih uang terbesar: $(grep -o 'Rp [^ ]*' "$WORK/verify.txt" | head -1 || echo '?') | ${DUR} dtk | $(id -un) |"
exit $VRC
