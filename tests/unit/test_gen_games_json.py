import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).parents[2] / "entrypoint" / "gen_games_json.py"
SPEC = importlib.util.spec_from_file_location("gen_games_json", SCRIPT)
gen_games_json = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(gen_games_json)


class GenerateGamesJsonTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.ini = self.root / "scummvm.ini"
        self.output = self.root / "cache" / "games.json"

    def test_generates_expected_sorted_catalog(self):
        self.ini.write_text(
            "[scummvm]\ntheme=modern\n"
            "[zork]\nengineid=glk\ngameid=zork\npath=/data/games/IF/Zork\n"
            "description=100% Zork\nplatform=dos\nlanguage=en\n"
            "[sky]\nengineid=sky\ngameid=sky\npath=/data/games/Sky\n"
            "description=Beneath a Steel Sky\n"
            "[outside]\npath=/data/games-old/nope\ndescription=Nope\n",
            encoding="utf-8",
        )

        games = gen_games_json.generate_games_json(
            str(self.ini), "/data/games", str(self.output)
        )

        self.assertEqual([game["id"] for game in games], ["glk:zork", "sky:sky"])
        self.assertEqual(games[0]["relative_path"], "IF/Zork")
        self.assertEqual(games[0]["languages"], ["en"])
        self.assertEqual(games[0]["platform"], "dos")
        self.assertIsNone(games[0]["download_url"])
        self.assertFalse(games[0]["featured"])
        self.assertEqual(games[0]["description"], "100% Zork")
        self.assertEqual(games[1]["relative_path"], "Sky")
        self.assertEqual(games[1]["languages"], [])
        self.assertEqual(json.loads(self.output.read_text(encoding="utf-8")), games)

    def test_does_not_inherit_default_path_or_metadata(self):
        self.ini.write_text(
            "[DEFAULT]\npath=/data/games/injected\nlanguage=en\n"
            "[missing-path]\nengineid=test\ngameid=test\n",
            encoding="utf-8",
        )

        games = gen_games_json.generate_games_json(
            str(self.ini), "/data/games", str(self.output)
        )

        self.assertEqual(games, [])
        self.assertEqual(json.loads(self.output.read_text(encoding="utf-8")), [])

    def test_missing_ini_still_writes_empty_catalog(self):
        gen_games_json.generate_games_json(
            str(self.root / "missing.ini"), "/data/games", str(self.output)
        )
        self.assertEqual(json.loads(self.output.read_text(encoding="utf-8")), [])


if __name__ == "__main__":
    unittest.main()
