// Logika kewenangan admin-users yang murni (tanpa Deno/Supabase) supaya bisa diuji otomatis. Hanya sintaks TypeScript yang dapat dihapus (tanpa enum/namespace).
export type Membership = { role: string; outlet_id: string | null };
export type Caller = { isOwner: boolean; globalAdmin: boolean; adminOutlets: (string | null)[] };
export type Verdict = { ok: true } | { ok: false; status: 403 | 404; message: string };

export function callerFrom(mem: Membership[]): Caller {
  return {
    isOwner: mem.some((m) => m.role === "owner" && m.outlet_id === null),
    globalAdmin: mem.some((m) => m.role === "admin" && m.outlet_id === null),
    adminOutlets: mem.filter((m) => m.role === "admin").map((m) => m.outlet_id),
  };
}

// P0-2: hasil select adalah ARRAY, jadi `!target` tidak pernah benar. Pengguna tanpa keanggotaan aktif harus 404,
// bukan lolos (Array.prototype.every pada larik kosong bernilai true).
export function checkTarget(c: Caller, target: Membership[] | null | undefined): Verdict {
  if (!target?.length) return { ok: false, status: 404, message: "Pengguna tidak ditemukan." };
  const privileged = target.some((m) => ["owner", "admin", "auditor"].includes(m.role));
  if (!c.isOwner && (privileged || !target.every((m) => c.globalAdmin || c.adminOutlets.includes(m.outlet_id)))) {
    return { ok: false, status: 403, message: "Di luar kewenangan Anda." };
  }
  return { ok: true };
}

// ---- P1-6 ----
export const ALL_ROLES = ["owner", "admin", "supervisor", "kasir", "stok", "produksi", "auditor"];
export const RATE_PER_MINUTE = 30;

// CORS: bila ALLOWED_ORIGINS (daftar dipisah koma, mis. https://akun.github.io) diisi, hanya origin itu yang dipantulkan.
// Bila kosong tetap "*" (perilaku lama) supaya deploy tidak memutus klien; fungsi ini memakai header Authorization (bukan cookie),
// jadi pembatasan ini lapisan tambahan, bukan satu-satunya pagar.
export function corsFor(origin: string | null, allowed: string | undefined): Record<string, string> {
  const base = { "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  const list = (allowed ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  if (!list.length) return { ...base, "Access-Control-Allow-Origin": "*" };
  const o = (origin ?? "").replace(/\/$/, "");
  return list.includes(o) ? { ...base, "Access-Control-Allow-Origin": o, "Vary": "Origin" } : { ...base, "Vary": "Origin" };
}

export const rateExceeded = (n: unknown, limit = RATE_PER_MINUTE): boolean => Number(n) > limit;

// Perubahan peran lewat Edge Function: owner boleh memulihkan akses pengguna yang tidak punya keanggotaan aktif (404 pada pemeriksaan biasa);
// admin non-owner tidak. Kewenangan peran/outlet yang sebenarnya tetap ditegakkan rpc_membership_set di database.
export function allowRoleChangeDespite(v: Verdict, c: Caller, role: string | null): boolean {
  return !v.ok && v.status === 404 && c.isOwner && !!role;
}

// ---- F5: pemeriksaan penonaktifan HARUS selesai sebelum ada yang diubah di Auth (ban_duration tidak bisa dibatalkan oleh rollback database) ----
// Mengembalikan pesan galat, atau null bila aman. `otherActiveOwners` = jumlah owner global aktif SELAIN target.
export function deactivationProblem(caller: string, uid: string, target: Membership[], otherActiveOwners: number): string | null {
  if (uid === caller) return "Tidak dapat menonaktifkan akun sendiri.";
  if (target.some((m) => m.role === "owner") && otherActiveOwners < 1) return "Tidak boleh menonaktifkan owner aktif terakhir.";
  return null;
}

// ---- F8: kredensial ----
// Owner/Admin/Auditor memegang akses luas: kata sandi minimal 10 karakter (huruf dan angka), bukan PIN. Peran operasional tetap PIN 6-10 angka.
export const PRIVILEGED_ROLES = ["owner", "admin", "auditor"];
export const isPrivilegedRole = (roles: string[]): boolean => roles.some((r) => PRIVILEGED_ROLES.includes(r));

export function secretProblem(secret: string, privileged: boolean): string | null {
  if (privileged) {
    if (secret.length < 10) return "Kata sandi Owner/Admin/Auditor minimal 10 karakter.";
    if (secret.length > 72) return "Kata sandi maksimal 72 karakter.";
    if (!/[A-Za-z]/.test(secret) || !/\d/.test(secret)) return "Kata sandi harus memuat huruf dan angka.";
    if (/^(.)\1+$/.test(secret)) return "Kata sandi tidak boleh karakter yang sama semua.";
    return null;
  }
  if (!/^\d{6,10}$/.test(secret)) return "PIN harus 6-10 angka.";
  if (/^(\d)\1+$/.test(secret)) return "PIN tidak boleh angka yang sama semua.";
  const d = [...secret].map(Number);
  if (d.every((x, i) => i === 0 || x === d[i - 1] + 1) || d.every((x, i) => i === 0 || x === d[i - 1] - 1)) return "PIN tidak boleh berurutan.";
  return null;
}
