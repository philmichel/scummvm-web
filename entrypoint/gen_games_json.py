#!/usr/bin/env python3
"""Generate the browser game catalog from a ScummVM config."""

import argparse
import configparser
import json
import os
import posixpath
import tempfile


def read_config(path: str) -> configparser.ConfigParser:
    parser = configparser.ConfigParser(strict=False, interpolation=None)
    parser.optionxform = str
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as config_file:
            parser.read_file(config_file)
    return parser


def atomic_write_json(value: object, output_path: str) -> None:
    output_dir = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(output_dir, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=output_dir, prefix=".games.json.", delete=False
        ) as temporary:
            temporary_path = temporary.name
            json.dump(value, temporary, indent=2, ensure_ascii=False)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.chmod(temporary_path, 0o644)
        os.replace(temporary_path, output_path)
        temporary_path = None
    finally:
        if temporary_path is not None:
            try:
                os.unlink(temporary_path)
            except FileNotFoundError:
                pass


def generate_games_json(ini_path: str, root: str, output_path: str) -> list[dict[str, object]]:
    config = read_config(ini_path)
    root = posixpath.normpath(root)
    games = []
    for section in config.sections():
        if section == "scummvm":
            continue
        # Reading the raw section avoids inheriting ConfigParser's [DEFAULT] values.
        values = config._sections[section]
        configured_path = values.get("path")
        if configured_path is None:
            continue
        configured_path = posixpath.normpath(configured_path)
        if configured_path != root and not configured_path.startswith(root + "/"):
            continue
        language = values.get("language", "")
        games.append(
            {
                "id": f'{values.get("engineid", "")}:{values.get("gameid", "")}',
                "relative_path": posixpath.relpath(configured_path, root)
                if configured_path != root
                else "",
                "description": values.get("description", ""),
                "download_url": None,
                "languages": [language] if language else [],
                "platform": values.get("platform", ""),
                "featured": False,
            }
        )
    games.sort(key=lambda game: (str(game["description"]), str(game["id"]), str(game["relative_path"])))
    atomic_write_json(games, output_path)
    return games


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ini", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    generate_games_json(args.ini, args.root, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
