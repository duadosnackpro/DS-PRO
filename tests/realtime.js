// Uji klien Realtime di sb-adapter.js (tanpa jaringan): WebSocket dan timer palsu. Memeriksa protokol Phoenix, sinyal, detak, pemulihan, dan aksi client.log.
const fs = require('fs'), vm = require('vm'), path = require('path');
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('GAGAL: ' + m); } };
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (expMs, n) => 'h.' + b64({exp: Math.floor(expMs / 1000), sub: 'u1', n: n || 0}) + '.s';
function load(cfg, withWS) {
  const socks = [], timers = [], calls = []; let tid = 0;
  class WS { constructor(url) { this.url = url; this.readyState = 0; this.sent = []; socks.push(this); } send(d) { this.sent.push(JSON.parse(d)); } close() { this.readyState = 3; this.closed = true; }
    open() { this.readyState = 1; this.onopen && this.onopen(); } recv(o) { this.onmessage && this.onmessage({data: JSON.stringify(o)}); } drop() { this.readyState = 3; this.onclose && this.onclose(); } }
  const store = {};
  const ctx = {window: {CONFIG: Object.assign({SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_KEY: 'pk'}, cfg || {})}, console, atob: s => Buffer.from(s, 'base64').toString('binary'), crypto: require('crypto').webcrypto, Date, Math, JSON, encodeURIComponent,
    localStorage: {getItem: k => k in store ? store[k] : null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; }},
    setTimeout: (f, ms) => { const id = ++tid; timers.push({id, f, ms, every: false}); return id; }, clearTimeout: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: (f, ms) => { const id = ++tid; timers.push({id, f, ms, every: true}); return id; }, clearInterval: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    fetch: async (url, opt) => { const body = opt && typeof opt.body === 'string' ? JSON.parse(opt.body) : null; calls.push({url, body}); const r = /rpc_schema_version/.test(url) ? {status: 200, body: {version: '99999999999999', min_client: '0.0.0'}} : {status: 200, body: {ok: true, diterima: 1}}; return {status: r.status, ok: true, json: async () => r.body}; }};
  if (withWS !== false) ctx.WebSocket = WS;
  ctx.window.localStorage = ctx.localStorage; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/js/sb-adapter.js'), 'utf8'), ctx);
  const fire = (every, ms) => { const ts = timers.filter(t => t.every === every && (ms == null || t.ms === ms)); ts.forEach(t => { if (!t.every) timers.splice(timers.indexOf(t), 1); t.f(); }); return ts.length; };
  return {S: ctx.window.SBAPI, socks, timers, calls, store, fire};
}
(async () => {
  const tok = jwt(Date.now() + 3600e3, 1);
  // ---- sambungan dan bergabung ----
  let {S, socks, timers, fire} = load(), sig = [], st = [];
  ok(typeof S.realtime.start === 'function' && S.realtime.state() === 'off', 'API realtime tersedia, awal off');
  S.realtime.start(() => tok, s => sig.push(s), s => st.push(s));
  ok(socks.length === 1 && socks[0].url === 'wss://abc.supabase.co/realtime/v1/websocket?apikey=pk&vsn=1.0.0', 'membuka wss ke host Supabase dengan apikey dan vsn=1.0.0: ' + (socks[0] && socks[0].url));
  ok(S.realtime.state() === 'connecting', 'status connecting');
  socks[0].open();
  const j = socks[0].sent[0];
  ok(j.event === 'phx_join' && j.topic === 'realtime:duado-sync' && j.payload.access_token === tok, 'phx_join memuat topik dan token pengguna (bukan hanya apikey)');
  ok(JSON.stringify(j.payload.config.postgres_changes) === JSON.stringify([{event: 'INSERT', schema: 'public', table: 'sync_events'}]), 'hanya berlangganan INSERT pada public.sync_events (bukan tabel berdata sensitif)');
  ok(timers.some(t => t.every && t.ms === 25000), 'detak 25 detik dijadwalkan');
  socks[0].recv({topic: 'realtime:duado-sync', event: 'phx_reply', ref: j.ref, payload: {status: 'ok', response: {}}});
  ok(S.realtime.state() === 'on' && st.includes('on'), 'status on setelah join ok');
  ok(sig.length === 1 && sig[0].catchup === true, 'tersambung memicu pemeriksaan kejar-ketinggalan (catchup)');
  // ---- sinyal ----
  socks[0].recv({topic: 'realtime:duado-sync', event: 'postgres_changes', payload: {ids: [1], data: {type: 'INSERT', table: 'sync_events', record: {id: 5, kind: 'stock', outlet_id: 'o1'}}}});
  ok(sig.length === 2 && sig[1].kind === 'stock' && sig[1].outlet_id === 'o1', 'sinyal stock diteruskan dengan outlet');
  socks[0].recv({topic: 'realtime:duado-sync', event: 'postgres_changes', payload: {data: {record: {id: 6, kind: 'cat', outlet_id: null}}}});
  ok(sig[2].kind === 'cat' && sig[2].outlet_id === null, 'sinyal cat global (outlet null)');
  socks[0].recv({topic: 'realtime:lain', event: 'postgres_changes', payload: {data: {record: {kind: 'cat'}}}}); socks[0].onmessage({data: 'bukan json'});
  ok(sig.length === 3, 'topik lain dan pesan rusak diabaikan tanpa galat');
  // ---- detak, token, sambungan mati diam-diam ----
  fire(true, 25000);
  ok(socks[0].sent.some(m => m.topic === 'phoenix' && m.event === 'heartbeat'), 'detak dikirim');
  socks[0].recv({topic: 'phoenix', event: 'phx_reply', ref: '9', payload: {status: 'ok'}});
  fire(true, 25000); // detak kedua: yang pertama dibalas
  ok(socks.length === 1, 'detak dibalas => sambungan dipertahankan');
  ok(S.realtime.state() === 'on', 'tetap on');
  fire(true, 25000); // detak ketiga tanpa balasan sebelumnya => anggap mati
  ok(S.realtime.state() === 'retry', 'detak tak dibalas => retry');
  ok(timers.some(t => !t.every), 'percobaan ulang dijadwalkan dengan timer');
  fire(false); // jalankan timer retry
  ok(socks.length === 2, 'sambung ulang membuka WebSocket baru (' + socks.length + ')');
  ok(socks[0].closed === true, 'soket lama ditutup');
  // ---- putus lalu pulih, mundur eksponensial ----
  socks[1].drop();
  ok(S.realtime.state() === 'retry', 'onclose => retry');
  const d1 = timers.filter(t => !t.every).map(t => t.ms)[0]; fire(false);
  socks[2].drop(); const d2 = timers.filter(t => !t.every).map(t => t.ms)[0]; fire(false);
  ok(d1 >= 1500 && d1 <= 7500 && d2 > d1 * 0.9, 'jeda sambung ulang membesar (' + Math.round(d1) + ' → ' + Math.round(d2) + ' ms)');
  const s3 = socks[socks.length - 1]; s3.open();
  s3.recv({topic: 'realtime:duado-sync', event: 'phx_reply', ref: s3.sent[0].ref, payload: {status: 'ok'}});
  ok(S.realtime.state() === 'on', 'pulih setelah join ok');
  // ---- join ditolak server ----
  let t2 = load(); t2.S.realtime.start(() => tok, () => {}, () => {}); t2.socks[0].open();
  t2.socks[0].recv({topic: 'realtime:duado-sync', event: 'phx_reply', ref: t2.socks[0].sent[0].ref, payload: {status: 'error', response: {reason: 'token expired'}}});
  ok(t2.S.realtime.state() === 'retry', 'join ditolak => retry (bukan on)');
  // ---- stop ----
  t2.S.realtime.stop(); t2.fire(false);
  ok(t2.S.realtime.state() === 'off' && t2.socks.length === 1, 'stop: off dan tidak menyambung lagi');
  // ---- token diperbarui dikirim ke server ----
  let t3 = load(), tk = tok; t3.S.realtime.start(() => tk, () => {}, () => {}); t3.socks[0].open();
  t3.socks[0].recv({topic: 'realtime:duado-sync', event: 'phx_reply', ref: t3.socks[0].sent[0].ref, payload: {status: 'ok'}});
  tk = jwt(Date.now() + 7200e3, 2); t3.socks[0].recv({topic: 'phoenix', event: 'phx_reply', ref: '1', payload: {}}); t3.fire(true, 25000);
  ok(t3.socks[0].sent.some(m => m.event === 'access_token' && m.payload.access_token === tk), 'token baru dikirim lewat event access_token');
  // ---- nonaktif ----
  let t4 = load({REALTIME: false}); t4.S.realtime.start(() => tok, () => {}, () => {});
  ok(t4.socks.length === 0 && t4.S.realtime.state() === 'off', 'CONFIG.REALTIME=false: tidak menyambung');
  let t5 = load({}, false); t5.S.realtime.start(() => tok, () => {}, () => {});
  ok(t5.S.realtime.state() === 'off', 'tanpa WebSocket: off, tanpa galat');
  let t6 = load({SUPABASE_KEY: ''}); t6.S.realtime.start(() => tok, () => {}, () => {});
  ok(t6.socks.length === 0, 'adapter tidak aktif (tanpa kunci): tidak menyambung');
  let t7 = load(); t7.S.realtime.start(() => null, () => {}, () => {});
  ok(t7.socks.length === 0, 'tanpa token: tidak menyambung');
  // ---- aksi client.log / client.errors ----
  const t8b = load(); t8b.S.setOutlet('o1');
  await t8b.S.call('client.log', {events: [{kind: 'boot', session_id: 'sess-12345678'}]}, tok);
  const c = t8b.calls.find(x => /rpc_client_error_log/.test(x.url));
  ok(c && c.body.p.events.length === 1 && c.body.p.outlet_id === 'o1', 'client.log => rpc_client_error_log dengan outlet aktif');
  await t8b.S.call('client.errors', {days: 3}, tok);
  ok(t8b.calls.some(x => /rpc_client_error_report/.test(x.url) && x.body.p.days === 3), 'client.errors => rpc_client_error_report');
  console.log(fail ? fail + ' GAGAL, ' + pass + ' lulus' : 'Semua lulus (' + pass + ' pemeriksaan)'); process.exit(fail ? 1 : 0);
})();
