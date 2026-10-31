// Jalankan: deno test supabase/functions/admin-users/   atau   node --experimental-strip-types --test supabase/functions/admin-users/authz_test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { callerFrom, checkTarget } from "./authz.ts";

const O1 = "11111111-1111-1111-1111-111111111111", O2 = "22222222-2222-2222-2222-222222222222";
const owner = callerFrom([{ role: "owner", outlet_id: null }]);
const adminO1 = callerFrom([{ role: "admin", outlet_id: O1 }]);
const adminGlobal = callerFrom([{ role: "admin", outlet_id: null }]);

test("admin non-owner: id acak/tanpa keanggotaan aktif => 404 (bukan lolos)", () => {
  for (const t of [[], null, undefined]) {
    const v = checkTarget(adminO1, t as never);
    assert.equal(v.ok, false); assert.equal((v as { status: number }).status, 404);
  }
  assert.equal(checkTarget(adminGlobal, []).ok, false);
});
test("owner pun mendapat 404 untuk id tanpa keanggotaan aktif", () => {
  assert.deepEqual(checkTarget(owner, []), { ok: false, status: 404, message: "Pengguna tidak ditemukan." });
});
test("admin outlet boleh mengelola kasir di outletnya sendiri", () => {
  assert.equal(checkTarget(adminO1, [{ role: "kasir", outlet_id: O1 }]).ok, true);
});
test("admin outlet tidak boleh mengelola kasir outlet lain", () => {
  const v = checkTarget(adminO1, [{ role: "kasir", outlet_id: O2 }]);
  assert.equal(v.ok, false); assert.equal((v as { status: number }).status, 403);
});
test("admin non-owner tidak boleh menyentuh owner/admin/auditor", () => {
  for (const role of ["owner", "admin", "auditor"]) {
    const v = checkTarget(adminGlobal, [{ role, outlet_id: O1 }]);
    assert.equal(v.ok, false, role); assert.equal((v as { status: number }).status, 403, role);
  }
});
test("target dengan keanggotaan campur (satu di luar kewenangan) ditolak", () => {
  assert.equal(checkTarget(adminO1, [{ role: "kasir", outlet_id: O1 }, { role: "kasir", outlet_id: O2 }]).ok, false);
});
test("admin global boleh mengelola peran operasional di outlet mana pun", () => {
  assert.equal(checkTarget(adminGlobal, [{ role: "stok", outlet_id: O2 }]).ok, true);
});
test("owner boleh mengelola siapa pun yang punya keanggotaan aktif", () => {
  assert.equal(checkTarget(owner, [{ role: "admin", outlet_id: O1 }]).ok, true);
});

import { corsFor, rateExceeded, allowRoleChangeDespite, RATE_PER_MINUTE } from "./authz.ts";
test("CORS: tanpa ALLOWED_ORIGINS => tidak ada origin yang diizinkan (bukan *)", () => {
  assert.equal("Access-Control-Allow-Origin" in corsFor("https://x.github.io", undefined), false);
  assert.equal("Access-Control-Allow-Origin" in corsFor(null, ""), false);
});
import { originVerdict, pinMinFrom } from "./authz.ts";
test("origin: kosong => ditolak bila ada header Origin; tanpa Origin (server ke server) lolos; origin lain ditolak", () => {
  assert.equal(originVerdict("https://x.github.io", undefined), "not_configured");
  assert.equal(originVerdict("https://x.github.io", " , "), "not_configured");
  assert.equal(originVerdict(null, undefined), "ok");
  assert.equal(originVerdict("https://akun.github.io/", "https://akun.github.io"), "ok");
  assert.equal(originVerdict("https://evil.example", "https://akun.github.io"), "forbidden");
});
test("PIN_MIN_LENGTH: bawaan 8; nilai valid 6-10 diterima; sisanya kembali ke 8", () => {
  assert.equal(pinMinFrom(undefined), 8); assert.equal(pinMinFrom("6"), 6); assert.equal(pinMinFrom("10"), 10);
  for (const v of ["5", "11", "abc", "", "7.5"]) assert.equal(pinMinFrom(v), 8);
});
test("CORS: origin yang diizinkan dipantulkan, yang lain tidak mendapat header allow-origin", () => {
  const allow = "https://akun.github.io, https://staging.example.com/";
  assert.equal(corsFor("https://akun.github.io", allow)["Access-Control-Allow-Origin"], "https://akun.github.io");
  assert.equal(corsFor("https://staging.example.com", allow)["Access-Control-Allow-Origin"], "https://staging.example.com");
  assert.equal("Access-Control-Allow-Origin" in corsFor("https://evil.example", allow), false);
  assert.equal("Access-Control-Allow-Origin" in corsFor(null, allow), false);
  assert.equal(corsFor("https://akun.github.io", allow)["Vary"], "Origin");
});
test("laju: di atas batas ditolak, tepat di batas masih boleh", () => {
  assert.equal(rateExceeded(RATE_PER_MINUTE), false); assert.equal(rateExceeded(RATE_PER_MINUTE + 1), true);
  assert.equal(rateExceeded(null), false); assert.equal(rateExceeded(undefined), false);
});
test("ubah peran: owner boleh memulihkan akun tanpa keanggotaan aktif, admin non-owner tidak", () => {
  const nf = checkTarget(adminO1, []);
  assert.equal(allowRoleChangeDespite(nf, owner, "kasir"), true);
  assert.equal(allowRoleChangeDespite(nf, owner, null), false);
  assert.equal(allowRoleChangeDespite(nf, adminO1, "kasir"), false);
  assert.equal(allowRoleChangeDespite(checkTarget(adminO1, [{ role: "owner", outlet_id: O1 }]), owner, "kasir"), false); // 403 bukan 404
});

import { deactivationProblem, isPrivilegedRole, secretProblem } from "./authz.ts";

test("F5: penonaktifan diri sendiri dan owner terakhir ditolak SEBELUM Auth disentuh (fungsi murni, tanpa efek samping)", () => {
  const ownerM = [{ role: "owner", outlet_id: null }];
  assert.match(deactivationProblem("u1", "u1", ownerM, 3)!, /akun sendiri/);
  assert.match(deactivationProblem("admin1", "u1", ownerM, 0)!, /owner aktif terakhir/);
  assert.equal(deactivationProblem("admin1", "u1", ownerM, 1), null);
  assert.equal(deactivationProblem("admin1", "u2", [{ role: "kasir", outlet_id: O1 }], 0), null);
});

test("F8: Owner/Admin/Auditor wajib kata sandi >= 10 karakter (huruf+angka); peran operasional tetap PIN", () => {
  assert.equal(isPrivilegedRole(["owner"]), true);
  assert.equal(isPrivilegedRole(["kasir", "admin"]), true);
  assert.equal(isPrivilegedRole(["kasir"]), false);
  assert.match(secretProblem("123456", true)!, /minimal 10/);
  assert.match(secretProblem("abcdefghijk", true)!, /huruf dan angka/);
  assert.match(secretProblem("1234567890", true)!, /huruf dan angka/);
  assert.match(secretProblem("aaaaaaaaaa", true)!, /huruf dan angka|sama semua/);
  assert.equal(secretProblem("Dapur-Pedas-2026", true), null);
  assert.equal(secretProblem("kopi7manis9", true), null);
  assert.match(secretProblem("Dapur-Pedas-2026", false)!, /8-10 angka/);
  assert.equal(secretProblem("73915842", false), null);
  assert.match(secretProblem("12345678", false)!, /berurutan/);
  assert.match(secretProblem("11111111", false)!, /sama semua/);
  assert.match(secretProblem("739158", false)!, /8-10 angka/);   // v2.5.2: PIN 6 angka tidak lagi diterima untuk akun baru
  assert.equal(secretProblem("739158", false, 6), null);          // ...kecuali PIN_MIN_LENGTH diturunkan secara sadar
});
