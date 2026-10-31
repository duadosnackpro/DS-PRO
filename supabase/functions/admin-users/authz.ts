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

// CORS (v2.5.2): ALLOWED_ORIGINS (daftar dipisah koma, mis. https://akun.github.io) WAJIB diisi. Bila kosong, tidak ada origin browser yang diizinkan
// (tanpa header Access-Control-Allow-Origin) dan index.ts menolak permintaan ber-Origin dengan 403. Sebelumnya kosong = "*".
// Permintaan tanpa header Origin (bukan dari browser) tidak terkena pembatasan ini; kewenangan sebenarnya tetap JWT + pemeriksaan peran.
export function parseOrigins(allowed: string | undefined): string[] {
  return (allowed ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
}
export function corsFor(origin: string | null, allowed: string | undefined): Record<string, string> {
  const base = { "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
  const o = (origin ?? "").replace(/\/$/, "");
  return o && parseOrigins(allowed).includes(o) ? { ...base, "Access-Control-Allow-Origin": o } : base;
}
export function originVerdict(origin: string | null, allowed: string | undefined): "ok" | "not_configured" | "forbidden" {
  if (!origin) return "ok";
  const list = parseOrigins(allowed);
  if (!list.length) return "not_configured";
  return list.includes(origin.replace(/\/$/, "")) ? "ok" : "forbidden";
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
// Owner/Admin/Auditor memegang akses luas: kata sandi minimal 10 karakter (huruf dan angka), bukan PIN. Peran operasional memakai PIN angka;
// v2.5.2: minimal 8 angka (bawaan) sebagai kompensasi bila hook penguncian akun tidak tersedia di paket Supabase. Dapat diubah lewat secret PIN_MIN_LENGTH (6-10).
export const PIN_MIN_DEFAULT = 8;
export function pinMinFrom(v: string | undefined | null): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 6 && n <= 10 ? n : PIN_MIN_DEFAULT;
}
export const PRIVILEGED_ROLES = ["owner", "admin", "auditor"];
export const isPrivilegedRole = (roles: string[]): boolean => roles.some((r) => PRIVILEGED_ROLES.includes(r));

export function secretProblem(secret: string, privileged: boolean, pinMin: number = PIN_MIN_DEFAULT): string | null {
  if (privileged) {
    if (secret.length < 10) return "Kata sandi Owner/Admin/Auditor minimal 10 karakter.";
    if (secret.length > 72) return "Kata sandi maksimal 72 karakter.";
    if (!/[A-Za-z]/.test(secret) || !/\d/.test(secret)) return "Kata sandi harus memuat huruf dan angka.";
    if (/^(.)\1+$/.test(secret)) return "Kata sandi tidak boleh karakter yang sama semua.";
    return null;
  }
  if (!new RegExp(`^\\d{${pinMin},10}$`).test(secret)) return `PIN harus ${pinMin}-10 angka.`;
  if (/^(\d)\1+$/.test(secret)) return "PIN tidak boleh angka yang sama semua.";
  const d = [...secret].map(Number);
  if (d.every((x, i) => i === 0 || x === d[i - 1] + 1) || d.every((x, i) => i === 0 || x === d[i - 1] - 1)) return "PIN tidak boleh berurutan.";
  return null;
}
