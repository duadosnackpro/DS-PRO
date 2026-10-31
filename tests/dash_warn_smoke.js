const fs=require('fs'), src=fs.readFileSync(require('path').join(__dirname,'..','web/js/modules.js'),'utf8'), assert=require('assert');
const cut=(a,b)=>src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
const code = cut('function dashWarnings','function drawDash') + '\n' + cut("  dwarn: () =>", "  hppfix:").replace(/^  dwarn: /,'const H_dwarn = ').replace(/,\n  dwgo: /, ';\nconst H_dwgo = ').replace(/,\s*$/,';');
const dom={wbell:{innerHTML:''}}, calls=[]; let sheetHtml='', closed=0;
const f=new Function('S','A','num','dec','esc','$','sheet','ACT','closeSheet', code+'\nreturn {dashWarnings,drawBell,H_dwarn,H_dwgo};');
const S={}, ACT={tab:el=>calls.push('tab:'+el.dataset.t), hppfix:()=>calls.push('hppfix'), go_settings:()=>calls.push('set')};
const m=f(S,{can:()=>true},n=>String(n),n=>String(n),s=>String(s).replace(/</g,'&lt;'),sel=>dom[sel.slice(1)],h=>{sheetHtml=h},ACT,()=>{closed++});
// data mirip screenshot: 2 peringatan server (hpp + stok), tidak ada stok minus / review
S.dwarn=m.dashWarnings({peringatan:[{teks:'45 baris penjualan periode ini belum punya HPP, jadi laba dan margin terlihat lebih tinggi dari kenyataan.',aksi:'hpp'},{teks:'15 varian yang ada stoknya belum punya HPP. Isi HPP lewat Stok (penyesuaian) supaya penjualan berikutnya punya HPP.',aksi:'stok'}]});
assert.strictEqual(S.dwarn.length,2); m.drawBell();
assert(/wbell/.test(dom.wbell.innerHTML) && /<b>2<\/b>/.test(dom.wbell.innerHTML) && /2 peringatan/.test(dom.wbell.innerHTML),'ikon + angka 2');
m.H_dwarn(); assert(/Peringatan \(2\)/.test(sheetHtml) && /Perbaiki HPP/.test(sheetHtml) && /Buka Stok/.test(sheetHtml) && /belum punya HPP/.test(sheetHtml),'daftar lengkap');
m.H_dwgo({dataset:{i:'1',t:'stok'}}); assert.deepStrictEqual(calls,['tab:stok']); assert.strictEqual(closed,1,'sheet ditutup sebelum aksi');
m.H_dwgo({dataset:{i:'0',t:''}}); assert.deepStrictEqual(calls,['tab:stok','hppfix']);
// tanpa peringatan: ikon hilang; peran tanpa hak manage: tidak ada tombol Perbaiki HPP
S.dwarn=m.dashWarnings({}); m.drawBell(); assert.strictEqual(dom.wbell.innerHTML,'');
const m2=f(S,{can:()=>false},String,String,String,sel=>dom[sel.slice(1)],h=>{sheetHtml=h},ACT,()=>{});
S.dwarn=m2.dashWarnings({peringatan:[{teks:'x',aksi:'hpp'}]}); m2.H_dwarn(); assert(!/Perbaiki HPP/.test(sheetHtml),'tanpa tombol bila tak berhak');
// stok minus + review ikut terkumpul
S.dwarn=m.dashWarnings({stok_minus:[{nama:'Keripik',stok:-3}],review_trx:2,peringatan:[]}); assert.strictEqual(S.dwarn.length,2);
console.log('smoke OK: ikon, angka, daftar, tombol aksi, tutup-sheet, hak akses');
