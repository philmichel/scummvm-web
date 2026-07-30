#!/usr/bin/env python3
"""Merge freshly detected ScummVM targets into a persistent config."""

import argparse
import configparser
import logging
import os
import posixpath
import stat
import tempfile
from collections.abc import Iterable


LOG = logging.getLogger("merge_ini")


def read_config(path: str) -> configparser.ConfigParser:
    parser = configparser.ConfigParser(strict=False, interpolation=None)
    parser.optionxform = str
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as config_file:
            parser.read_file(config_file)
    return parser


def section_values(
    parser: configparser.ConfigParser, section: str
) -> dict[str, str]:
    # ConfigParser.items() includes values inherited from [DEFAULT]. Game domains must
    # contain only their own options.
    return dict(parser._sections[section])


def normalize_mappings(mappings: Iterable[tuple[str, str]]) -> list[tuple[str, str]]:
    normalized = []
    for source, destination in mappings:
        source = posixpath.normpath(source)
        destination = posixpath.normpath(destination)
        if not source.startswith("/") or not destination.startswith("/"):
            raise ValueError("path mappings must use absolute paths")
        normalized.append((source, destination))
    return sorted(normalized, key=lambda mapping: len(mapping[0]), reverse=True)


def mapped_path(path: str, mappings: list[tuple[str, str]]) -> str | None:
    path = posixpath.normpath(path)
    for source, destination in mappings:
        if path == source:
            return destination
        if path.startswith(source + "/"):
            return posixpath.normpath(destination + path[len(source) :])
    return None


def identity(values: dict[str, str], mappings: list[tuple[str, str]]) -> tuple[str, str, str] | None:
    path = values.get("path")
    if path is None:
        return None
    normalized_path = mapped_path(path, mappings) or posixpath.normpath(path)
    return values.get("engineid", ""), values.get("gameid", ""), normalized_path


def atomic_write(parser: configparser.ConfigParser, target_path: str) -> None:
    target_dir = os.path.dirname(os.path.abspath(target_path))
    os.makedirs(target_dir, exist_ok=True)
    existing_mode = None
    try:
        existing_mode = stat.S_IMODE(os.stat(target_path).st_mode)
    except FileNotFoundError:
        pass

    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=target_dir, prefix=".scummvm.ini.", delete=False
        ) as temporary:
            temporary_path = temporary.name
            parser.write(temporary)
            temporary.flush()
            os.fsync(temporary.fileno())
        if existing_mode is not None:
            os.chmod(temporary_path, existing_mode)
        else:
            os.chmod(temporary_path, 0o644)
        os.replace(temporary_path, target_path)
        temporary_path = None
    finally:
        if temporary_path is not None:
            try:
                os.unlink(temporary_path)
            except FileNotFoundError:
                pass


def merge_ini(
    detected_path: str, target_path: str, mappings: Iterable[tuple[str, str]]
) -> int:
    mappings = normalize_mappings(mappings)
    detected = read_config(detected_path)
    target = read_config(target_path)
    changed = False
    added = 0

    if detected.has_section("scummvm") and not target.has_section("scummvm"):
        target.add_section("scummvm")
        for option, value in section_values(detected, "scummvm").items():
            target.set("scummvm", option, value)
        changed = True

    existing_identities = set()
    for section in target.sections():
        if section == "scummvm":
            continue
        section_identity = identity(section_values(target, section), mappings)
        if section_identity is not None:
            existing_identities.add(section_identity)

    for detected_section in detected.sections():
        if detected_section == "scummvm":
            continue
        values = section_values(detected, detected_section)
        original_path = values.get("path")
        rewritten_path = mapped_path(original_path, mappings) if original_path else None
        if rewritten_path is None:
            LOG.warning(
                "Skipping detected target %s: path %r does not match a configured mapping",
                detected_section,
                original_path,
            )
            continue
        values["path"] = rewritten_path
        detected_identity = identity(values, mappings)
        if detected_identity in existing_identities:
            LOG.info("Keeping existing target matching %s", detected_section)
            continue

        target_section = detected_section
        suffix = 1
        while target.has_section(target_section) or target_section == target.default_section:
            target_section = f"{detected_section}-{suffix}"
            suffix += 1
        target.add_section(target_section)
        for option, value in values.items():
            target.set(target_section, option, value)
        existing_identities.add(detected_identity)
        changed = True
        added += 1
        LOG.info("Added detected target %s as %s", detected_section, target_section)

    if changed:
        atomic_write(target, target_path)
    else:
        LOG.info("No configuration changes required")
    return added


def parse_mapping(value: str) -> tuple[str, str]:
    source, separator, destination = value.partition("=")
    if not separator or not source or not destination:
        raise argparse.ArgumentTypeError("mapping must have the form SOURCE=DESTINATION")
    return source, destination


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--detected", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--map", dest="mappings", action="append", type=parse_mapping, required=True)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="[merge_ini] %(levelname)s: %(message)s")
    merge_ini(args.detected, args.target, args.mappings)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
