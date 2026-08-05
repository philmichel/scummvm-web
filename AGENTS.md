# Working on scummvm-web

Operational knowledge for agents. `README.md` documents the image for its users —
run flags, mounts, persistence layout, MT-32 ROM names. This file covers how to
*change* the repo without breaking it, and what has already been tried.

## What this is

A container that builds the Emscripten/WebAssembly ScummVM app from pinned
upstream source and serves it with nginx. Games come from a read-only `/games`
mount; `/persist` holds `scummvm.ini`, saves and extras and is exposed to the
browser over same-origin WebDAV. Three upstream repos are pinned in
`versions.env`: `chkuendig/scummvm-demo` (the web app), `chkuendig/scummvm` (the
engine fork), `chkuendig/scummvm-icons`, plus `EMSDK_VERSION`.

Deployed from `~/code/home-ops` (Flux) as `scummvm` in the `games` namespace at
`scummvm.techno.bot`, behind Authentik ext-auth. See *Deploying* below.

## Golden rules

1. **Never edit upstream source in the image build.** Nothing from the three
   upstream repos lives in this tree. Changes go through exactly one of:
   - `patches/*.patch` — applied with `git apply --3way` in the `src` stage.
     Use for small, surgical C++/JS/shell changes.
   - `overlay/` — whole-file replacements, guarded by
     `overlay/checksums.sha256` (SHA-256 of the *original* upstream file). Use
     only when a file is effectively rewritten. Currently one file:
     `backends/fs/emscripten/emscripten-fs-factory.js`.
   - `entrypoint/`, `nginx/`, `scripts/`, `config/` — our own code, edit freely.
2. **Fix things in the image, not in the deployed state.** `/persist/scummvm.ini`
   is rewritten by the browser (last-write-wins). Hand-edits there get clobbered
   by any open tab and are lost on the next re-detect. Put the behaviour in
   `entrypoint/merge_ini.py` and restart the pod instead.
3. **The app must be served at the origin root.** `/data/index.json` is fetched
   origin-absolute; a subpath deployment breaks it.
4. **No COOP/COEP headers.** The build is single-threaded ASYNCIFY, not pthreads.
5. Do not add `Co-Authored-By:` trailers or "Generated with Claude Code" footers
   to commits or PRs — the repo owner is the sole author.

## Repo map

| Path | Role |
| --- | --- |
| `versions.env` | The four pins. Bumping `SCUMMVM_SHA` is the expensive one. |
| `Dockerfile` | 4 stages: `src` → `toolchain` → `build` → `runtime`. |
| `scripts/fetch-sources.sh` | Shallow-fetches the pins, verifies overlay checksums, applies overlay + patches. |
| `scripts/build-site.sh` | configure/make/dist, icons, demo assets, HTTP index regen, post-build asserts. |
| `patches/` | Patches against the pinned `scummvm` tree; `patches/scummvm-demo/` against the web app. |
| `overlay/` | Full-file replacements + `checksums.sha256` drift guard. |
| `entrypoint/90-scummvm-init.sh` | nginx `docker-entrypoint.d` drop-in: detection, merge, catalog, indexes. |
| `entrypoint/merge_ini.py` | Detected targets → `/persist/scummvm.ini`. Has invariants; see below. |
| `entrypoint/gen_games_json.py` | `scummvm.ini` → `games.json` for the overview page. |
| `entrypoint/gen_http_index.py` | Walks `/games` → sidecar `index.json` tree (mount is read-only). |
| `tests/unit/` | Python unit tests for the three entrypoint scripts. |
| `tests/smoke.spec.ts` | Playwright end-to-end against a real container. |

Runtime layout inside the container: site at `/usr/share/scummvm-web/`, python
helpers at `/usr/local/lib/scummvm-web/`, generated catalog/indexes at
`/var/cache/scummvm/`, `/games` ro, `/persist` rw, UID/GID 1000.

## Build economics (what your change costs)

BuildKit stage caching is the difference between a 5-minute and a 45-minute CI
run. The `toolchain` stage (emsdk + ~10 codec libraries) is keyed **only** on
`scummvm/dists/emscripten/`, so it survives most changes.

| Changing… | Rebuilds | Rough CI time |
| --- | --- | --- |
| `entrypoint/`, `nginx/`, `config/`, docs, tests | `runtime` only | ~5 min |
| `patches/`, `overlay/`, `scripts/build-site.sh` | `src` + `build` (full engine recompile) | ~40–50 min |
| `SCUMMVM_SHA` | `src` + `build`, and `toolchain` if `dists/emscripten/` moved | 45 min to cold |

## Local development

**The host is NixOS and has no `python3` or `perl`.** Run the unit tests in a
container:

```bash
cd ~/code/scummvm-web
docker run --rm -v "$PWD":/w:ro -w /w python:3.13-slim python -m unittest discover -s tests/unit
```

Full smoke test (needs a local image build first — slow):

```bash
tests/fetch-fixture.sh
docker compose --file tests/compose.yaml run --rm smoke
docker compose --file tests/compose.yaml down --volumes
```

The fixture deliberately contains **two copies** of Beneath a Steel Sky
(`BASS-Floppy-1.3` and `BASS-Floppy-1.3-second-copy`) to regression-test
duplicate handling. Do not "clean that up".

Authoring patches without python/perl: insert with `sed -i 'Nr file'` working
**bottom-up** so earlier line numbers stay valid, and always verify against the
pinned SHA in a scratch clone before committing:

```bash
git -C /tmp/scratch fetch --depth 1 https://github.com/chkuendig/scummvm.git "$SCUMMVM_SHA"
git -C /tmp/scratch checkout -q FETCH_HEAD
git -C /tmp/scratch apply --check ~/code/scummvm-web/patches/0003-chunk-readahead.patch
```

`git apply --3way` warning "repository lacks the necessary blob" is benign — it
falls back to direct application.

## Existing patches (why they exist)

- **`0001-locatefile-absolute-paths.patch`** — Emscripten's default `locateFile`
  concatenates prefix + path, producing `//data/plugins/libscumm.so`. Envoy
  ext_authz rewrites double-slash paths into a 302 to the auth outpost, so every
  dlopen'd engine plugin 302'd and the app showed a black screen. The patch makes
  origin-absolute paths pass through unchanged. The smoke test asserts no request
  path starts with `//`.
- **`0002-flac-lib-build.patch`** — adds libFLAC 1.4.3 to the third-party build
  and `--enable-flac`. Ultimate Talkie speech bundles (`.sof`) are FLAC; without
  it, games launch silently with no voices. `build-site.sh` asserts `FLAC__`
  symbols are present in the wasm.
- **`0003-chunk-readahead.patch`** + `$VFSPREFETCH` in the overlay — after each
  5 MB chunk is read, the next one is fetched in the background. Fire-and-forget:
  validates `206` + exact length, dedupes in flight, and re-checks for existence
  and open streams before writing, so it can only ever add warm cache. Also
  registers disk-found chunks with the LRU registry so prefetched data stays
  under the cache cap. **This did not fix the freeze** (see below) — it is a
  latency mitigation only.

## Config merging invariants (`merge_ini.py`)

Detection runs `scummvm --add --recursive` into a **fresh temp config**, then
merges. Preserve these properties when touching it:

- **Identity** is `(engineid, gameid, normalized path)`. A detected target whose
  identity already exists is skipped — user edits, including renames, are sacred.
- **Nothing is ever removed.** Section-name collisions get a `-N` suffix.
- **One scan per top-level game directory.** ScummVM's `recAddGames`
  (`base/commandLine.cpp`) skips a game whose preferred target name was already
  claimed *earlier in the same scan*, so a single recursive pass silently drops
  second copies of the same game. `90-scummvm-init.sh` loops directories and
  merges each separately, plus one non-recursive pass over the games root.
- **Duplicate descriptions get labelled.** The launcher and the overview page
  show only `description`, so copies of one game were indistinguishable. Sections
  sharing a description get the distinguishing tail of their directory appended:
  `… (DOS/English) [Midi Music]` / `… [Special Edition CD Tracks]`. Existing text
  is kept as the prefix, labelled entries are left alone (idempotent), and a
  group falls back to full directory names when trimming would leave a label
  without letters. The pass runs on every merge, so configs written before a
  change get repaired on the next boot.

## Deploying

Images publish to `ghcr.io/philmichel/scummvm-web`. CI pushes a uniquely tagged
*candidate*, smoke-tests that exact digest, then promotes the same OCI index to
`latest`, `YYYY.M.D`, `YYYY.M.D-r<run>`, `sha-<commit>`.

Watch a build and get its digest (no `read:packages` scope on the local `gh`
token — read the digest from the registry instead):

```bash
gh run list --workflow=build.yml --limit 5 --json headSha,status,conclusion,number
docker buildx imagetools inspect ghcr.io/philmichel/scummvm-web:2026.7.31-r26 \
  --format '{{json .Manifest}}' | jq -r .digest
```

Then in `~/code/home-ops` (commit straight to `main`, no AI trailers):

```bash
# kubernetes/apps/games/scummvm/app/helmrelease.yaml → tag: <calver>-r<n>@sha256:<digest>
flux reconcile source git flux-system
flux -n games reconcile kustomization scummvm
flux -n games reconcile helmrelease scummvm
kubectl -n games rollout status deploy/scummvm --timeout=10m
```

The app lives at `kubernetes/apps/games/scummvm/` with `ks.yaml` components
`ext-auth` (Authentik SecurityPolicy) and `scaler/instance` (scale-to-zero when
the NAS is down). Storage is NFS from `nas.techno.bot`:
`/mnt/vault/data/emulation/scummvm/{games,persist}`. Renovate auto-merges digest
bumps for `/philmichel/` images.

## Debugging recipes

```bash
# Startup detection and merge decisions
kubectl -n games logs deploy/scummvm | grep -E 'scummvm-init|merge_ini'

# What the browser will list
kubectl -n games exec deploy/scummvm -- grep -h description /persist/scummvm.ini

# Confirm a build actually contains a feature
kubectl -n games exec deploy/scummvm -- sh -c \
  'grep -c VFSPREFETCH /usr/share/scummvm-web/scummvm.js'

# Games added to the NAS are picked up by a restart (detection runs at boot)
kubectl -n games rollout restart deploy/scummvm
```

`scummvm.js` is minified onto one line — never `grep` it without `-o` and a
bounded window (`grep -o '.\{80\}pattern.\{80\}'`), or you dump megabytes.

In-browser rescan without a restart:
`/scummvm.html#--add --path=/data/games --recursive`, then reload.

## Known issues

**Engine freeze on scene transitions (unfixed, upstream).** Opening the SCUMM Bar
door in Monkey Island hard-freezes the app. Ruled out so far: MT-32 vs FluidSynth
vs no synth at all (freezes with every audio device), `audio_buffer_size`, and
the chunk read-ahead patch (verified 2026-07-31 — no change). There is no network
activity at the moment of the freeze, which points at upstream's documented
ASYNCIFY re-entry bug class (audio callback re-entering while the engine is
suspended in an HTTP busy-wait) rather than at fetch latency. The real fix is
upstream's ASYNCIFY-removal/JSPI work; the daily watch workflow will pick it up.
Before spending time here, capture a DevTools console at a freeze and look for
`unreachable`, `RuntimeError`, or `Asyncify` messages — without that, an upstream
issue is not actionable.

**Compressed speech is FLAC, not Vorbis.** `track*.flac` CD audio could be
converted to OGG in place with ffmpeg, but `monkey.sof` cannot — it is a packed
speech bundle. Switching it to Vorbis requires re-running the Ultimate Talkie
builder with OGG output, or a custom `.sof` → `.sog` converter. Not done.

## Conventions

- Commit style: `fix(config): …`, `feat(scummvm): …`. Body explains *why*.
- Changes to `**.md` (this file and the `CLAUDE.md` symlink to it), `LICENSE`,
  and `renovate.json` are excluded from the CI triggers, so documentation edits
  never build or publish an image.
- Every behaviour change to the entrypoint scripts gets a unit test; anything
  user-visible in the browser gets a smoke-test assertion.
