import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).parents[2] / "entrypoint" / "gen_http_index.py"
SPEC = importlib.util.spec_from_file_location("gen_http_index", SCRIPT)
gen_http_index = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(gen_http_index)


class GenerateHttpIndexTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "games"
        self.sidecar = self.root / "indexes"
        self.source.mkdir()

    def read_index(self, relative=""):
        return json.loads((self.sidecar / relative / "index.json").read_text(encoding="utf-8"))

    def test_writes_deterministic_index_for_every_directory(self):
        (self.source / "B").mkdir()
        (self.source / "A").mkdir()
        (self.source / "root.bin").write_bytes(b"12345")
        (self.source / "A" / "game.dat").write_bytes(b"abc")
        (self.source / "B" / "empty").mkdir()

        written = gen_http_index.generate_http_indexes(str(self.source), str(self.sidecar))

        self.assertEqual(written, 4)
        self.assertEqual(self.read_index(), {"A": {}, "B": {}, "root.bin": 5})
        self.assertEqual(self.read_index("A"), {"game.dat": 3})
        self.assertEqual(self.read_index("B"), {"empty": {}})
        self.assertEqual(self.read_index("B/empty"), {})
        root_text = (self.sidecar / "index.json").read_text(encoding="utf-8")
        self.assertLess(root_text.index('"A"'), root_text.index('"B"'))
        self.assertLess(root_text.index('"B"'), root_text.index('"root.bin"'))

    def test_skips_dot_entries_and_symlinks(self):
        (self.source / ".hidden").write_text("hidden", encoding="utf-8")
        (self.source / ".hidden-dir").mkdir()
        (self.source / ".hidden-dir" / "file").write_text("x", encoding="utf-8")
        (self.source / "real").mkdir()
        (self.source / "real" / "file").write_text("x", encoding="utf-8")
        os.symlink(self.source / "real", self.source / "linked-dir")
        os.symlink(self.source / "real" / "file", self.source / "linked-file")

        gen_http_index.generate_http_indexes(str(self.source), str(self.sidecar))

        self.assertEqual(self.read_index(), {"real": {}})
        self.assertEqual(self.read_index("real"), {"file": 1})
        self.assertFalse((self.sidecar / "linked-dir").exists())
        self.assertFalse((self.sidecar / ".hidden-dir").exists())

    def test_missing_source_writes_empty_root_index(self):
        self.source.rmdir()

        written = gen_http_index.generate_http_indexes(str(self.source), str(self.sidecar))

        self.assertEqual(written, 1)
        self.assertEqual(self.read_index(), {})


if __name__ == "__main__":
    unittest.main()
