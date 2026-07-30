#!/usr/bin/env bash
set -euo pipefail

destination=${1:-/src}
: "${SCUMMVM_DEMO_SHA:?SCUMMVM_DEMO_SHA is required}"
: "${SCUMMVM_SHA:?SCUMMVM_SHA is required}"
: "${SCUMMVM_ICONS_SHA:?SCUMMVM_ICONS_SHA is required}"

fetch_repo() {
    local url=$1
    local revision=$2
    local target=$3

    git init --quiet "$target"
    git -C "$target" remote add origin "$url"
    git -C "$target" fetch --quiet --depth 1 origin "$revision"
    git -C "$target" -c advice.detachedHead=false checkout --quiet FETCH_HEAD
}

mkdir -p "$destination"
fetch_repo https://github.com/chkuendig/scummvm-demo.git "$SCUMMVM_DEMO_SHA" "$destination/scummvm-demo"
fetch_repo https://github.com/chkuendig/scummvm.git "$SCUMMVM_SHA" "$destination/scummvm"
fetch_repo https://github.com/chkuendig/scummvm-icons.git "$SCUMMVM_ICONS_SHA" "$destination/scummvm-icons"

(
    cd "$destination"
    sha256sum --check /workspace/overlay/checksums.sha256
)
cp -a /workspace/overlay/scummvm/. "$destination/scummvm/"

shopt -s nullglob
for patch in /workspace/patches/*.patch; do
    git -C "$destination/scummvm" apply --3way "$patch"
done

for patch in /workspace/patches/scummvm-demo/*.patch; do
    git -C "$destination/scummvm-demo" apply "$patch"
done
