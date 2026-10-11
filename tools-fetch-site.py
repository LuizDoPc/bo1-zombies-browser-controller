#!/usr/bin/env python3
# Mirrors the code side of https://vel.gg/bo1z into site/: pages, scripts, engine (artifacts/), shader seeds, art,
# loading videos and the map manifests, by following every reference from the map pages. The game data packs are a
# separate download (tools-fetch-packs.py, which reads the manifests this writes). Re-run to refresh: files are
# overwritten with the live copies. Usage: tools-fetch-site.py [--base URL] [--out DIR]
import argparse, collections, os, re, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument('--base', default='https://vel.gg/bo1z/')
ap.add_argument('--out', default=os.path.join(HERE, 'site'))
args = ap.parse_args()
BASE = args.base.rstrip('/') + '/'
MAPS = ['five', 'kino', 'riese', 'nacht', 'verruckt', 'shinonuma', 'ascension', 'cotd', 'shangrila', 'moon']

seen, queue = set(), collections.deque()
def add(rel):
    rel = rel.split('#')[0].split('?')[0]
    if not rel or rel.startswith(('data:', 'http:', 'https:', '//', 'blob:', 'mailto:')): return
    rel = rel.lstrip('/')
    if rel.startswith('bo1z/'): rel = rel[5:]
    rel = os.path.normpath(rel)
    if rel.startswith('..') or rel == '.' or '/pack/' in '/' + rel + '/': return  # packs: tools-fetch-packs.py
    if rel not in seen: seen.add(rel); queue.append(rel)

# Names the site's code builds at runtime (artifacts/<scenario>-pipelines.json, per-map art, the engine itself) can't be
# found by following references, so the crawl starts from every non-pack file of the site as of 2026-10-09 (pages by
# their clean URLs). Ones the site no longer has are reported, not fatal.
SEEDS = """
    artifacts/five-pipelines.json artifacts/five-programs.json artifacts/kino-pipelines.json
    artifacts/KisakBlack-web.mjs artifacts/KisakBlack-web.wasm artifacts/zombie_coast-pipelines.json
    artifacts/zombie_cod5_asylum-pipelines.json artifacts/zombie_cod5_factory-pipelines.json
    artifacts/zombie_cod5_prototype-pipelines.json artifacts/zombie_cod5_sumpf-pipelines.json
    artifacts/zombie_cosmodrome-pipelines.json artifacts/zombie_moon-pipelines.json
    artifacts/zombie_temple-pipelines.json art/loadscreen_zombie_coast.webp art/loadscreen_zombie_cod5_asylum.webp
    art/loadscreen_zombie_cod5_factory.webp art/loadscreen_zombie_cod5_prototype.webp
    art/loadscreen_zombie_cod5_sumpf.webp art/loadscreen_zombie_cosmodrome.webp art/loadscreen_zombie_moon.webp
    art/loadscreen_zombie_pentagon.webp art/loadscreen_zombie_temple.webp art/loadscreen_zombie_theater.webp
    art/mapselect-hl-ascension.webp art/mapselect-hl-cotd.webp art/mapselect-hl-five.webp
    art/mapselect-hl-horde-off.webp art/mapselect-hl-horde-on.webp art/mapselect-hl-kino.webp
    art/mapselect-hl-moon.webp art/mapselect-hl-nacht.webp art/mapselect-hl-riese.webp
    art/mapselect-hl-shangrila.webp art/mapselect-hl-shinonuma.webp art/mapselect-hl-verruckt.webp
    art/mapselect-panel-ascension.webp art/mapselect-panel-cotd.webp art/mapselect-panel-five.webp
    art/mapselect-panel-kino.webp art/mapselect-panel-moon.webp art/mapselect-panel-nacht.webp
    art/mapselect-panel-riese.webp art/mapselect-panel-shangrila.webp art/mapselect-panel-shinonuma.webp
    art/mapselect-panel-verruckt.webp art/mapselect-row-ascension.webp art/mapselect-row-cotd.webp
    art/mapselect-row-five.webp art/mapselect-row-horde-off.webp art/mapselect-row-horde-on.webp
    art/mapselect-row-kino.webp art/mapselect-row-moon.webp art/mapselect-row-nacht.webp
    art/mapselect-row-riese.webp art/mapselect-row-shangrila.webp art/mapselect-row-shinonuma.webp
    art/mapselect-row-verruckt.webp art/mapselect-supported.webp art/og-mapselect.png ascension
    ascension/manifest.json audio-worklet.js canvas.js capabilities.js capability-worker.js cotd cotd/manifest.json
    download-worker.js dxs.js engine-download-worker.js engine.js five-horde five horde.js index.html input.js
    kino-horde kino kino/manifest.json landing.js manifest.json maps.js moon moon/manifest.json nacht
    nacht/manifest.json opfs-icase.js opus-worker.js perf-overlay.js play.css play.js riese riese/manifest.json
    robots.txt sha256.js shangrila shangrila/manifest.json shinonuma shinonuma/manifest.json telemetry.js verruckt
    verruckt/manifest.json
""".split()
for p in ['index.html', *MAPS, *[m + '/manifest.json' for m in MAPS[1:]], *SEEDS]:
    add(p)
EXT = r'(?:js|mjs|wasm|json|css|webp|png|jpg|svg|html|webm|mp4|wav|ogg|mp3|txt|data|bin|woff2?|ttf|ico)'
REFS = [re.compile(r'''["'`]((?:\.{0,2}/)?[A-Za-z0-9_\-./]+\.''' + EXT + r''')["'`]'''),
        re.compile(r'''(?:src|href)=["']([^"'#]+)["']'''), re.compile(r'''url\(([^)'"]+)\)''')]

failed = []
while queue:
    rel = queue.popleft()
    try:
        with urllib.request.urlopen(urllib.request.Request(BASE + rel, headers={'User-Agent': 'Mozilla/5.0 (mirror)'}), timeout=120) as r:
            data, ctype = r.read(), r.headers.get('content-type', '')
    except Exception as e:
        failed.append((rel, str(e))); continue
    path = os.path.join(args.out, rel)
    if '.' not in os.path.basename(rel) and 'html' in ctype: path += '.html'  # clean URLs (/bo1z/kino) -> kino.html
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f: f.write(data)
    print(f'{len(data):>10}  {rel}')
    if any(t in ctype for t in ('html', 'javascript', 'css', 'json')) and len(data) < 20_000_000:
        text, d = data.decode('utf-8', 'replace'), os.path.dirname(rel)
        for pat in REFS:
            for m in pat.findall(text):
                add(os.path.join(d, m) if m.startswith(('./', '../')) else m)

# references the crawl guesses from code but the site doesn't have (optional files, string fragments) end up here;
# the engine itself (artifacts/KisakBlack-web.*), the pages and the manifests must not
for rel, err in failed: print(f'     ERROR  {rel}: {err}', file=sys.stderr)
must = ['index.html', 'play.js', 'artifacts/KisakBlack-web.mjs', 'artifacts/KisakBlack-web.wasm', 'manifest.json']
missing = [m for m in must if not os.path.exists(os.path.join(args.out, m))]
print(f'{len(seen) - len(failed)} files in {args.out}, {len(failed)} references not on the site' + (f'; MISSING {missing}' if missing else ''))
sys.exit(1 if missing else 0)
