#!/usr/bin/env python3
"""Membuat money.json: vektor uji uang yang dipakai BERSAMA oleh tes JS (tests/vectors_money.js) dan tes SQL (supabase/tests/012_money_vectors.test.sql).
Nilai harapan dihitung di sini dengan Decimal (presisi 50 digit, pembulatan setengah naik), TERPISAH dari kode JS dan SQL, jadi bukan hitungan melingkar.
Jalankan ulang bila menambah kasus:  python3 tests/vectors/generate_money_vectors.py"""
import json, os
from decimal import Decimal as D, getcontext, ROUND_HALF_UP
getcontext().prec = 50
def q(x, places): return x.quantize(D(1).scaleb(-places), rounding=ROUND_HALF_UP)
def s(x): return format(x, 'f')

def alloc(items, ship, alokasi=True):
    items = [(D(a), D(b)) for a, b in items]; ship = D(ship)
    total_h = sum(a * b for a, b in items)
    eff = []
    for a, b in items:
        e = b + (ship * (a * b / total_h) / a if alokasi and total_h > 0 else 0)
        eff.append(q(e, 4))
    sub = q(total_h, 2)
    return {'eff': [s(e) for e in eff], 'subtotal': s(sub), 'total': s(q(total_h + ship, 2)),
            'jumlah_biaya': s(sum(a * e for (a, _), e in zip(items, eff)))}

PA = [
  ('dua bahan, ongkir dialokasikan', [('3', '5000'), ('7', '3000')], '10000', True),
  ('satu bahan, tanpa ongkir', [('2.5', '5200')], '0', True),
  ('ongkir tidak dialokasikan', [('1', '3100')], '700', False),
  ('qty dan harga 4 desimal, ongkir tidak habis dibagi', [('0.3333', '7777.7777'), ('2.1111', '4444.4444'), ('5', '999.9999')], '1234', True),
  ('ongkir kecil untuk qty besar', [('25', '12000'), ('0.5', '45000')], '1', True),
  ('tiga bahan, pecahan umum', [('0.3', '8000'), ('1.7', '2500'), ('12', '1333.33')], '5555', True),
]
purchase_alloc = [{'nama': n, 'ongkir': sh, 'alokasi': al, 'items': [{'qty': a, 'harga': b} for a, b in it], 'expect': alloc(it, sh, al)} for n, it, sh, al in PA]

def avg_seq(buys):
    qty = D(0); avg = D(0)
    for a, b in buys:
        a = D(a); b = q(D(b), 4)          # tanpa ongkir: biaya efektif = harga, 4 desimal
        pos = max(qty, D(0)); avg = q((pos * avg + a * b) / (pos + a), 4) if qty != 0 or avg != 0 else b; qty = q(qty + a, 4)
    return {'qty': s(qty), 'avg': s(avg)}
AV = [
  ('dua pembelian harga berbeda', [('3', '5000'), ('2.5', '5200')]),
  ('tiga pembelian, hasil bukan bilangan bulat', [('10', '3333.3333'), ('7', '4100'), ('0.3333', '9999.9999')]),
]
avg_cost = [{'nama': n, 'pembelian': [{'qty': a, 'harga': b} for a, b in bs], 'expect': avg_seq(bs)} for n, bs in AV]

def prod(bahan, batch, qty, tk, oh):
    b = D(batch); bah = D(0); kem = D(0)
    for m in bahan:
        c = D(m['per_batch']) * b * D(m['avg'])
        if m['tipe'] == 'kemasan': kem += c
        else: bah += c
    total = q(bah + kem + D(tk) + D(oh), 2)
    return {'bahan': s(q(bah, 2)), 'kemasan': s(q(kem, 2)), 'total': s(total), 'unit': s(q(total / D(qty), 4))}
PR = [
  ('dua bahan, hasil aktual berbeda dari standar', [{'avg': '5000', 'tipe': 'bahan', 'per_batch': '1'}, {'avg': '3000', 'tipe': 'bahan', 'per_batch': '0.5'}], '2', '19', '1234.56', '789.01'),
  ('bahan dan kemasan, pecahan', [{'avg': '4444.4444', 'tipe': 'bahan', 'per_batch': '0.3333'}, {'avg': '350.5', 'tipe': 'kemasan', 'per_batch': '12'}], '3', '33', '0', '1000'),
  ('hasil aktual 7, total tidak habis dibagi', [{'avg': '12345.6789', 'tipe': 'bahan', 'per_batch': '0.7'}], '1', '7', '500', '0'),
]
production = []
for n, bh, ba, qh, tk, oh in PR:
    production.append({'nama': n, 'bahan': bh, 'batch': ba, 'qty_hasil': qh, 'tk': tk, 'oh': oh, 'expect': prod(bh, ba, qh, tk, oh)})

# Markup (kebutuhan Fase 4): harga channel = dasar x (1 + persen/100), dibulatkan ke rupiah utuh terdekat (setengah naik). Hanya implementasi JS.
MK = [('12345', '15'), ('10000', '10'), ('9999', '12.5'), ('15000', '0'), ('1', '33.3333'), ('27500', '7.5')]
markup = [{'dasar': a, 'persen': p, 'expect': s(q(D(a) * (1 + D(p) / 100), 0))} for a, p in MK]

out = {'versi': 1, 'catatan': 'Dibuat oleh generate_money_vectors.py. Jangan diedit tangan.', 'purchase_alloc': purchase_alloc, 'avg_cost': avg_cost,
       'production': production, 'markup': markup, 'impl_markup': ['js'], 'toleransi': {'produksi_total': '0.005', 'unit_4dp': '0.00005'}}
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'money.json')
json.dump(out, open(p, 'w'), indent=1, ensure_ascii=False); print('ditulis', p, len(purchase_alloc), 'alokasi', len(avg_cost), 'rata-rata', len(production), 'produksi', len(markup), 'markup')
