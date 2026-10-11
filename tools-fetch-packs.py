#!/usr/bin/env python3
# Archives every map pack of https://vel.gg/bo1z into site/<root>pack/<path> as the original (decoded) files.
# Brotli transport parts are fetched from the R2 CDN (which serves them decoded) and concatenated; every file is
# SHA-256-checked against its manifest. Opus entries also keep their .kop container (<path>.kop). Re-run to resume.
import json, os, hashlib, urllib.request, urllib.error, urllib.parse, sys, threading, time
from concurrent.futures import ThreadPoolExecutor, as_completed
SITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'site')
SLUGS = ['five', 'kino', 'riese', 'nacht', 'verruckt', 'shinonuma', 'ascension', 'cotd', 'shangrila', 'moon']
UA = {'User-Agent': 'Mozilla/5.0 (archive)'}
lock = threading.Lock(); done_bytes = 0; t0 = time.time()

def get(url, tries=5):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                return r.read()
        except Exception as e:
            err = e; time.sleep(2 * (i + 1))
    raise RuntimeError(f'{url}: {err}')

def sha_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()

def job(slug, rel, size, sha, nparts, suffix=''):
    """rel: pack path; nparts: brotli part count (None = whole file)."""
    global done_bytes
    root = '' if slug == 'five' else slug + '/'
    dest = os.path.join(SITE, root + 'pack', rel + suffix)
    if os.path.exists(dest) and os.path.getsize(dest) == size and sha_file(dest) == sha:
        with lock: done_bytes += size
        return 'cached', dest
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    q = '/'.join(urllib.parse.quote(p) for p in rel.split('/')) + suffix
    cdn = f'https://cdn.vel.gg/packs/{slug}/{q}'
    tmp = dest + '.part'
    h = hashlib.sha256()
    with open(tmp, 'wb') as f:
        if nparts is None:
            try: data = get(f'{cdn}?v={sha[:16]}')
            except Exception: data = get(f'https://vel.gg/bo1z/{root}pack/{q}')
            f.write(data); h.update(data)
            with lock: done_bytes += len(data)
        else:
            for k in range(nparts):
                data = get(f'{cdn}.br/{k}?v={sha[:16]}')
                f.write(data); h.update(data)
                with lock: done_bytes += len(data)
    got = os.path.getsize(tmp)
    if got != size or h.hexdigest() != sha:
        raise RuntimeError(f'verify failed {dest}: size {got}/{size} sha {h.hexdigest()[:16]}/{sha[:16]}')
    os.replace(tmp, dest)
    return 'ok', dest

def jobs():
    out = {}
    for slug in SLUGS:
        root = '' if slug == 'five' else slug + '/'
        mans = [os.path.join(SITE, root + 'manifest.json'), os.path.join(SITE, root + 'pack/web-manifest-horde.json')]
        for mp in mans:
            if not os.path.exists(mp): continue
            m = json.load(open(mp))
            for e in m['files']:
                br = e.get('br') if isinstance(e.get('br'), list) else None
                if 'opus' in e:
                    fb = e['fallback']
                    out[(slug, e['path'], '.kop')] = (e['opus'], e['sha256'], len(br))
                    out[(slug, e['path'], '')] = (fb['size'], fb['sha256'], len(fb['br']))
                elif 'dxs' in e:
                    out[(slug, e['path'], '.dxs')] = (e['dxs'], None, len(br))  # not used by any current pack
                else:
                    out[(slug, e['path'], '')] = (e['size'], e['sha256'], len(br) if br else None)
            for s in m.get('streams') or []:
                out[(slug, s['path'], '')] = (s['size'], s['sha256'], None)
    return out

def horde_manifests():
    """Hell mode (horde): maps that have it ship an extra pack manifest, pack/web-manifest-horde.json, which the map
    manifests don't list; fetch it first so jobs() includes its files (a 404 means the map has no horde mode)."""
    for slug in SLUGS:
        root = '' if slug == 'five' else slug + '/'
        dest = os.path.join(SITE, root + 'pack', 'web-manifest-horde.json')
        try:
            with urllib.request.urlopen(urllib.request.Request(f'https://cdn.vel.gg/packs/{slug}/web-manifest-horde.json', headers=UA), timeout=60) as r:
                data = r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404: continue
            raise
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, 'wb') as f: f.write(data)

if __name__ == '__main__':
    horde_manifests()
    J = jobs()
    total = sum(v[0] for v in J.values())
    print(f'{len(J)} files, {total/1e9:.2f} GB', flush=True)
    fails = []
    with ThreadPoolExecutor(int(sys.argv[1]) if len(sys.argv) > 1 else 6) as ex:
        futs = {ex.submit(job, s, p, *v, suffix=suf): (s, p, suf) for (s, p, suf), v in J.items()}
        n = 0
        for f in as_completed(futs):
            n += 1
            try: st, d = f.result()
            except Exception as e: fails.append(str(e)); st, d = 'FAIL', str(e)
            el = time.time() - t0
            print(f'[{n}/{len(J)}] {done_bytes/1e9:.2f}/{total/1e9:.2f} GB {done_bytes/1e6/max(el,1):.1f} MB/s {st} {os.path.relpath(d, SITE) if st != "FAIL" else d}', flush=True)
    print('FAILURES:', len(fails)); [print(' ', x) for x in fails]
