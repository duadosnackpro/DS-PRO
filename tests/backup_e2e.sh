#!/usr/bin/env bash
# Uji ujung-ke-ujung cadangan dan pemulihan (Fase 2): tools/backup.sh -> tools/restore.sh -> tools/restore_verify.sh pada Postgres sungguhan.
#   ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres bash tests/backup_e2e.sh
# ADMIN_URL = superuser pada server UJI (skrip membuat dan menghapus database bernama duado_e2e_*; jangan arahkan ke server berisi data penting).
# Yang dibuktikan: pemulihan ke DB kosong dan ke DB bergaya Supabase lolos dengan selisih Rp 0; snapshot tetap konsisten saat ada penulisan serentak;
# 9 jenis kerusakan pada hasil pemulihan semuanya terdeteksi (termasuk "jumlah baris sama tetapi angkanya salah"); pengaman menolak target salah;
# foto produk ikut dicadangkan dan dipulihkan dengan sha256 yang cocok. Yang TIDAK dibuktikan: Supabase sungguhan (Storage, auth, pooler).
set -uo pipefail
: "${ADMIN_URL:?isi ADMIN_URL (superuser server uji)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; SQL="$ROOT/supabase"; TOOLS="$ROOT/tools"
SFX="$$"; BASEURL="${ADMIN_URL%/*}"; PASS="e2e-pass-$SFX"; WORK="$(mktemp -d)"; PASSED=0; FAILED=0; PIDS=()
dbu() { echo "$BASEURL/$1"; }
A() { psql "$ADMIN_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
Q() { psql "$(dbu "$1")" -X -q -A -t -v ON_ERROR_STOP=1 -c "$2"; }
ok()  { if [ "$1" = 0 ]; then PASSED=$((PASSED + 1)); else FAILED=$((FAILED + 1)); echo "GAGAL: $2"; fi; }
chk() { local desc="$1"; shift; if "$@" >/dev/null 2>&1; then ok 0 "$desc"; else ok 1 "$desc"; fi; }
has() { grep -q -- "$2" "$1"; }                         # has berkas pola
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done; for d in $(psql "$ADMIN_URL" -X -q -A -t -c "select datname from pg_database where datname like 'duado_e2e_${SFX}_%'"); do psql "$ADMIN_URL" -X -q -c "drop database if exists \"$d\" with (force)" >/dev/null 2>&1; done; rm -rf "$WORK"; }
trap cleanup EXIT
mk() { A -c "create database \"duado_e2e_${SFX}_$1\"" >/dev/null 2>&1; echo "duado_e2e_${SFX}_$1"; }
build() { # build <db> <daftar tes...> : skema + migrasi + seed + tes terpilih (membangun data lewat RPC asli)
  local db="$1"; shift; local u; u="$(dbu "$db")"; local P=(psql "$u" -X -q -v ON_ERROR_STOP=1)
  "${P[@]}" -f "$SQL/tests/harness_plain_pg.sql" >/dev/null 2>&1 && for f in "$SQL"/migrations/*.sql; do "${P[@]}" -f "$f" >/dev/null 2>&1 || { echo "migrasi gagal: $f"; return 1; }; done
  "${P[@]}" -f "$SQL/seed.sql" >/dev/null 2>&1; for t in "$@"; do "${P[@]}" -f "$SQL/tests/$t.test.sql" >/dev/null 2>"$WORK/b.err" || { echo "tes $t gagal: $(head -2 "$WORK/b.err")"; return 1; }; done; }
backup() { # backup <db> <stamp> [env...]
  local db="$1" st="$2"; shift 2; env BACKUP_DATABASE_URL="$(dbu "$db")" BACKUP_PASSPHRASE="$PASS" OUT_DIR="$WORK/out" STAMP="$st" "$@" bash "$TOOLS/backup.sh" > "$WORK/backup_$st.log" 2>&1; }
restore() { # restore <target db> <stamp> [opsi...]
  local db="$1" st="$2"; shift 2; TARGET_DATABASE_URL="$(dbu "$db")" BACKUP_PASSPHRASE="${RESTORE_PASS:-$PASS}" bash "$TOOLS/restore.sh" --konfirmasi "$db" "$@" "$WORK/out/duado-$st.dump.gpg" > "$WORK/restore_$st.log" 2>&1; }
dec_manifest() { printf '%s' "$PASS" | gpg --batch --pinentry-mode loopback --passphrase-fd 0 -o "$WORK/man_$1.json" -d "$WORK/out/duado-$1.manifest.json.gpg" 2>/dev/null; }
verify() { TARGET_DATABASE_URL="$(dbu "$1")" bash "$TOOLS/restore_verify.sh" "$WORK/man_$2.json" "${@:3}" > "$WORK/verify.log" 2>&1; }
cd "$SQL"   # tes 012 membaca ../tests/vectors lewat jalur relatif dari supabase/
mkdir -p "$WORK/out"; export GNUPGHOME="$WORK/gnupg"; mkdir -p "$GNUPGHOME"; chmod 700 "$GNUPGHOME"

echo "== 1. Sumber bersih (data lewat RPC asli: pembelian, produksi, penjualan, retur)"
SRC="$(mk src)"; build "$SRC" 001_multi_outlet 002_p0_kontrol 003_p1_kontrol 004_data_reset 005_observability_realtime 011_integrity_check 012_money_vectors || { echo "Pembangunan sumber gagal"; exit 1; }
ok "$([ "$(Q "$SRC" "select (app.backup_integrity_all() ->> 'total_pelanggaran')")" = 0 ] && echo 0 || echo 1)" "sumber bersih: integrity_all = 0"

echo "== 2. Cadangan SAAT ada penulisan serentak (uji snapshot)"
( while :; do psql "$(dbu "$SRC")" -X -q -c "insert into public.sync_events (kind) values ('cat')" >/dev/null 2>&1; done ) & WR=$!; PIDS+=("$WR")
sleep 0.3; backup "$SRC" T1; RC=$?; kill "$WR" 2>/dev/null; wait "$WR" 2>/dev/null
ok "$RC" "backup.sh sukses (rc=$RC): $(tail -2 "$WORK/backup_T1.log" | tr '\n' ' ')"
dec_manifest T1
MCOUNT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tabel["public.sync_events"].baris)' "$WORK/man_T1.json")"
LIVE="$(Q "$SRC" "select count(*) from public.sync_events")"
ok "$([ "$LIVE" -gt "$MCOUNT" ] && echo 0 || echo 1)" "penulis serentak benar-benar menulis SESUDAH snapshot (manifest $MCOUNT < hidup $LIVE), jadi uji ini tidak kosong"
chk "berkas hasil: dump, manifest terenkripsi" test -s "$WORK/out/duado-T1.dump.gpg" -a -s "$WORK/out/duado-T1.manifest.json.gpg"
chk "dump bukan teks biasa (terenkripsi)" bash -c "! head -c 200 '$WORK/out/duado-T1.dump.gpg' | grep -q PGDMP"
ok "$(Q "$SRC" "select count(*) from app.backup_runs where ok and file_name = 'duado-T1.dump.gpg'" | grep -q '^1$' && echo 0 || echo 1)" "keberhasilan tercatat di app.backup_runs"

echo "== 3. Pemulihan ke database KOSONG (semua skema) harus SAH, bersih, selisih Rp 0"
T1="$(mk r_kosong)"; restore "$T1" T1 --semua-skema; RC=$?
ok "$RC" "restore ke DB kosong rc=0 (rc=$RC)"; has "$WORK/restore_T1.log" "PUTUSAN: SAH (bersih)"; ok $? "putusan 'SAH (bersih)'"
has "$WORK/restore_T1.log" "Selisih uang terbesar: Rp 0 "; ok $? "selisih uang terbesar Rp 0"
has "$WORK/restore_T1.log" "baris berbeda: 0, isi berbeda: 0"; ok $? "nol baris dan nol isi berbeda"
restore "$T1" T1 --semua-skema --timpa --ketat; ok $? "mode --ketat lolos pada sumber bersih (rc=$?)"

echo "== 4. Pemulihan ke DB bergaya Supabase (skema sudah ada, hanya public + app dipulihkan; akun auth target BEDA dari sumber)"
T2="$(mk r_supabase)"; build "$T2" || exit 1
restore "$T2" T1; RC=$?; ok "$([ "$RC" = 1 ] && echo 0 || echo 1)" "staging tanpa akun sumber dan tanpa --stub-auth: TIDAK SAH rc=1 (rc=$RC), bukan lolos diam-diam"
has "$WORK/restore_T1.log" "PUTUSAN: TIDAK SAH"; ok $? "putusan tertulis TIDAK SAH"
has "$WORK/restore_T1.log" "konstrain_n"; ok $? "penyebab terlihat: jumlah konstrain (FK profiles -> auth.users) berbeda"
restore "$T2" T1 --stub-auth; RC=$?; ok "$([ "$RC" = 2 ] && echo 0 || echo 1)" "target berisi data ditolak tanpa --timpa, juga dengan --stub-auth (rc=$RC)"; has "$WORK/restore_T1.log" "sudah berisi"; ok $? "pesan penolakan menyebut target berisi"
restore "$T2" T1 --stub-auth --timpa; RC=$?; ok "$RC" "dengan --stub-auth --timpa: rc=0: $(grep -E 'PUTUSAN|DITOLAK' "$WORK/restore_T1.log" | head -1)"
has "$WORK/restore_T1.log" "PUTUSAN: SAH (bersih)"; ok $? "DB bergaya Supabase + akun pengganti: SAH (bersih)"
has "$WORK/restore_T1.log" "Akun pengganti"; ok $? "log menyebut akun pengganti dibuat"
[ "$(Q "$T2" "select count(*) from auth.users where email like 'pemulihan-%@invalid.invalid'")" -gt 0 ]; ok $? "baris pengganti ada di auth.users target dan bertanda email palsu"
restore "$T2" T1 --semua-skema --stub-auth --timpa >/dev/null 2>&1; RC=$?; ok "$([ "$RC" = 2 ] && echo 0 || echo 1)" "--stub-auth bersama --semua-skema ditolak rc=2 (rc=$RC)"
T2B="$(mk r_akun_ada)"; build "$T2B" || exit 1
for u in $(Q "$SRC" "select id from public.profiles"); do Q "$T2B" "insert into auth.users (id, email) values ('$u', 'asli-$u@contoh.id')" >/dev/null; done
restore "$T2B" T1; RC=$?; ok "$RC" "staging yang SUDAH punya akun sumber: SAH tanpa --stub-auth (rc=$RC)"
has "$WORK/restore_T1.log" "PUTUSAN: SAH (bersih)"; ok $? "akun asli: SAH (bersih)"


echo "== 5. Pengaman"
TARGET_DATABASE_URL="$(dbu "$T1")" BACKUP_PASSPHRASE="$PASS" bash "$TOOLS/restore.sh" --konfirmasi salah_nama "$WORK/out/duado-T1.dump.gpg" >/dev/null 2>&1; RC=$?; ok "$([ "$RC" = 2 ] && echo 0 || echo 1)" "--konfirmasi salah ditolak rc=2 (rc=$RC)"
TARGET_DATABASE_URL="$(dbu "$T1")" BACKUP_DATABASE_URL="$(dbu "$T1")" BACKUP_PASSPHRASE="$PASS" bash "$TOOLS/restore.sh" --konfirmasi "$T1" --timpa "$WORK/out/duado-T1.dump.gpg" >/dev/null 2>&1; RC=$?; ok "$([ "$RC" = 2 ] && echo 0 || echo 1)" "target sama dengan URL produksi ditolak rc=2 (rc=$RC)"
TARGET_DATABASE_URL="$(dbu "$T1")" BACKUP_PASSPHRASE="$PASS" bash "$TOOLS/restore.sh" "$WORK/out/duado-T1.dump.gpg" >/dev/null 2>&1; RC=$?; ok "$([ "$RC" = 2 ] && echo 0 || echo 1)" "tanpa --konfirmasi ditolak rc=2 (rc=$RC)"
RESTORE_PASS="salah" restore "$T1" T1 --semua-skema --timpa; RC=$?; ok "$([ "$RC" = 1 ] && echo 0 || echo 1)" "passphrase salah gagal rc=1 (rc=$RC)"; has "$WORK/restore_T1.log" "Dekripsi gagal"; ok $? "pesan dekripsi gagal"
cp "$WORK/out/duado-T1.dump.gpg" "$WORK/out/duado-BAD.dump.gpg"; cp "$WORK/out/duado-T1.manifest.json.gpg" "$WORK/out/duado-BAD.manifest.json.gpg"
printf '\xff' | dd of="$WORK/out/duado-BAD.dump.gpg" bs=1 seek=50000 conv=notrunc 2>/dev/null
restore "$T1" BAD --semua-skema --timpa; RC=$?; ok "$([ "$RC" = 1 ] && echo 0 || echo 1)" "dump rusak 1 byte terdeteksi sebelum dipulihkan rc=1 (rc=$RC)"
cp "$WORK/out/duado-T1.dump.gpg" "$WORK/out/duado-NOM.dump.gpg"
restore "$T1" NOM --semua-skema --timpa; RC=$?; ok "$([ "$RC" = 2 ] && echo 0 || echo 1)" "tanpa manifest ditolak rc=2 (rc=$RC)"

echo "== 6. Kerusakan pada hasil pemulihan HARUS terdeteksi (jumlah baris tidak cukup)"
dec_manifest T1
tamper() { # tamper <nama> <sql> <pola-yang-harus-muncul> [pola-yang-TIDAK-boleh-muncul]
  local db; db="$(mk "t_$1")"; A -c "drop database \"$db\" with (force)" >/dev/null; A -c "create database \"$db\" template \"$T2\"" >/dev/null 2>&1 || { ok 1 "salin DB untuk $1"; return; }
  psql "$(dbu "$db")" -X -q -v ON_ERROR_STOP=1 -c "set session_replication_role = replica" -c "$2" >/dev/null 2>&1 || psql "$(dbu "$db")" -X -q -v ON_ERROR_STOP=1 -c "$2" >/dev/null 2>&1 || { ok 1 "mutasi $1 gagal diterapkan"; return; }
  verify "$db" T1; local rc=$?
  ok "$([ "$rc" = 1 ] && echo 0 || echo 1)" "kerusakan '$1' membuat verifikasi TIDAK SAH (rc=$rc)"
  has "$WORK/verify.log" "$3"; ok $? "kerusakan '$1' dilaporkan dengan benar (pola: $3)"
  if [ -n "${4:-}" ]; then ! has "$WORK/verify.log" "$4"; ok $? "kerusakan '$1' tidak salah dilaporkan sebagai: $4"; fi
}
tamper selisih_sen "update public.sales set total = total + 0.01 where id = (select id from public.sales order by created_at limit 1)" "target-sumber 0.01" "Jumlah baris public.sales"
tamper baris_hilang "delete from public.payments where id = (select id from public.payments limit 1)" "Jumlah baris public.payments"
tamper nama_produk "update public.products set name = name || 'x' where id = (select id from public.products limit 1)" "Isi tabel public.products berbeda" "SELISIH \[kendali\]"
tamper kuantitas_ledger "update public.stock_movements set quantity_delta = quantity_delta + 0.0001 where id = (select min(id) from public.stock_movements)" "SELISIH \[kendali\] Total kendali ledger"
tamper saldo_rusak "update public.inventory_material_balances set quantity = quantity + 1 where ctid = (select ctid from public.inventory_material_balances limit 1)" "pelanggaran di target"
tamper hak_dicabut "revoke select on public.channels from authenticated" "Hak akses/RLS berbeda (hak_tabel_hash)" "SELISIH \[kendali\]"
tamper rls_mati "alter table public.sales disable row level security" "rls_tabel_hash"
tamper kebijakan_hilang "drop policy sync_events_read on public.sync_events" "kebijakan_hash"
tamper tabel_ekstra "create table public.zz_ekstra (id int)" "ada di target tetapi tidak ada di manifest"
tamper fk_hilang "alter table public.profiles drop constraint profiles_id_fkey" "konstrain_hash" "SELISIH \\[kendali\\]"
tamper konstrain_check_hilang "do \$\$ declare c record; begin select conrelid::regclass::text as t, conname into c from pg_constraint where contype = 'c' and connamespace = 'public'::regnamespace limit 1; execute format('alter table %s drop constraint %I', c.t, c.conname); end \$\$" "konstrain_hash"
tamper indeks_hilang "do \$\$ declare i text; begin select indexname into i from pg_indexes where schemaname = 'public' and indexname not like '%_pkey' and indexname not like '%_key' limit 1; execute 'drop index public.' || quote_ident(i); end \$\$" "indeks_hash"
tamper trigger_hilang "do \$\$ declare t record; begin select c.oid::regclass::text as r, g.tgname as n into t from pg_trigger g join pg_class c on c.oid = g.tgrelid where not g.tgisinternal and c.relnamespace = 'public'::regnamespace limit 1; execute format('drop trigger %I on %s', t.n, t.r); end \$\$" "trigger_hash"
tamper kolom_ekstra "alter table public.channels add column zz_ekstra int" "kolom_hash"
tamper fungsi_diubah "alter function app.backup_integrity_all() set statement_timeout = '1h'" "fungsi_hash"
verify "$T2" T1; ok $? "kontrol: DB tidak dirusak tetap SAH"

echo "== 7. Sumber dengan temuan integritas bawaan (data tes 006 menyuntik penjualan langsung)"
psql "$(dbu "$SRC")" -X -q -v ON_ERROR_STOP=1 -f "$SQL/tests/006_report_ops.test.sql" >/dev/null 2>&1; ok $? "menyuntik temuan bawaan ke sumber"
NB="$(Q "$SRC" "select (app.backup_integrity_all() ->> 'total_pelanggaran')")"; ok "$([ "$NB" -gt 0 ] && echo 0 || echo 1)" "sumber kini punya $NB temuan integritas"
backup "$SRC" T2; ok $? "backup dengan temuan bawaan tetap berhasil"
T3="$(mk r_bawaan)"; restore "$T3" T2 --semua-skema; RC=$?; ok "$RC" "restore sumber bertemuan: SAH (rc=$RC)"
has "$WORK/restore_T2.log" "SAH, dengan $NB temuan integritas bawaan sumber (bukan bersih)"; ok $? "putusan jujur: 'SAH, dengan $NB temuan bawaan (bukan bersih)', bukan 'bersih'"
restore "$T3" T2 --semua-skema --timpa --ketat; RC=$?; ok "$([ "$RC" = 1 ] && echo 0 || echo 1)" "--ketat menolak pemulihan yang masih punya temuan (rc=$RC)"
Q "$SRC" "select (app.backup_integrity_all() ->> 'total_pelanggaran')" >/dev/null
ok "$(Q "$SRC" "select count(*) from app.backup_runs where integrity_violations = $NB and ok" | grep -q '^[1-9]' && echo 0 || echo 1)" "jumlah temuan integritas tercatat di app.backup_runs"

echo "== 8. Foto produk (server Storage tiruan)"
PORT_S=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'); PORT_T=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
mkdir -p "$WORK/stor_src/product-photos/aaaaaaaa-0000-4000-8000-000000000001" "$WORK/stor_src/product-photos/aaaaaaaa-0000-4000-8000-000000000002" "$WORK/stor_tgt"
head -c 3000 /dev/urandom > "$WORK/stor_src/product-photos/aaaaaaaa-0000-4000-8000-000000000001/k1a2.webp"
head -c 4096 /dev/urandom > "$WORK/stor_src/product-photos/aaaaaaaa-0000-4000-8000-000000000001/k1a3.jpg"
head -c 100 /dev/urandom > "$WORK/stor_src/product-photos/aaaaaaaa-0000-4000-8000-000000000002/z9.png"
python3 "$TOOLS/../tests/mock_storage.py" "$PORT_S" "$WORK/stor_src" & PIDS+=("$!"); python3 "$TOOLS/../tests/mock_storage.py" "$PORT_T" "$WORK/stor_tgt" --kunci KUNCI-TARGET & PIDS+=("$!")
sleep 0.5
FS="$(mk foto)"; build "$FS" 001_multi_outlet 002_p0_kontrol 003_p1_kontrol 004_data_reset 005_observability_realtime 011_integrity_check 012_money_vectors || exit 1
psql "$(dbu "$FS")" -X -q -v ON_ERROR_STOP=1 -c "create schema storage; create table storage.objects (bucket_id text, name text)" -c "insert into storage.objects values ('product-photos','aaaaaaaa-0000-4000-8000-000000000001/k1a2.webp'),('product-photos','aaaaaaaa-0000-4000-8000-000000000001/k1a3.jpg'),('product-photos','aaaaaaaa-0000-4000-8000-000000000002/z9.png'),('lain','x/tidak-ikut.png')" >/dev/null
backup "$FS" F0; RC=$?; ok "$([ "$RC" != 0 ] && echo 0 || echo 1)" "ada foto tetapi SUPABASE_URL kosong: cadangan DIBATALKAN (rc=$RC)"; has "$WORK/backup_F0.log" "SUPABASE_URL"; ok $? "pesan menyebut SUPABASE_URL"
ok "$(ls "$WORK/out"/duado-F0.* >/dev/null 2>&1 && echo 1 || echo 0)" "cadangan batal tidak meninggalkan berkas setengah jadi"
ok "$(Q "$FS" "select count(*) from app.backup_runs where not ok and note like 'backup.sh gagal%'" | grep -q '^1$' && echo 0 || echo 1)" "kegagalan tercatat di app.backup_runs (ok=false)"
backup "$FS" F1 SUPABASE_URL="http://127.0.0.1:$PORT_S"; ok $? "backup dengan foto sukses: $(tail -1 "$WORK/backup_F1.log")"
chk "arsip foto ada" test -s "$WORK/out/duado-F1.photos.tar.gpg"
printf '%s' "$PASS" | gpg --batch --pinentry-mode loopback --passphrase-fd 0 -o "$WORK/man_F1.json" -d "$WORK/out/duado-F1.manifest.json.gpg" 2>/dev/null
ok "$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(m.foto.jumlah===3&&m.foto.berkas.every(b=>/^[0-9a-f]{64}$/.test(b.sha256))?0:1)' "$WORK/man_F1.json" && echo 0 || echo 1)" "manifest memuat 3 foto (bucket lain tidak ikut) dengan sha256"
FT="$(mk foto_t)"
TARGET_SUPABASE_URL="http://127.0.0.1:$PORT_T" TARGET_SERVICE_KEY=KUNCI-TARGET restore "$FT" F1 --semua-skema --foto; RC=$?; ok "$RC" "restore + foto rc=0 (rc=$RC): $(grep -E 'Foto:|PUTUSAN' "$WORK/restore_F1.log" | tr '\n' ' ')"
chk "foto di target identik byte demi byte" diff -r "$WORK/stor_src/product-photos" "$WORK/stor_tgt/product-photos"
TARGET_SUPABASE_URL="http://127.0.0.1:$PORT_T" TARGET_SERVICE_KEY=KUNCI-SALAH restore "$FT" F1 --semua-skema --timpa --foto; RC=$?; ok "$([ "$RC" = 1 ] && echo 0 || echo 1)" "kunci service salah: foto gagal diunggah => TIDAK SAH rc=1 (rc=$RC)"
PORT_R=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'); mkdir -p "$WORK/stor_bad"
python3 "$TOOLS/../tests/mock_storage.py" "$PORT_R" "$WORK/stor_bad" --kunci K --rusak & PIDS+=("$!"); sleep 0.5
TARGET_SUPABASE_URL="http://127.0.0.1:$PORT_R" TARGET_SERVICE_KEY=K restore "$FT" F1 --semua-skema --timpa --foto; RC=$?; ok "$([ "$RC" = 1 ] && echo 0 || echo 1)" "server mengembalikan berkas berbeda: verifikasi sha256 menolak rc=1 (rc=$RC)"

echo "== 9. Target Postgres uji (CI) tanpa peran bawaan sumber: --buat-peran"
RL="zz_peran_$SFX"
A -c "create role $RL nologin" >/dev/null 2>&1
Q "$SRC" "grant select on public.channels to $RL; grant usage on schema public to $RL" >/dev/null
backup "$SRC" P9; ok $? "backup dengan GRANT ke peran khusus"; dec_manifest P9
Q "$SRC" "drop owned by $RL" >/dev/null; A -c "drop role $RL" >/dev/null 2>&1
mkh() { local d; d="$(mk "$1")"; psql "$(dbu "$d")" -X -q -v ON_ERROR_STOP=1 -f "$SQL/tests/harness_plain_pg.sql" >/dev/null 2>&1; echo "$d"; }
P9A="$(mkh peran_a)"; restore "$P9A" P9 --stub-auth; RC=$?; ok "$([ "$RC" = 1 ] && echo 0 || echo 1)" "tanpa --buat-peran: peran hilang membuat hak berbeda, TIDAK SAH (rc=$RC)"; has "$WORK/restore_P9.log" "hak_tabel"; ok $? "penyebab terlihat: hak tabel berbeda"
P9B="$(mkh peran_b)"; restore "$P9B" P9 --stub-auth --buat-peran; RC=$?; ok "$RC" "dengan --buat-peran: SAH (rc=$RC): $(grep -E 'PUTUSAN' "$WORK/restore_P9.log" | head -1)"; has "$WORK/restore_P9.log" "Peran: 1 peran baru"; ok $? "log menyebut peran dibuat"
A -c "drop database if exists \"$P9B\" with (force)" >/dev/null 2>&1; A -c "drop role if exists $RL" >/dev/null 2>&1

echo
echo "Hasil e2e cadangan/pemulihan: $PASSED lulus, $FAILED gagal"
[ "$FAILED" = 0 ]
