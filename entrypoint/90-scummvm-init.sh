#!/bin/sh

# This script is run as a drop-in by the official nginx entrypoint.

log() {
    printf '%s\n' "[scummvm-init] $*"
}

SCRIPT_DIR=/usr/local/lib/scummvm-web
PERSIST_DIR=/persist
TARGET_INI=$PERSIST_DIR/scummvm.ini
DEFAULT_INI=/usr/share/scummvm-web/scummvm.ini.default
CACHE_DIR=/var/cache/scummvm
GAMES_DIR=/games
SCUMMVM_BIN=${SCUMMVM_BIN:-/usr/games/scummvm}

persist_writable=0
probe=
if [ -d "$PERSIST_DIR" ]; then
    persist_symlink=
    if ! persist_symlink=$(find "$PERSIST_DIR" -type l -print -quit 2>/dev/null); then
        log "ERROR: $PERSIST_DIR could not be checked for symbolic links; refusing to start"
        exit 1
    elif [ -n "$persist_symlink" ]; then
        log "ERROR: $PERSIST_DIR must not contain symbolic links; refusing to start"
        exit 1
    fi

    probe=$(mktemp "$PERSIST_DIR/.scummvm-write-test.XXXXXX" 2>/dev/null) || probe=
    if [ -n "$probe" ]; then
        persist_writable=1
        rm -f -- "$probe"
    else
        log "ERROR: $PERSIST_DIR is not writable; existing configuration will be served unchanged"
    fi
else
    log "ERROR: $PERSIST_DIR does not exist; persistence initialization is disabled"
fi

if [ ! -d "$GAMES_DIR" ]; then
    log "WARNING: $GAMES_DIR does not exist; the generated game indexes will be empty"
else
    game_symlink=
    if ! game_symlink=$(find "$GAMES_DIR" -type l -print -quit 2>/dev/null); then
        log "WARNING: $GAMES_DIR could not be checked for symbolic links"
    elif [ -n "$game_symlink" ]; then
        log "WARNING: symbolic links under $GAMES_DIR are unsupported and will not be served"
    fi
fi

if [ "$persist_writable" -eq 1 ]; then
    if ! mkdir -p -- "$PERSIST_DIR/saves" "$PERSIST_DIR/extras" "$PERSIST_DIR/.upload-tmp"; then
        log "ERROR: could not create one or more persistence directories"
    fi

    if [ ! -f "$TARGET_INI" ]; then
        seed_tmp=$(mktemp "$PERSIST_DIR/.scummvm.ini.XXXXXX" 2>/dev/null) || seed_tmp=
        if [ -n "$seed_tmp" ] && cp -- "$DEFAULT_INI" "$seed_tmp" \
            && chmod 0644 "$seed_tmp" && mv -- "$seed_tmp" "$TARGET_INI"; then
            log "Seeded $TARGET_INI from the image default"
        else
            [ -z "$seed_tmp" ] || rm -f -- "$seed_tmp"
            log "ERROR: could not seed $TARGET_INI from $DEFAULT_INI"
        fi
    fi
fi

detection_tmp=
# shellcheck disable=SC2329 # Invoked indirectly by trap.
cleanup() {
    [ -z "$detection_tmp" ] || rm -rf -- "$detection_tmp"
}
trap cleanup EXIT HUP INT TERM

if [ "${SCUMMVM_SKIP_DETECTION:-0}" = "1" ]; then
    log "Skipping game detection because SCUMMVM_SKIP_DETECTION=1"
elif [ "$persist_writable" -ne 1 ]; then
    log "Skipping game detection because $PERSIST_DIR is not writable"
elif [ ! -d "$GAMES_DIR" ]; then
    log "Skipping game detection because $GAMES_DIR is unavailable"
elif [ ! -x "$SCUMMVM_BIN" ]; then
    log "ERROR: game detection binary $SCUMMVM_BIN is unavailable; keeping existing configuration"
else
    detection_tmp=$(mktemp -d "${TMPDIR:-/tmp}/scummvm-detect.XXXXXX" 2>/dev/null) || detection_tmp=
    if [ -z "$detection_tmp" ]; then
        log "ERROR: could not create a temporary directory; keeping existing configuration"
    else
        detect_timeout=${DETECT_TIMEOUT:-600}
        log "Detecting games in $GAMES_DIR (timeout: $detect_timeout)"
        if HOME="$detection_tmp" SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
            timeout -- "$detect_timeout" "$SCUMMVM_BIN" \
                --config="$detection_tmp/detected.ini" --add --recursive --path="$GAMES_DIR"; then
            if [ -f "$detection_tmp/detected.ini" ]; then
                if python3 "$SCRIPT_DIR/merge_ini.py" \
                    --detected "$detection_tmp/detected.ini" \
                    --target "$TARGET_INI" \
                    --map "$GAMES_DIR=/data/games"; then
                    log "Game detection completed and configuration was merged"
                else
                    log "ERROR: detected games could not be merged; existing configuration is unchanged"
                fi
            else
                log "Game detection completed without producing a config; existing configuration is unchanged"
            fi
        else
            status=$?
            log "WARNING: game detection failed with status $status; existing configuration is unchanged"
        fi
    fi
fi

if ! mkdir -p -- "$CACHE_DIR"; then
    log "ERROR: could not create runtime cache directory $CACHE_DIR"
fi

catalog_ini=$TARGET_INI
if [ ! -r "$catalog_ini" ]; then
    catalog_ini=$DEFAULT_INI
    log "Using the image default config to generate games.json"
fi

if python3 "$SCRIPT_DIR/gen_games_json.py" \
    --ini "$catalog_ini" --root /data/games --out "$CACHE_DIR/games.json"; then
    log "Generated $CACHE_DIR/games.json"
else
    log "ERROR: failed to generate $CACHE_DIR/games.json"
fi

if python3 "$SCRIPT_DIR/gen_http_index.py" "$GAMES_DIR" "$CACHE_DIR/games-index"; then
    log "Generated HTTP sidecar indexes under $CACHE_DIR/games-index"
else
    log "ERROR: failed to generate HTTP sidecar indexes"
fi

exit 0
