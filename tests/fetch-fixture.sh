#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
fixture_root=$root/fixtures
archive=$fixture_root/BASS-Floppy-1.3.zip
url='https://downloads.scummvm.org/frs/extras/Beneath%20a%20Steel%20Sky/BASS-Floppy-1.3.zip'
checksum=d0bac1bd61747a67e885fa44b78c78887bf2b15d3dfa2790c483fad651078818

game_dir=$fixture_root/games/BASS-Floppy-1.3
mkdir -p "$game_dir" "$fixture_root/persist"
if [[ ! -f "$archive" ]]; then
    curl --fail --location --retry 3 --output "$archive" "$url"
fi
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check
unzip -oq "$archive" -d "$game_dir"
chmod -R a+rX "$game_dir"
ln -sfn /etc/passwd "$fixture_root/games/symlink-escape"
if [[ $(stat -c %u "$fixture_root/persist") == "$(id -u)" ]]; then
    chmod 0777 "$fixture_root/persist"
fi
