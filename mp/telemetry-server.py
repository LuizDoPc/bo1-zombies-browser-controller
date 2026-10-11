#!/usr/bin/env python3
# telemetry-server.py: collects the game's diagnostics (telemetry.js) on a deployed static copy, the way serve.py does
# locally. nginx forwards /bo1z/telemetry here (see telemetry-setup.txt). No dependencies.
#   GET  /telemetry                 -> {"enabled": true}: the page only sends records when this answers
#   POST /telemetry                 -> appends one JSON record (one line) to the log file
#   GET  /telemetry.jsonl?key=KEY   -> the newest part of the log (the last 8 MB), for whoever has KEY
# Records are capped at 256 KB each; the log rotates at 64 MB (one previous file kept).
#
#   TELEMETRY_KEY=<secret> python3 telemetry-server.py [port] [logfile]     (default 127.0.0.1:8790, ./telemetry.jsonl)
import os, sys, json, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlsplit, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
LOG = sys.argv[2] if len(sys.argv) > 2 else 'telemetry.jsonl'
KEY = os.environ.get('TELEMETRY_KEY', '')
MAX_RECORD, ROTATE, TAIL = 256 * 1024, 64 * 1024 * 1024, 8 * 1024 * 1024
lock = threading.Lock()

class Handler(BaseHTTPRequestHandler):
    def reply(self, code, body=b'', ctype='application/json'):
        self.send_response(code)
        self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store'); self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path.endswith('/telemetry'):
            return self.reply(200, json.dumps({'enabled': True, 'build': 'bo1z-static'}).encode())
        if url.path.endswith('/telemetry.jsonl'):
            if not KEY or parse_qs(url.query).get('key', [''])[0] != KEY: return self.reply(403, b'{"error":"key"}')
            with lock:
                try:
                    with open(LOG, 'rb') as f:
                        f.seek(0, 2); size = f.tell(); f.seek(max(0, size - TAIL)); data = f.read()
                except FileNotFoundError: data = b''
            if len(data) == TAIL: data = data[data.find(b'\n') + 1:]  # start at a whole record
            return self.reply(200, data, 'application/x-ndjson')
        self.reply(404, b'{}')

    def do_POST(self):
        if not urlsplit(self.path).path.endswith('/telemetry'): return self.reply(404, b'{}')
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0 or length > MAX_RECORD: return self.reply(413, b'{}')
        body = self.rfile.read(length)
        try: json.loads(body)
        except ValueError: return self.reply(400, b'{}')
        with lock:
            if os.path.exists(LOG) and os.path.getsize(LOG) > ROTATE: os.replace(LOG, LOG + '.1')
            with open(LOG, 'ab') as f: f.write(body.replace(b'\n', b' ') + b'\n')
        self.reply(204)

    def log_message(self, *args): pass

if __name__ == '__main__':
    if not KEY: print('note: TELEMETRY_KEY is not set, so /telemetry.jsonl stays closed', file=sys.stderr)
    print(f'telemetry collector on 127.0.0.1:{PORT}, writing {os.path.abspath(LOG)}')
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
