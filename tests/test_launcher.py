"""Installer failure cases; optional real runtime smoke test for both OS runners."""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import launcher
import serve


class LauncherTests(unittest.TestCase):
    def test_supported_platforms(self):
        for system, machine, expected in [('Windows', 'AMD64', 'win-x64'),
                                         ('Windows', 'ARM64', 'win-arm64'),
                                         ('Darwin', 'arm64', 'darwin-arm64'),
                                         ('Darwin', 'x86_64', 'darwin-x64')]:
            self.assertEqual(launcher.node_platform(system, machine), expected)
        with self.assertRaises(RuntimeError):
            launcher.node_platform('Windows', 'i386')

    def test_corrupt_download_does_not_replace_working_file(self):
        with tempfile.TemporaryDirectory(prefix='BO1 with spaces ') as folder:
            source, dest = Path(folder) / 'source', Path(folder) / 'dest'
            source.write_bytes(b'incomplete download')
            dest.write_bytes(b'previous working file')
            with patch('launcher.time.sleep'), self.assertRaises(ValueError):
                launcher.download(source.as_uri(), dest, '0' * 64)
            self.assertEqual(dest.read_bytes(), b'previous working file')
            launcher.download(source.as_uri(), dest, hashlib.sha256(source.read_bytes()).hexdigest())
            self.assertEqual(source.read_bytes(), dest.read_bytes())
            self.assertFalse(dest.with_name('dest.part').exists())

    def test_missing_or_truncated_files_require_repair(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(launcher, 'ROOT', Path(folder)):
            pack = Path(folder) / 'pack.bin'
            pack.write_bytes(b'complete')
            self.assertTrue(launcher.inventory_valid({'pack.bin': 8}))
            pack.write_bytes(b'bad')
            self.assertFalse(launcher.inventory_valid({'pack.bin': 8}))
            pack.unlink()
            self.assertFalse(launcher.inventory_valid({'pack.bin': 8}))
            self.assertFalse(launcher.inventory_valid({}))

    def test_nested_engine_patches_use_portable_paths(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            script = root / 'artifacts' / 'test.js'
            script.parent.mkdir()
            script.write_bytes(b'before')
            with patch.object(serve, 'SITE', folder), patch.object(serve, 'OVERLAY', str(root / 'overlay')):
                with patch.object(serve, 'PATCHES', {'artifacts/test.js': [('before', 'after')]}):
                    self.assertEqual(serve.patched(str(script)), b'after')

    def test_windows_absolute_paths_are_not_served(self):
        handler = object.__new__(serve.H)
        self.assertIsNone(handler.resolve('/bo1z/C:/Windows/win.ini'))
        self.assertIsNone(handler.resolve('/bo1z/%5C%5Cserver%5Cfile'))
        self.assertIsNone(handler.resolve('/bo1z/../launcher.py'))

    def test_lock_released_after_failure(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(launcher, 'ROOT', Path(folder)):
            with self.assertRaisesRegex(RuntimeError, 'simulated'):
                with launcher.install_lock():
                    raise RuntimeError('simulated')
            with launcher.install_lock():
                pass

    @unittest.skipUnless(os.environ.get('BO1_TEST_DOWNLOADS'), 'real downloads enabled in CI')
    def test_real_node_in_path_with_spaces(self):
        with tempfile.TemporaryDirectory(prefix='BO1 runtime with spaces ') as folder:
            with patch.object(launcher, 'RUNTIME', Path(folder)):
                node, npm = launcher.ensure_node()
                self.assertEqual(subprocess.check_output([node, '--version'], text=True).strip(),
                                 'v' + launcher.NODE_VERSION)
                self.assertTrue(subprocess.check_output([node, npm, '--version'], text=True).strip())


if __name__ == '__main__':
    unittest.main()
