# scummvm-web

Self-hosted browser build of [ScummVM](https://www.scummvm.org/) packaged as a
single container. Games are read from a mounted directory; configuration,
savegames, and extras such as MT-32 ROMs are stored on a second writable mount.

The image builds the WebAssembly app from pinned
[`chkuendig/scummvm-demo`](https://github.com/chkuendig/scummvm-demo),
[`chkuendig/scummvm`](https://github.com/chkuendig/scummvm), and
[`chkuendig/scummvm-icons`](https://github.com/chkuendig/scummvm-icons) source.
Cloud storage and Sentry integration are not included.

## Run

The container listens on port 8080 and runs as UID/GID 1000. The games mount is
read-only; all game directories and files must be readable by 1000. The
persistence mount must be writable by 1000. Symbolic links under the games
mount are unsupported: indexing skips them and nginx refuses to serve them.

```bash
mkdir -p ./games ./persist
sudo chown 1000:1000 ./persist

docker run --rm --read-only \
  --publish 8080:8080 \
  --mount type=bind,src="$PWD/games",dst=/games,readonly \
  --mount type=bind,src="$PWD/persist",dst=/persist \
  --mount type=volume,src=scummvm-cache,dst=/var/cache/scummvm \
  --tmpfs /tmp:uid=1000,gid=1000,mode=1777 \
  ghcr.io/philmichel/scummvm-web:latest
```

Open <http://localhost:8080>. The image detects games recursively at startup,
merges newly detected targets into `/persist/scummvm.ini`, and generates the
overview catalog and HTTP filesystem indexes. Existing targets and user edits
are never removed or overwritten.

Set `SCUMMVM_SKIP_DETECTION=1` to skip startup detection. `DETECT_TIMEOUT`
controls its timeout in seconds and defaults to 600.

The running WebAssembly build can also rescan its mounted game tree:

```text
http://localhost:8080/scummvm.html#--add --path=/data/games --recursive
```

Reload after the command exits.

## Persistent Data

The browser mounts `/home/web_user` from the container's same-origin WebDAV
endpoint. Its contents map directly to the persistence volume:

| Host path | ScummVM path | Purpose |
| --- | --- | --- |
| `/persist/scummvm.ini` | `/home/web_user/scummvm.ini` | Global settings and game targets |
| `/persist/saves/` | `/home/web_user/saves/` | Savegames |
| `/persist/extras/` | `/home/web_user/extras/` | MT-32 ROMs and other extras |

MT-32 ROM names are case-sensitive. Place `MT32_CONTROL.ROM` and
`MT32_PCM.ROM` (or the corresponding `CM32L_*.ROM` files) in
`/persist/extras/`.

Persistence is last-write-wins across simultaneous tabs, browsers, or devices.
Normal file closes are uploaded immediately. Browser shutdown delivery is only
best effort, so avoid editing settings concurrently in multiple sessions.
Failure to load the authoritative persistence tree stops browser startup rather
than silently running on an ephemeral filesystem. Runtime upload failures are
shown to the user and retried.

DAVFS persists creation, writable-stream close, memory-map synchronization,
rename, and deletion operations. A standalone Emscripten `FS.truncate()` call
that is not followed by a writable stream close is not synchronized.

The `/persist/` endpoint permits destructive WebDAV operations. Protect the
site with authentication at a reverse proxy or with a trusted network boundary.
The container refuses to start if the persistence tree contains symbolic links,
which prevents WebDAV operations from escaping the mounted directory.

## Build

Docker build arguments are kept in `versions.env`:

```bash
set -a
. ./versions.env
set +a

docker build \
  --build-arg SCUMMVM_DEMO_SHA \
  --build-arg SCUMMVM_SHA \
  --build-arg SCUMMVM_ICONS_SHA \
  --build-arg EMSDK_VERSION \
  --tag scummvm-web:local .
```

A cold build downloads Emscripten and third-party codec libraries and can take
more than 30 minutes. BuildKit caches the toolchain layers independently from
the final ScummVM compilation.

## Source Updates

The daily upstream workflow reads the ScummVM and icon gitlinks from
`scummvm-demo/main` and opens a pull request when they change. CI rebuilds the
full image and runs browser smoke tests on the generated branch before the
workflow merges it. The bot then explicitly dispatches the main-branch publish
workflow. The DAVFS overlay is guarded by the SHA-256 of the original upstream
file, so an upstream edit fails visibly and requires an explicit rebase.

The main workflow pushes one uniquely tagged candidate, tests that exact
registry digest, and only then promotes the same OCI index. Images are
published to `ghcr.io/philmichel/scummvm-web` as `latest`, `YYYY.M.D`,
`YYYY.M.D-r<run>`, and `sha-<commit>` tags with provenance and SBOM
attestations.

## Tests

Python unit tests cover config merging and generated catalogs/indexes:

```bash
python3 -m unittest discover -s tests/unit -v
```

After building `scummvm-web:test`, run the container smoke test with a freely
redistributable Beneath a Steel Sky fixture:

```bash
tests/fetch-fixture.sh
docker compose --file tests/compose.yaml run --rm smoke
docker compose --file tests/compose.yaml down --volumes
```

## License

The container includes GPL-licensed ScummVM and this repository's ScummVM
filesystem overlay is licensed under GPL-3.0-or-later. See `LICENSE`.
