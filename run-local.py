#!/usr/bin/env python3
"""Serve the local BO1 browser build on this computer only."""
from http.server import ThreadingHTTPServer
from serve import H, SITE

if __name__ == '__main__':
    print(f'BO1 local: http://localhost:8000/bo1z/kino\nFiles: {SITE}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 8000), H).serve_forever()
