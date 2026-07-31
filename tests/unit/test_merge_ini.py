import configparser
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).parents[2] / "entrypoint" / "merge_ini.py"
SPEC = importlib.util.spec_from_file_location("merge_ini", SCRIPT)
merge_ini = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(merge_ini)


def read_raw_config(path):
    parser = configparser.ConfigParser(strict=False, interpolation=None)
    parser.optionxform = str
    parser.read(path)
    return parser


class MergeIniTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.detected = self.root / "detected.ini"
        self.target = self.root / "scummvm.ini"

    def test_merges_targets_maps_paths_and_preserves_case(self):
        self.target.write_text("[scummvm]\nTheme=modern\n", encoding="utf-8")
        self.detected.write_text(
            "[scummvm]\nTheme=detected\n[monkey]\nengineid=scumm\ngameid=monkey\n"
            "path=/games/Lucas/Monkey\nCustomOption=100% KeepMe\n",
            encoding="utf-8",
        )

        added = merge_ini.merge_ini(
            str(self.detected), str(self.target), [("/games", "/data/games")]
        )

        config = read_raw_config(self.target)
        self.assertEqual(added, 1)
        self.assertEqual(dict(config._sections["scummvm"]), {"Theme": "modern"})
        self.assertEqual(config._sections["monkey"]["path"], "/data/games/Lucas/Monkey")
        self.assertEqual(config._sections["monkey"]["CustomOption"], "100% KeepMe")

    def test_duplicate_identity_keeps_user_section_unchanged(self):
        original = (
            "[custom-name]\nengineid=scumm\ngameid=monkey\npath=/data/games/Monkey\n"
            "description=My description\n"
        )
        self.target.write_text(original, encoding="utf-8")
        self.detected.write_text(
            "[monkey]\nengineid=scumm\ngameid=monkey\npath=/games/Monkey/./\n"
            "description=Detector description\n",
            encoding="utf-8",
        )

        added = merge_ini.merge_ini(
            str(self.detected), str(self.target), [("/games", "/data/games")]
        )

        self.assertEqual(added, 0)
        self.assertEqual(self.target.read_text(encoding="utf-8"), original)

    def test_name_collision_gets_first_available_suffix(self):
        self.target.write_text(
            "[game]\nengineid=first\ngameid=first\npath=/data/games/first\n"
            "[game-1]\nengineid=second\ngameid=second\npath=/data/games/second\n",
            encoding="utf-8",
        )
        self.detected.write_text(
            "[game]\nengineid=third\ngameid=third\npath=/games/third\n",
            encoding="utf-8",
        )

        merge_ini.merge_ini(
            str(self.detected), str(self.target), [("/games", "/data/games")]
        )

        self.assertTrue(read_raw_config(self.target).has_section("game-2"))

    def test_unmappable_target_and_defaults_do_not_modify_existing_file(self):
        original = "[scummvm]\npath=/user/value\n"
        self.target.write_text(original, encoding="utf-8")
        self.detected.write_text(
            "[DEFAULT]\nlanguage=en\n[other]\nengineid=x\ngameid=y\npath=/elsewhere/y\n",
            encoding="utf-8",
        )
        before_inode = os.stat(self.target).st_ino

        added = merge_ini.merge_ini(
            str(self.detected), str(self.target), [("/games", "/data/games")]
        )

        self.assertEqual(added, 0)
        self.assertEqual(os.stat(self.target).st_ino, before_inode)
        self.assertEqual(self.target.read_text(encoding="utf-8"), original)

    def test_new_global_does_not_inherit_default_options(self):
        self.detected.write_text(
            "[DEFAULT]\nInjected=value\n[scummvm]\nTheme=modern\n",
            encoding="utf-8",
        )

        merge_ini.merge_ini(
            str(self.detected), str(self.target), [("/games", "/data/games")]
        )

        config = read_raw_config(self.target)
        self.assertEqual(dict(config._sections["scummvm"]), {"Theme": "modern"})
        self.assertEqual(config.defaults(), {})

    def test_duplicate_detected_sections_and_options_use_last_value(self):
        self.detected.write_text(
            "[game]\nengineid=test\ngameid=test\npath=/games/old\n"
            "[game]\npath=/games/new\npath=/games/final\n",
            encoding="utf-8",
        )

        merge_ini.merge_ini(
            str(self.detected), str(self.target), [("/games", "/data/games")]
        )

        config = read_raw_config(self.target)
        self.assertEqual(config._sections["game"]["path"], "/data/games/final")

    def test_copies_of_one_game_get_distinguishing_labels(self):
        self.target.write_text(
            "[monkey]\nengineid=scumm\ngameid=monkey\n"
            "path=/data/games/Monkey Island - Talkie with Midi Music\n"
            "description=The Secret of Monkey Island (DOS/English)\n",
            encoding="utf-8",
        )
        self.detected.write_text(
            "[monkey]\nengineid=scumm\ngameid=monkey\n"
            "path=/games/Monkey Island - Talkie with Special Edition CD Tracks\n"
            "description=The Secret of Monkey Island (DOS/English)\n",
            encoding="utf-8",
        )

        merge_ini.merge_ini(
            str(self.detected), str(self.target), [("/games", "/data/games")]
        )

        config = read_raw_config(self.target)
        self.assertEqual(
            config._sections["monkey"]["description"],
            "The Secret of Monkey Island (DOS/English) [Midi Music]",
        )
        self.assertEqual(
            config._sections["monkey-1"]["description"],
            "The Secret of Monkey Island (DOS/English) [Special Edition CD Tracks]",
        )

    def test_labelling_is_idempotent_and_extends_to_later_copies(self):
        self.target.write_text(
            "[game]\nengineid=e\ngameid=g\npath=/data/games/One\ndescription=Game [One]\n"
            "[game-1]\nengineid=e\ngameid=g\npath=/data/games/Two\ndescription=Game [Two]\n",
            encoding="utf-8",
        )
        self.detected.write_text(
            "[game]\nengineid=e\ngameid=g\npath=/games/Three\ndescription=Game\n",
            encoding="utf-8",
        )

        merge_ini.merge_ini(
            str(self.detected), str(self.target), [("/games", "/data/games")]
        )
        before = self.target.read_text(encoding="utf-8")
        merge_ini.merge_ini(
            str(self.detected), str(self.target), [("/games", "/data/games")]
        )

        config = read_raw_config(self.target)
        self.assertEqual(config._sections["game"]["description"], "Game [One]")
        self.assertEqual(config._sections["game-1"]["description"], "Game [Two]")
        self.assertEqual(config._sections["game-2"]["description"], "Game [Three]")
        self.assertEqual(self.target.read_text(encoding="utf-8"), before)

    def test_letterless_remainder_falls_back_to_full_paths(self):
        # Matches the smoke fixture: trimming the shared head would label the first
        # copy "3", which says nothing on its own.
        self.target.write_text(
            "[sky]\nengineid=sky\ngameid=sky\n"
            "path=/data/games/BASS-Floppy-1.3\ndescription=Steel Sky\n",
            encoding="utf-8",
        )
        self.detected.write_text(
            "[sky]\nengineid=sky\ngameid=sky\n"
            "path=/games/BASS-Floppy-1.3-second-copy\ndescription=Steel Sky\n",
            encoding="utf-8",
        )

        merge_ini.merge_ini(
            str(self.detected), str(self.target), [("/games", "/data/games")]
        )

        config = read_raw_config(self.target)
        self.assertEqual(config._sections["sky"]["description"], "Steel Sky [BASS-Floppy-1.3]")
        self.assertEqual(
            config._sections["sky-1"]["description"],
            "Steel Sky [BASS-Floppy-1.3-second-copy]",
        )

    def test_distinct_descriptions_are_left_alone(self):
        original = (
            "[a]\nengineid=e\ngameid=g\npath=/data/games/A\ndescription=Alpha\n"
            "[b]\nengineid=e\ngameid=h\npath=/data/games/B\ndescription=Beta\n"
        )
        self.target.write_text(original, encoding="utf-8")
        self.detected.write_text("", encoding="utf-8")

        merge_ini.merge_ini(
            str(self.detected), str(self.target), [("/games", "/data/games")]
        )

        self.assertEqual(self.target.read_text(encoding="utf-8"), original)


if __name__ == "__main__":
    unittest.main()
