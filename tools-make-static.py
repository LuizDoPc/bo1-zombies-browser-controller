#!/usr/bin/env python3
# Builds static/, a copy of the archive that any static host can serve (no serve.py):
#   static/...        the site, with the pack files cut into the CDN layout <file>.br/<k> (raw 8 MiB slices) and the
#                     client pointed at them (maps.js packCdn = the same-origin pack root)
#   static/_headers   COOP/COEP for Cloudflare Pages / Netlify (the engine needs cross-origin isolation)
# overlay/ (multiplayer: mp/build.mjs) replaces and adds files; serve.py's engine.js patches are baked in, and the landing links to <map>.html, so no clean-URL routing is needed.
# index.html loses its <base href="/bo1z/">, so the site works at any path (a domain root or a /subdir/ URL that ends
# in a slash). Unchanged files are hard links into site/, so only the pack slices take new space.
# Whole-file pack entries over 8 MiB (common_zombie.ff, 51 MB) get a part list in the copied manifests and are sliced
# too, so no file exceeds Cloudflare Pages' 25 MiB limit (the client uses the part sizes only for its download ETA).
# Run: python3 tools-make-static.py   (rebuilds static/ from scratch)
import json, math, os, shutil, sys
HERE = os.path.dirname(os.path.abspath(__file__))
SITE, OUT = os.path.join(HERE, 'site'), os.path.join(HERE, 'static')
OVERLAY = os.path.join(HERE, 'overlay')  # mp/build.mjs output (multiplayer): replaces/adds files over site/
sys.argv = [sys.argv[0]]  # serve.py reads its flags from argv at import
sys.path.insert(0, HERE)
import serve

SLUGS = ['five', 'kino', 'riese', 'nacht', 'verruckt', 'shinonuma', 'ascension', 'cotd', 'shangrila', 'moon']
# CODE_VERSION: a hash of the engine and co-op code, stamped on their URLs (?v=) so a browser holding older copies
# can't mix them with new ones after an update (an old loader with a new engine doesn't even start).
import hashlib
CODE_VERSION = hashlib.sha1(b''.join(open(f, 'rb').read() for f in [os.path.join(OVERLAY, n) for n in
    ('artifacts/KisakBlack-web.wasm', 'artifacts/KisakBlack-web.mjs', 'net.js', 'coop.js')] + [serve.__file__])).hexdigest()[:10]
V = CODE_VERSION.encode()
STATIC_PATCHES = {
    'engine.js': [(b"await import(BASE + 'artifacts/KisakBlack-web.mjs')", b"await import(BASE + 'artifacts/KisakBlack-web.mjs?v=" + V + b"')"),
                  (b"locateFile: name => BASE + 'artifacts/' + name,", b"locateFile: name => BASE + 'artifacts/' + name + '?v=" + V + b"',"),
                  (b"globalThis.kbCmd = text => import('./net.js')", b"globalThis.kbCmd = text => import('./net.js?v=" + V + b"')"),
                  (b"import('./net.js').then(n => n.attach(module))", b"import('./net.js?v=" + V + b"').then(n => n.attach(module))")],
    'play.js': [(b"import('./coop.js');", b"import('./coop.js?v=" + V + b"');")],
    'coop.js': [(b"import { startLobby } from './net.js';", b"import { startLobby } from './net.js?v=" + V + b"';")],
    # pack bytes from <pack root><file>.br/<k> on this origin (the r2direct path) instead of the Worker's ?part=k
    'maps.js': [(b"export const packCdn = packOrigin ? packOrigin.replace(/\\/+$/, '') + '/packs/' + map.slug + '/' : '';",
                 b"export const packCdn = packBase; // static build (tools-make-static.py): parts are files <path>.br/<k>")],
    # relative URLs need the directory URL to end in "/": /game -> /game/ (most hosts redirect anyway)
    'index.html': [(b'  <base href="/bo1z/">\n',
                    b'  <script>if (!/\\/$|\\.html$/.test(location.pathname)) location.replace(location.pathname + \'/\' + location.search + location.hash);</script>\n')],
    'landing.js': [(b"new URL(entry.href ?? entry.id, import.meta.url)", b"new URL(entry.href ?? entry.id + '.html', import.meta.url)")],
    'five-horde.html': [(b"new URL('five', ", b"new URL('five.html', "), (b"url=five?horde=1", b"url=five.html?horde=1"),
                        (b'href="five?horde=1"', b'href="five.html?horde=1"')],
    'kino-horde.html': [(b"new URL('kino', ", b"new URL('kino.html', "), (b"url=kino?horde=1", b"url=kino.html?horde=1"),
                        (b'href="kino?horde=1"', b'href="kino.html?horde=1"')],
}
HEADERS = """/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin
  Cache-Control: no-cache
"""

def patch_bytes(rel, data):
    for old, new in [(o.encode(), n.encode()) for o, n in serve.PATCHES.get(rel, [])] + STATIC_PATCHES.get(rel, []):
        if data.count(old) != 1: sys.exit(f'patch for {rel} no longer applies: {old[:80]!r}')
        data = data.replace(old, new)
    return data

def sliced():
    """{pack file rel path under site/: (size, part count)} for every file the client fetches as parts, and the
    rewritten manifests {rel: bytes} for whole-file entries that get a part list."""
    out, manifests = {}, {}
    for slug in SLUGS:
        root = '' if slug == 'five' else slug + '/'
        for mp in (root + 'manifest.json', root + 'pack/web-manifest-horde.json'):
            if not os.path.exists(os.path.join(SITE, mp)): continue
            m = json.load(open(os.path.join(SITE, mp)))
            chunk = m['transport']['chunk']; changed = False
            assert chunk == serve.CHUNK, mp
            for e in m['files']:
                if 'opus' in e:
                    fb = e['fallback']
                    out[root + 'pack/' + e['path'] + '.kop'] = (e['opus'], len(e['br']))
                    out[root + 'pack/' + e['path']] = (fb['size'], len(fb['br']))
                elif 'dxs' in e: sys.exit(f'{mp}: dxs entries are not supported ({e["path"]})')
                elif isinstance(e.get('br'), list) and len(e['br']) == math.ceil(e['size'] / chunk):
                    out[root + 'pack/' + e['path']] = (e['size'], len(e['br']))
                elif 'br' not in e and e['size'] > chunk:
                    n = math.ceil(e['size'] / chunk)
                    e['br'] = [min(chunk, e['size'] - k * chunk) for k in range(n)]; changed = True
                    out[root + 'pack/' + e['path']] = (e['size'], n)
            if changed: manifests[mp] = (json.dumps(m, indent=1, ensure_ascii=False) + '\n').encode()
    return out, manifests

def main():
    parts, manifests = sliced()
    if os.path.exists(OUT): shutil.rmtree(OUT)
    os.makedirs(OUT)
    open(os.path.join(OUT, '_headers'), 'w').write(HEADERS)
    patched = set(serve.PATCHES) | set(STATIC_PATCHES) | set(manifests)
    files = slices = 0; slice_bytes = 0
    for dirpath, _, names in os.walk(SITE):
        for name in names:
            src = os.path.join(dirpath, name); rel = os.path.relpath(src, SITE)
            dest = os.path.join(OUT, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            if rel in parts:
                size, n = parts.pop(rel)
                if os.path.getsize(src) != size: sys.exit(f'{rel}: size {os.path.getsize(src)} != manifest {size}')
                os.makedirs(dest + '.br')
                with open(src, 'rb') as f:
                    for k in range(n):
                        data = f.read(serve.CHUNK)
                        open(os.path.join(dest + '.br', str(k)), 'wb').write(data)
                        slices += 1; slice_bytes += len(data)
            elif rel in manifests:
                open(dest, 'wb').write(manifests[rel]); patched.discard(rel)
            elif rel in patched:
                over = os.path.join(OVERLAY, rel)
                open(dest, 'wb').write(patch_bytes(rel, open(over if os.path.isfile(over) else src, 'rb').read()))
                patched.discard(rel)
            elif os.path.isfile(os.path.join(OVERLAY, rel)):
                os.link(os.path.join(OVERLAY, rel), dest)
            else:
                os.link(src, dest)
            files += 1
    # overlay files that site/ doesn't have (net.js)
    for dirpath, _, names in os.walk(OVERLAY):
        for name in names:
            rel = os.path.relpath(os.path.join(dirpath, name), OVERLAY)
            if not os.path.exists(os.path.join(SITE, rel)):
                dest = os.path.join(OUT, rel); os.makedirs(os.path.dirname(dest), exist_ok=True)
                if rel in patched:  # an overlay-only file with patches (coop.js: versioned import)
                    open(dest, 'wb').write(patch_bytes(rel, open(os.path.join(dirpath, name), 'rb').read())); patched.discard(rel)
                else: os.link(os.path.join(dirpath, name), dest)
                files += 1
    if parts: sys.exit(f'pack files missing from site/: {sorted(parts)[:5]}')
    if patched: sys.exit(f'patched files missing from site/: {sorted(patched)}')
    print(f'static/: {files} site files, {slices} part slices ({slice_bytes / 1e9:.2f} GB new)')
    # Precompressed copies for nginx gzip_static (nginx-coop-coep.conf): the shader warm-up lists are 11-26 MB of JSON
    # each (about 15% gzipped), and the renderer gives up waiting for its list after 10 s, so on a slow link a map
    # started with nothing warmed (seconds-long frames while shaders compiled in play). Same for the engine itself.
    import gzip, glob
    gz = 0
    for f in glob.glob(os.path.join(OUT, 'artifacts', '*-pipelines.json')) + glob.glob(os.path.join(OUT, 'artifacts', 'KisakBlack-web.*')):
        if f.endswith('.gz'): continue
        with open(f, 'rb') as src, gzip.open(f + '.gz', 'wb', compresslevel=9) as dst: dst.write(src.read())
        gz += 1
    print(f'static/: {gz} gzip copies for gzip_static')

if __name__ == '__main__':
    main()
