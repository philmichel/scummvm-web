#!/usr/bin/env bash
set -euo pipefail

root=/src
scummvm=$root/scummvm
demo=$root/scummvm-demo
icons=$root/scummvm-icons
output=$scummvm/build-emscripten

configure_flags=(
    --enable-release
    --enable-plugins
    --enable-all-engines
    --default-dynamic
    --enable-a52
    --enable-faad
    --enable-fluidlite
    --enable-freetype2
    --enable-fribidi
    --enable-gif
    --enable-jpeg
    --enable-mad
    --enable-mikmod
    --enable-mpcdec
    --enable-mpeg2
    --enable-ogg
    --enable-png
    --enable-retrowave
    --enable-theoradec
    --enable-vorbis
    --enable-vpx
    --enable-zlib
)

cd "$scummvm"
./dists/emscripten/build.sh configure "${configure_flags[@]}"
./dists/emscripten/build.sh make
./dists/emscripten/build.sh dist

sed -i 's|scummvm/scummvm-icons|chkuendig/scummvm-icons|g' "$icons/gen-set.py"
mkdir -p "$output/data/gui-icons"
cp -R "$icons/default/icons" "$output/data/gui-icons/"

generated=0
for attempt in 1 2 3; do
    if (cd "$icons" && python3 gen-set.py); then
        generated=1
        break
    fi
    echo "Icon metadata generation failed (attempt $attempt/3)" >&2
    sleep $((attempt * 5))
done
if [[ $generated -ne 1 ]]; then
    echo "Icon metadata generation failed after three attempts" >&2
    exit 1
fi

cp -R "$icons/icons/." "$output/data/gui-icons/icons/"
cp "$icons"/*.xml "$output/data/gui-icons/"
rm -f "$output/data/gui-icons.dat"
python3 "$scummvm/dists/emscripten/build-make_http_index.py" "$output/data"

assets=(
    games.css games.html games.js main.css heroes0.png heroes1.png heroes2.png
    heroes3.png heroes4.png heroes5.png heroes6.png maniac-half.png scummvm.png
    scummvm_logo.png
)
for asset in "${assets[@]}"; do
    cp "$demo/assets/$asset" "$output/"
done
cp "$output/scummvm.html" "$output/index.html"
cp /workspace/scummvm.ini.default "$output/scummvm.ini.default"

jq -e '.games == {} and ([.. | objects | .baseUrl? // empty] | length == 0)' \
    "$output/data/index.json" >/dev/null
