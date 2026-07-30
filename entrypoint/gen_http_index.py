#!/usr/bin/env python3
"""Generate HTTP filesystem index.json files beside a read-only directory tree."""

import argparse
import json
import os
import tempfile


def atomic_write_json(value: object, output_path: str) -> None:
    output_dir = os.path.dirname(output_path)
    os.makedirs(output_dir, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=output_dir, prefix=".index.json.", delete=False
        ) as temporary:
            temporary_path = temporary.name
            json.dump(value, temporary, indent=2, sort_keys=True, ensure_ascii=False)
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


def generate_http_indexes(source_root: str, sidecar_root: str) -> int:
    source_root = os.path.abspath(source_root)
    sidecar_root = os.path.abspath(sidecar_root)
    written = 0

    def traverse(source_dir: str, relative_dir: str) -> None:
        nonlocal written
        entries: dict[str, object] = {}
        child_directories = []
        with os.scandir(source_dir) as scanned:
            for entry in sorted(scanned, key=lambda item: item.name):
                if entry.name.startswith(".") or entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    entries[entry.name] = {}
                    child_directories.append(entry)
                elif entry.is_file(follow_symlinks=False):
                    entries[entry.name] = entry.stat(follow_symlinks=False).st_size
        output_dir = os.path.join(sidecar_root, relative_dir)
        atomic_write_json(entries, os.path.join(output_dir, "index.json"))
        written += 1
        for entry in child_directories:
            traverse(entry.path, os.path.join(relative_dir, entry.name))

    if os.path.isdir(source_root):
        traverse(source_root, "")
    else:
        atomic_write_json({}, os.path.join(sidecar_root, "index.json"))
        written = 1
    return written


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_root")
    parser.add_argument("sidecar_root")
    args = parser.parse_args()
    generate_http_indexes(args.source_root, args.sidecar_root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
