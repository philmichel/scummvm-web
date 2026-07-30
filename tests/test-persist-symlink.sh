#!/usr/bin/env bash
set -euo pipefail

fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
chmod 0755 "$fixture"
ln -s /tmp/scummvm-dav-escape "$fixture/escape"

image=${SCUMMVM_IMAGE:-scummvm-web:test}
set +e
output=$(docker run --rm --read-only --tmpfs /tmp:uid=1000,gid=1000,mode=1777 \
    --volume "$fixture:/persist" "$image" nginx -t 2>&1)
status=$?
set -e

if [ "$status" -eq 0 ]; then
    printf '%s\n' "container accepted a symbolic link in /persist" >&2
    exit 1
fi

if [[ "$output" != *'/persist must not contain symbolic links; refusing to start'* ]]; then
    printf '%s\n' "$output" >&2
    printf '%s\n' "container failed for an unexpected reason" >&2
    exit 1
fi
