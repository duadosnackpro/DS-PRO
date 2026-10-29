// Edge Function admin-users: membuat/mengubah akun Supabase Auth untuk PIN login (username@users.duado.local).
// Hanya fungsi ini yang memakai SERVICE_ROLE (rahasia server, tidak pernah ke klien). Pemanggil diverifikasi dari JWT-nya dan
// harus owner (semua) atau admin (hanya role operasional pada outlet yang ditugaskan).
// Deploy: supabase functions deploy admin-users   (SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY disediakan platform)
// P1-6: npm: specifier (bukan CDN pihak ketiga saat runtime). Versi dipin.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { ALL_ROLES, allowRoleChangeDespite, callerFrom, checkTarget, corsFor, deactivationProblem, isPrivilegedRole, rateExceeded, secretProblem } from "./authz.ts";

const DOMAIN = "@users.duado.local";
let cors: Record<string, string> = corsFor(null, Deno.env.get("ALLOWED_ORIGINS"));   // diperbarui per permintaan di Deno.serve
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const OPS = ["supervisor", "kasir", "stok", "produksi"];


Deno.serve(async (req) => {
  cors = corsFor(req.headers.get("Origin"), Deno.env.get("ALLOWED_ORIGINS"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ message: "Metode tidak didukung" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer /i, "");
  const { data: au, error: ae } = await admin.auth.getUser(jwt);
  if (ae || !au.user) return json({ message: "Sesi berakhir, silakan masuk lagi." }, 401);
  const caller = au.user.id;

  // P1-6: batas laju per pemanggil per menit. Bila fungsi hitung belum ada/gagal, jangan mengunci admin (gagal-buka, dicatat).
  const { data: hits, error: he } = await admin.rpc("rpc_admin_rate_hit", { p: { caller } });
  if (he) console.warn("rate limit tidak aktif:", he.message);
  else if (rateExceeded(hits)) return json({ message: "Terlalu banyak permintaan. Coba lagi sebentar." }, 429);

  const { data: prof } = await admin.from("profiles").select("status").eq("id", caller).maybeSingle();
  const { data: mem } = await admin.from("memberships").select("role,outlet_id").eq("user_id", caller).eq("status", "active");
  if (prof?.status !== "active" || !mem?.length) return json({ message: "Akses ditolak." }, 403);
  const { isOwner, adminOutlets, globalAdmin } = callerFrom(mem);
  if (!isOwner && !globalAdmin && !adminOutlets.length) return json({ message: "Hanya owner/admin yang dapat mengelola pengguna." }, 403);

  let b: any; try { b = await req.json(); } catch { return json({ message: "Permintaan tidak valid." }, 400); }
  const audit = (action: string, entity_id: string, after: unknown) =>
    admin.from("audit_logs").insert({ actor_id: caller, action, entity: "profiles", entity_id, after });

  if (b.action === "create") {
    const username = String(b.username ?? "").trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return json({ message: "Username 3-30 karakter: huruf kecil, angka, titik, strip." }, 400);
    const role = String(b.role ?? "");
    const pp = secretProblem(String(b.pin ?? ""), isPrivilegedRole([role])); if (pp) return json({ message: pp }, 400);   // F8: Owner/Admin/Auditor = kata sandi >= 10 karakter
    const outlets: string[] = Array.isArray(b.outlet_ids) ? b.outlet_ids : [];
    if (role === "owner" || !OPS.includes(role)) { if (!isOwner) return json({ message: "Hanya owner yang dapat membuat owner/admin/auditor." }, 403); }
    if (!isOwner && !outlets.every((o) => globalAdmin || adminOutlets.includes(o))) return json({ message: "Outlet di luar kewenangan Anda." }, 403);
    if (role !== "owner" && !["admin", "auditor"].includes(role) && !outlets.length) return json({ message: "Pilih minimal satu outlet." }, 400);
    const { data: created, error } = await admin.auth.admin.createUser({ email: username + DOMAIN, password: String(b.pin), email_confirm: true });
    if (error || !created.user) return json({ message: /already|registered/i.test(error?.message ?? "") ? "Username sudah dipakai." : "Gagal membuat akun." }, 400);
    const uid = created.user.id;
    const { error: pe } = await admin.from("profiles").insert({ id: uid, username, full_name: String(b.full_name ?? username), default_outlet_id: outlets[0] ?? null });
    if (pe) { await admin.auth.admin.deleteUser(uid); return json({ message: "Gagal menyimpan profil (username mungkin sudah dipakai)." }, 400); }
    const rows = (role === "owner" || !outlets.length) ? [{ user_id: uid, outlet_id: null, role, created_by: caller }] : outlets.map((o) => ({ user_id: uid, outlet_id: o, role, created_by: caller }));
    const { error: me } = await admin.from("memberships").insert(rows);
    if (me) { await admin.from("profiles").delete().eq("id", uid); await admin.auth.admin.deleteUser(uid); return json({ message: "Gagal menetapkan akses: " + me.message }, 400); }
    await audit("user_create", uid, { username, role, outlets });
    return json({ id: uid, username });
  }

  if (b.action === "update") {
    const uid = String(b.user_id ?? "");
    const { data: target, error: te } = await admin.from("memberships").select("role,outlet_id").eq("user_id", uid).eq("status", "active");
    if (te) return json({ message: "Gagal memeriksa pengguna." }, 500);
    // P0-2: select mengembalikan array (tidak pernah null). Tanpa keanggotaan aktif => 404, bukan lolos ke pemeriksaan kewenangan.
    const verdict = checkTarget({ isOwner, globalAdmin, adminOutlets }, target);
    const wantRole = typeof b.role === "string" && b.role ? String(b.role) : null;
    if (!verdict.ok && !allowRoleChangeDespite(verdict, { isOwner, globalAdmin, adminOutlets }, wantRole)) return json({ message: verdict.message }, verdict.status);
    // P1-6: peran, PIN, status, dan nama dalam SATU permintaan. Peran diubah lebih dulu lewat rpc_membership_set dengan JWT pemanggil,
    // sehingga aturan database (owner terakhir, admin hanya peran operasional di outlet-nya, audit) tetap berlaku. Auth dan database adalah
    // dua sistem; bila langkah sesudahnya gagal, respons menyebut apa yang sudah berlaku dan menyimpan ulang aman (semua langkah idempoten).
    // F8: jenis kredensial mengikuti peran SESUDAH perubahan (peran baru bila diganti, kalau tidak peran sekarang).
    if (b.pin) { const pp0 = secretProblem(String(b.pin), isPrivilegedRole(wantRole ? [wantRole] : target.map((m) => m.role))); if (pp0) return json({ message: pp0 }, 400); }   // validasi sebelum ada yang berubah
    // F5: semua pemeriksaan penonaktifan SEBELUM peran, Auth, atau profil disentuh. Sebelumnya ban_duration sudah terpasang di Auth ketika
    // pemeriksaan "akun sendiri / owner terakhir" menolak, sehingga owner tunggal terkunci meski API membalas galat.
    if (b.status === "inactive") {
      const { data: others, error: oe } = await admin.from("memberships").select("user_id").eq("role", "owner").is("outlet_id", null).eq("status", "active").neq("user_id", uid);
      if (oe) return json({ message: "Gagal memeriksa owner lain." }, 500);
      const dp = deactivationProblem(caller, uid, target, others?.length ?? 0); if (dp) return json({ message: dp }, 400);
    }
    let roleApplied = false;
    if (wantRole) {
      if (!ALL_ROLES.includes(wantRole)) return json({ message: "Peran tidak dikenal." }, 400);
      const asCaller = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${jwt}` } } });
      const outletId = wantRole === "owner" ? null : (b.outlet_id ?? null);
      const { error: re } = await asCaller.rpc("rpc_membership_set", { p: { user_id: uid, outlet_id: outletId, role: wantRole, status: "active" } });
      if (re) return json({ message: re.message }, re.code === "42501" ? 403 : 400);
      roleApplied = true;
    }
    const partial = roleApplied ? " Peran sudah diubah; simpan ulang untuk menyelesaikan sisanya." : "";
    const patch: Record<string, unknown> = {};
    if (b.pin) patch.password = String(b.pin);
    if (b.status === "inactive" || b.status === "active") patch.ban_duration = b.status === "inactive" ? "876000h" : "none";  // cegah refresh token
    if (Object.keys(patch).length) { const { error } = await admin.auth.admin.updateUserById(uid, patch); if (error) return json({ message: "Gagal memperbarui akun." + partial }, 400); }
    const pu: Record<string, unknown> = {};
    if (b.full_name) pu.full_name = String(b.full_name);
    if (b.status) {
      pu.status = b.status;
    }
    if (Object.keys(pu).length) { const { error: pe } = await admin.from("profiles").update(pu).eq("id", uid); if (pe) return json({ message: "Gagal menyimpan profil." + partial }, 500); }
    await audit("user_update", uid, { diubah: [...Object.keys({ ...patch, ...pu }).filter((k) => k !== "password"), ...(roleApplied ? ["role"] : [])] });  // PIN tidak pernah dicatat
    return json({ id: uid });
  }
  return json({ message: "Aksi tidak dikenal." }, 400);
});
