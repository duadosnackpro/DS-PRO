#!/usr/bin/env bash
# Cadangan logis terenkripsi: dump + manifest kendali + foto produk, SEMUA dari SATU snapshot database.
# Dipakai oleh .github/workflows/backup.yml dan dapat dijalankan manual. Bagian 3.7 (B1, B4, B7) di Framework-Efisiensi-End-to-End.md.
#
# Env wajib : BACKUP_DATABASE_URL (koneksi LANGSUNG, bukan pooler mode transaksi), BACKUP_PASSPHRASE
# Env opsional: PG_BIN (folder pg_dump/psql, bawaan: dari PATH), OUT_DIR (bawaan .), STAMP (bawaan waktu UTC sekarang),
#               SUPABASE_URL (mis. https://xxxx.supabase.co; wajib bila ada foto di bucket), PHOTO_BUCKET (bawaan product-photos)
# Hasil     : duado-<STAMP>.dump.gpg, duado-<STAMP>.manifest.json.gpg, duado-<STAMP>.photos.tar.gpg (hanya bila ada foto)
#
# Mengapa satu snapshot: manifest dan dump yang diambil pada waktu berbeda akan berbeda bila ada penjualan di antaranya, dan pemulihan yang benar
# akan tampak salah. Sesi penahan membuka transaksi REPEATABLE READ, mengekspor snapshot, lalu pg_dump --snapshot, hitung manifest, daftar foto,
# dan integrity_check semuanya membaca keadaan database yang sama.
set -euo pipefail
: "${BACKUP_DATABASE_URL:?isi BACKUP_DATABASE_URL}"; : "${BACKUP_PASSPHRASE:?isi BACKUP_PASSPHRASE}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PG_BIN="${PG_BIN:-$(dirname "$(command -v pg_dump)")}"; PSQL="$PG_BIN/psql"; PGDUMP="$PG_BIN/pg_dump"; PGRESTORE="$PG_BIN/pg_restore"
OUT_DIR="${OUT_DIR:-.}"; STAMP="${STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"; BUCKET="${PHOTO_BUCKET:-product-photos}"
F="duado-$STAMP"; mkdir -p "$OUT_DIR"; umask 077
WORK="$(mktemp -d)"; SNAP_OPEN=0; SPID=""
SENT="__SELESAI_$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')__"
log() { printf '[backup] %s\n' "$*" >&2; }

record_fail() { # catat kegagalan sebisanya; kegagalan mencatat tidak boleh menutupi galat asli
  local note="$1"
  "$PSQL" "$BACKUP_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "select app.backup_record(jsonb_build_object('ok', false, 'file_name', '$F', 'note', \$n\$${note//\$n\$/}\$n\$))" >/dev/null 2>&1 || true
}
cleanup() { local rc=$?
  if [ "$SNAP_OPEN" = 1 ] && [ -n "$SPID" ]; then kill "$SPID" 2>/dev/null || true; fi
  rm -rf "$WORK"
  if [ $rc -ne 0 ]; then rm -f "$OUT_DIR/$F".*.gpg 2>/dev/null || true; log "GAGAL (kode $rc). Berkas setengah jadi dihapus."; record_fail "backup.sh gagal (kode $rc) pada $(date -u +%FT%TZ)"; fi
}
trap cleanup EXIT

# ---- sesi penahan snapshot ----
coproc SNAP { "$PSQL" "$BACKUP_DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -P pager=off; }
SPID="$SNAP_PID"; SNAP_OPEN=1   # salin segera: bash MENGHAPUS SNAP_PID begitu proses selesai, dan wait di bawah akan balapan
ask() { # ask <sql> <berkas-keluaran> : kirim SQL, baca keluaran sampai penanda
  printf '%s\nselect '"'"'%s'"'"';\n' "$1" "$SENT" >&"${SNAP[1]}"
  local line; : > "$2"
  while IFS= read -r -t 1800 line <&"${SNAP[0]}"; do
    if [ "$line" = "$SENT" ]; then return 0; fi
    printf '%s\n' "$line" >> "$2"
  done
  return 1
}
ask "begin isolation level repeatable read read only; select pg_export_snapshot();" "$WORK/snap.txt" || { log "Sesi snapshot gagal: $(cat "$WORK/snap.txt" 2>/dev/null)"; exit 1; }
SNAP_ID="$(head -n1 "$WORK/snap.txt" | tr -d '\r')"
[[ "$SNAP_ID" =~ ^[0-9A-F]+-[0-9A-F]+-[0-9]+$ ]] || { log "Snapshot tidak valid: '$SNAP_ID'. Pakai koneksi langsung (port 5432), bukan pooler mode transaksi (6543). Keluaran: $(cat "$WORK/snap.txt")"; exit 1; }
log "Snapshot $SNAP_ID"

# ---- dump (dengan hak akses: dibutuhkan agar RLS/GRANT ikut pulih; pemilik tidak ikut) ----
"$PGDUMP" "$BACKUP_DATABASE_URL" --format=custom --no-owner --snapshot="$SNAP_ID" \
  --schema=public --schema=app --schema=auth --schema=supabase_migrations --file="$WORK/$F.dump"
TOC_LINES="$("$PGRESTORE" --list "$WORK/$F.dump" | wc -l)"
[ "$TOC_LINES" -gt 50 ] || { log "Dump mencurigakan kecil ($TOC_LINES baris daftar isi)"; exit 1; }
log "Dump selesai: $(stat -c %s "$WORK/$F.dump") byte, $TOC_LINES entri"

# ---- manifest + integritas, dari snapshot yang sama ----
ask "select app.backup_manifest_core(true);" "$WORK/inti.json" || { log "Manifest gagal: $(cat "$WORK/inti.json")"; exit 1; }
[ "$(wc -l < "$WORK/inti.json")" -eq 1 ] && node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$WORK/inti.json" 2>/dev/null || { log "Keluaran manifest bukan JSON: $(head -c 300 "$WORK/inti.json")"; exit 1; }
ask "select app.backup_integrity_all();" "$WORK/integ.json" || { log "integrity_check gagal: $(cat "$WORK/integ.json")"; exit 1; }
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$WORK/integ.json" 2>/dev/null || { log "Keluaran integrity bukan JSON: $(head -c 300 "$WORK/integ.json")"; exit 1; }
VIOL="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.total_pelanggaran===null?"":j.total_pelanggaran)' "$WORK/integ.json")"

# ---- daftar foto (nama berkas di bucket) ----
ask "select coalesce(to_regclass('storage.objects')::text, '');" "$WORK/has_storage.txt" || exit 1
: > "$WORK/foto_nama.txt"
if grep -q 'storage.objects' "$WORK/has_storage.txt"; then
  ask "select name from storage.objects where bucket_id = '$BUCKET' order by name;" "$WORK/foto_nama.txt" || { log "Daftar foto gagal"; exit 1; }
fi
printf 'commit;\n\\q\n' >&"${SNAP[1]}" || true
wait "$SPID" 2>/dev/null || true; SNAP_OPEN=0

# ---- unduh foto + sidik jari (bucket publik; tanpa kunci rahasia) ----
mkdir -p "$WORK/foto"; : > "$WORK/foto.tsv"; NFOTO=0
if [ -s "$WORK/foto_nama.txt" ]; then
  [ -n "${SUPABASE_URL:-}" ] || { log "Ada foto di bucket $BUCKET tetapi SUPABASE_URL tidak diisi. Isi Variable SUPABASE_URL (mis. https://xxxx.supabase.co). Cadangan dibatalkan agar tidak diam-diam tanpa foto."; exit 1; }
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    [[ "$name" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] && [[ "$name" != *..* ]] || { log "Nama foto tidak aman, dibatalkan: $name"; exit 1; }
    mkdir -p "$WORK/foto/$(dirname "$name")"
    curl -fsS --retry 3 --retry-delay 2 --max-time 60 -o "$WORK/foto/$name" "${SUPABASE_URL%/}/storage/v1/object/public/$BUCKET/$name" || { log "Unduh foto gagal: $name"; exit 1; }
    printf '%s\t%s\t%s\n' "$name" "$(stat -c %s "$WORK/foto/$name")" "$(sha256sum "$WORK/foto/$name" | cut -d' ' -f1)" >> "$WORK/foto.tsv"
    NFOTO=$((NFOTO + 1))
  done < "$WORK/foto_nama.txt"
  log "Foto diunduh: $NFOTO"
fi

# ---- gabung manifest ----
FOTO_ARG=(); [ "$NFOTO" -gt 0 ] && FOTO_ARG=(--foto "$WORK/foto.tsv")
node "$HERE/backup_finalize.js" --inti "$WORK/inti.json" --integritas "$WORK/integ.json" "${FOTO_ARG[@]}" \
  --meta "pg_dump=$("$PGDUMP" --version | head -c 60)" --meta "snapshot=$SNAP_ID" --meta "entri_dump=$TOC_LINES" --meta "berkas=$F.dump.gpg" --keluar "$WORK/$F.manifest.json" >/dev/null
MHASH="$(sha256sum "$WORK/$F.manifest.json" | cut -d' ' -f1)"
NTAB="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).jumlah_tabel)' "$WORK/$F.manifest.json")"

# ---- enkripsi (manifest berisi total keuangan, jadi ikut dienkripsi) ----
enc() { printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 --symmetric --cipher-algo AES256 -o "$2" "$1"; }
enc "$WORK/$F.dump" "$OUT_DIR/$F.dump.gpg"
enc "$WORK/$F.manifest.json" "$OUT_DIR/$F.manifest.json.gpg"
if [ "$NFOTO" -gt 0 ]; then tar -C "$WORK/foto" -cf "$WORK/$F.photos.tar" . && enc "$WORK/$F.photos.tar" "$OUT_DIR/$F.photos.tar.gpg"; fi

# ---- uji dekripsi: berkas yang tidak bisa dibuka lagi sama dengan tidak punya cadangan. Bandingkan isi hasil dekripsi dengan aslinya ----
dec() { printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --pinentry-mode loopback --passphrase-fd 0 -d "$1" 2>/dev/null; }
dec "$OUT_DIR/$F.dump.gpg" | cmp -s - "$WORK/$F.dump" || { log "Dump hasil dekripsi tidak sama dengan aslinya"; exit 1; }
dec "$OUT_DIR/$F.manifest.json.gpg" | cmp -s - "$WORK/$F.manifest.json" || { log "Manifest hasil dekripsi tidak sama dengan aslinya"; exit 1; }
if [ "$NFOTO" -gt 0 ]; then dec "$OUT_DIR/$F.photos.tar.gpg" | cmp -s - "$WORK/$F.photos.tar" || { log "Arsip foto hasil dekripsi tidak sama dengan aslinya"; exit 1; }; fi

# ---- catat keberhasilan (sumber status di Diagnostik) ----
SIZE="$(stat -c %s "$OUT_DIR/$F.dump.gpg")"
NOTE="integritas: ${VIOL:-tidak tersedia} temuan"
"$PSQL" "$BACKUP_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "select app.backup_record(jsonb_build_object('ok', true, 'file_name', '$F.dump.gpg', 'size_bytes', $SIZE, 'photos_count', $NFOTO, 'tables_count', $NTAB, 'manifest_hash', '$MHASH', 'integrity_violations', nullif('${VIOL}', '')::int, 'note', '$NOTE'))" >/dev/null
log "OK: $F.* (dump $SIZE byte, $NTAB tabel, $NFOTO foto, $NOTE)"
ARTIFACTS="$(cd "$OUT_DIR" && ls "$F".*.gpg | tr '\n' ' ')"
echo "ARTIFACTS=$ARTIFACTS"
if [ -n "${GITHUB_ENV:-}" ]; then echo "BACKUP_PREFIX=$F" >> "$GITHUB_ENV"; fi
