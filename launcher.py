"""One-command, project-local setup and launcher for macOS and Windows."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request
import webbrowser
import zipfile

ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / '.runtime'
STATE = ROOT / '.install-state.json'
NODE_VERSION = '24.20.0'
NODE_HASHES = {
    'darwin-arm64': '40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8',
    'darwin-x64': '9e5b2644cf107befb6aefca676b96d3296bc10138096f022ed378d6233ed81f4',
    'win-arm64': '31c6799744de8a54601643098040c68c3697e56c94e407d61d0e5fa5f34191d7',
    'win-x64': '6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba',
}


def say(message):
    print(message, flush=True)


def sha(path):
    with Path(path).open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def download(url, dest, digest=None):
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + '.part')
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'BO1-local-launcher/1'})
            with urllib.request.urlopen(request, timeout=90) as response, tmp.open('wb') as file:
                shutil.copyfileobj(response, file)
            if digest and sha(tmp) != digest:
                raise ValueError('O download falhou na verificacao de integridade.')
            tmp.replace(dest)
            return
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def node_platform(system=None, machine=None):
    system, machine = system or platform.system(), (machine or platform.machine()).lower()
    os_name = {'Darwin': 'darwin', 'Windows': 'win'}.get(system)
    arch = {'arm64': 'arm64', 'aarch64': 'arm64', 'amd64': 'x64', 'x86_64': 'x64'}.get(machine)
    key = f'{os_name}-{arch}'
    if key not in NODE_HASHES:
        raise RuntimeError('Este iniciador oferece suporte a macOS e Windows de 64 bits.')
    return key


def ensure_node():
    target = node_platform()
    name = f'node-v{NODE_VERSION}-{target}'
    folder = RUNTIME / name
    node = folder / ('node.exe' if target.startswith('win-') else 'bin/node')
    npm = folder / ('node_modules/npm/bin/npm-cli.js' if target.startswith('win-') else 'lib/node_modules/npm/bin/npm-cli.js')
    if not node.exists() or not npm.exists():
        say('Preparando os componentes do jogo (somente na primeira vez)...')
        extension = 'zip' if target.startswith('win-') else 'tar.gz'
        archive = RUNTIME / f'{name}.{extension}'
        download(f'https://nodejs.org/dist/v{NODE_VERSION}/{archive.name}', archive, NODE_HASHES[target])
        if extension == 'zip':
            with zipfile.ZipFile(archive) as z:
                z.extractall(RUNTIME)
        else:
            with tarfile.open(archive) as t:
                t.extractall(RUNTIME, filter='data')
        archive.unlink()
    return node, npm


def run_logged(args, env=None, cwd=ROOT):
    with (ROOT / 'installation.log').open('ab') as log:
        result = subprocess.run([str(x) for x in args], cwd=cwd, env=env, stdout=log, stderr=log)
    if result.returncode:
        raise RuntimeError('A preparacao parou. Os detalhes estao em installation.log. Abra o iniciador novamente para tentar continuar.')


def load_packs():
    spec = importlib.util.spec_from_file_location('pack_download', ROOT / 'tools-fetch-packs.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.SLUGS = ['kino']
    return module


def inventory_valid(entries):
    if not entries:
        return False
    for name, size in entries.items():
        p = ROOT / name
        if not p.is_file() or p.stat().st_size != size:
            return False
    return True


def build_fingerprint():
    h = hashlib.sha256()
    paths = [p for p in (ROOT / 'mp').rglob('*') if p.is_file() and 'node_modules' not in p.parts]
    paths += [ROOT / 'site/artifacts/KisakBlack-web.mjs', ROOT / 'site/artifacts/KisakBlack-web.wasm']
    for p in sorted(paths):
        h.update(p.relative_to(ROOT).as_posix().encode())
        h.update(p.read_bytes())
    return h.hexdigest()


def prepare(repair=False):
    RUNTIME.mkdir(exist_ok=True)
    try:
        state = json.loads(STATE.read_text())
    except (OSError, ValueError):
        state = {}
    needed = ['index.html', 'kino.html', 'kino/manifest.json', 'play.js', 'engine.js', 'maps.js',
              'input.js', 'engine-download-worker.js', 'download-worker.js', 'capabilities.js',
              'artifacts/KisakBlack-web.mjs', 'artifacts/KisakBlack-web.wasm']
    if repair or any(not (ROOT / 'site' / p).is_file() for p in needed):
        if shutil.disk_usage(ROOT).free < 3 * 1024**3:
            raise RuntimeError('Libere pelo menos 3 GB nesta unidade antes de instalar.')
        say('1/3 Baixando o motor. Isso pode levar alguns minutos...')
        run_logged([sys.executable, '-u', ROOT / 'tools-fetch-site.py'])
        # Never reuse a completed pack inventory after refreshing the manifests.
        state = {}
    if repair or not inventory_valid(state.get('packs')):
        say('2/3 Preparando Kino der Toten. Downloads concluidos serao aproveitados...')
        packs = load_packs()
        if repair or not (ROOT / 'site/kino/pack/web-manifest-horde.json').exists():
            packs.horde_manifests()
        jobs = packs.jobs()
        if not jobs:
            raise RuntimeError('O pacote de Kino nao foi encontrado. Tente novamente com --repair.')
        total = sum(v[0] for v in jobs.values())
        say(f'Pacote: {total / 1e9:.2f} GB. Mantenha esta janela aberta.')
        entries, errors = {}, []
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {pool.submit(packs.job, slug, name, *values, suffix=suffix): (slug, name, suffix)
                       for (slug, name, suffix), values in jobs.items()}
            for n, f in enumerate(as_completed(futures), 1):
                try:
                    _, dest = f.result()
                    p = Path(dest)
                    entries[p.relative_to(ROOT).as_posix()] = p.stat().st_size
                except Exception as e:
                    errors.append(str(e))
                if n % 8 == 0 or n == len(futures):
                    say(f'  {n}/{len(futures)} arquivos verificados')
        if errors:
            with (ROOT / 'installation.log').open('a') as log:
                log.write('\n'.join(errors) + '\n')
            raise RuntimeError('Alguns arquivos nao terminaram de baixar. Confira a internet e abra o iniciador novamente; o download sera retomado.')
        state['packs'] = entries
    fingerprint = build_fingerprint()
    if repair or state.get('build') != fingerprint or not inventory_valid(state.get('outputs')):
        say('3/3 Preparando controle e cooperativo...')
        node, npm = ensure_node()
        env = dict(os.environ, PATH=str(node.parent) + os.pathsep + os.environ.get('PATH', ''))
        run_logged([node, npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], env, ROOT / 'mp')
        run_logged([node, ROOT / 'mp/build.mjs'], env)
        state['build'] = build_fingerprint()
        state['outputs'] = {p.relative_to(ROOT).as_posix(): p.stat().st_size
                            for p in (ROOT / 'overlay').rglob('*') if p.is_file()}
    state['version'] = 1
    tmp = STATE.with_suffix('.tmp')
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(STATE)
    say('Tudo pronto!')


@contextmanager
def install_lock():
    # An OS lock is released on a crash; no stale PID file to strand the user.
    with (ROOT / '.launcher.lock').open('a+b') as file:
        file.seek(0)
        if os.name == 'nt':
            import msvcrt
            if not file.read(1):
                file.write(b'0'); file.flush()
            file.seek(0)
            try:
                msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                raise RuntimeError('O jogo ja esta sendo preparado em outra janela. Aguarde essa janela terminar.')
        else:
            import fcntl
            try:
                fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                raise RuntimeError('O jogo ja esta sendo preparado em outra janela. Aguarde essa janela terminar.')
        try:
            yield
        finally:
            if os.name == 'nt':
                file.seek(0); msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)


def installation_id():
    return hashlib.sha256(str(ROOT).encode()).hexdigest()[:16]


def find_running():
    for port in range(8000, 8010):
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/local-status', timeout=.2) as r:
                data = json.load(r)
                if data.get('app') == 'bo1-local' and data.get('installation') == installation_id():
                    return port
        except (OSError, ValueError):
            pass
    return None


def open_browser(url):
    candidates = []
    if sys.platform == 'darwin':
        candidates = [Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
                      Path.home() / 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                      Path('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')]
    elif os.name == 'nt':
        for base in ('PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'):
            if os.environ.get(base):
                candidates.extend(Path(os.environ[base]) / p for p in
                                  ('Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe'))
    for browser in candidates:
        if browser.exists():
            subprocess.Popen([str(browser), url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
    say('Use Chrome ou Edge para jogar. Abrindo o navegador padrao...')
    webbrowser.open(url)


def serve(open_tab=True):
    from http.server import ThreadingHTTPServer
    from serve import H

    class LocalHandler(H):
        def do_GET(self, head=False):
            route = self.path.split('?')[0]
            if route == '/local-status':
                content = json.dumps({'app': 'bo1-local', 'installation': installation_id()}).encode()
                ctype = 'application/json'
            elif route in ('/jogar', '/jogar/'):
                content = (ROOT / 'local-menu.html').read_bytes()
                ctype = 'text/html; charset=utf-8'
            else:
                return super().do_GET(head=head)
            self.send_response(200)
            self.headers_common(ctype, len(content))
            self.end_headers()
            if not head:
                self.wfile.write(content)

        def log_message(self, fmt, *args):
            if len(args) > 1 and str(args[1]).startswith('5'):
                super().log_message(fmt, *args)

    server = None
    for port in range(8000, 8010):
        try:
            server = ThreadingHTTPServer(('127.0.0.1', port), LocalHandler)
            break
        except OSError as e:
            if e.errno not in (48, 98, 10048):
                raise
    if server is None:
        raise RuntimeError('As portas do jogo estao ocupadas. Feche outra instancia e tente novamente.')
    url = f'http://localhost:{port}/jogar'
    say(f'Jogo aberto: {url}\nMantenha esta janela aberta. Para encerrar: Ctrl+C.')
    if open_tab:
        threading.Timer(.4, open_browser, args=(url,)).start()
    try:
        server.serve_forever()
    finally:
        server.server_close()


def main():
    parser = argparse.ArgumentParser(description='BO1 Zombies: preparar e jogar.')
    parser.add_argument('--repair', action='store_true', help='baixar e verificar novamente os arquivos')
    parser.add_argument('--setup-only', action='store_true', help='apenas preparar a instalacao')
    parser.add_argument('--no-browser', action='store_true', help='nao abrir uma nova aba')
    args = parser.parse_args()
    os.chdir(ROOT)
    say('BO1 Zombies — pronto para jogar\n')
    if not args.setup_only:
        port = find_running()
        if port:
            if args.repair:
                raise RuntimeError('Encerre a janela do jogo antes de reparar a instalacao.')
            url = f'http://localhost:{port}/jogar'
            say('O jogo ja esta aberto: ' + url)
            if not args.no_browser:
                open_browser(url)
            return
    with install_lock():
        prepare(args.repair)
        if not args.setup_only:
            serve(not args.no_browser)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        say('\nJogo encerrado. Ate a proxima!')
    except Exception as error:
        say('\nNao foi possivel iniciar: ' + str(error))
        sys.exit(1)
