#!/usr/bin/env python3
"""Server Supabase Storage TIRUAN untuk tests/backup_e2e.sh (hanya dua jalur yang dipakai tools/backup.sh dan tools/restore_foto.js).
   GET  /storage/v1/object/public/<bucket>/<path>   -> isi berkas dari folder akar
   POST /storage/v1/object/<bucket>/<path>          -> simpan berkas (butuh header apikey + Authorization Bearer sama dengan --kunci bila diberikan)
   --rusak : GET mengembalikan isi yang diubah satu byte (menguji deteksi verifikasi sha256 setelah unggah)
Ini BUKAN bukti perilaku Supabase Storage sungguhan."""
import http.server, os, sys, urllib.parse
port = int(sys.argv[1]); root = sys.argv[2]; key = None; rusak = '--rusak' in sys.argv
if '--kunci' in sys.argv: key = sys.argv[sys.argv.index('--kunci') + 1]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _path(self, prefix):
        p = urllib.parse.unquote(self.path.split('?')[0])
        if not p.startswith(prefix): return None
        rel = p[len(prefix):]
        full = os.path.normpath(os.path.join(root, rel))
        return full if full.startswith(os.path.abspath(root)) and '..' not in rel else None
    def do_GET(self):
        f = self._path('/storage/v1/object/public/')
        if not f or not os.path.isfile(f): self.send_response(404); self.end_headers(); return
        b = open(f, 'rb').read()
        if rusak and b: b = bytes([b[0] ^ 1]) + b[1:]
        self.send_response(200); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        if key and (self.headers.get('apikey') != key or self.headers.get('Authorization') != 'Bearer ' + key):
            self.send_response(401); self.end_headers(); return
        f = self._path('/storage/v1/object/')
        n = int(self.headers.get('Content-Length', 0)); b = self.rfile.read(n)
        if not f: self.send_response(400); self.end_headers(); return
        # jalur unggah: /storage/v1/object/<bucket>/<path>; simpan di <root>/<bucket>/<path> agar sama dengan jalur GET publik
        os.makedirs(os.path.dirname(f), exist_ok=True); open(f, 'wb').write(b)
        self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
