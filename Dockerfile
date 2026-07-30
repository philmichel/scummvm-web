# syntax=docker/dockerfile:1.7

ARG UBUNTU_IMAGE=ubuntu:26.04@sha256:3131b4cc82a783df6c9df078f86e01819a13594b865c2cad47bd1bca2b7063bb
ARG NGINX_IMAGE=nginx:1.29.5@sha256:0236ee02dcbce00b9bd83e0f5fbc51069e7e1161bd59d99885b3ae1734f3392e

FROM ${UBUNTU_IMAGE} AS src
ARG SCUMMVM_DEMO_SHA
ARG SCUMMVM_SHA
ARG SCUMMVM_ICONS_SHA
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/fetch-sources.sh /usr/local/bin/fetch-sources.sh
COPY overlay/ /workspace/overlay/
COPY patches/ /workspace/patches/
RUN SCUMMVM_DEMO_SHA="${SCUMMVM_DEMO_SHA}" \
    SCUMMVM_SHA="${SCUMMVM_SHA}" \
    SCUMMVM_ICONS_SHA="${SCUMMVM_ICONS_SHA}" \
    fetch-sources.sh /src

FROM ${UBUNTU_IMAGE} AS toolchain
ARG EMSDK_VERSION
ENV EMSDK_VERSION=${EMSDK_VERSION}
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        autoconf automake build-essential bzip2 ca-certificates cmake curl git jq \
        libtool make pkg-config python3 tar unzip wget xz-utils zip \
    && rm -rf /var/lib/apt/lists/*
COPY --from=src /src/scummvm/dists/emscripten/ /bootstrap/dists/emscripten/
WORKDIR /bootstrap
RUN ./dists/emscripten/build.sh setup
RUN ./dists/emscripten/build.sh libs \
    --enable-a52 --enable-faad --enable-fluidlite --enable-fribidi \
    --enable-mad --enable-mikmod --enable-mpcdec --enable-mpeg2 \
    --enable-retrowave --enable-theoradec --enable-vpx

FROM toolchain AS build
COPY --from=src /src/ /src/
COPY --from=toolchain /bootstrap/dists/emscripten/ /src/scummvm/dists/emscripten/
COPY scripts/build-site.sh /usr/local/bin/build-site.sh
COPY config/scummvm.ini.default /workspace/scummvm.ini.default
RUN build-site.sh

FROM ${NGINX_IMAGE} AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 scummvm \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/nginx/conf.d/default.conf \
    && groupadd --gid 1000 scummvm-web \
    && useradd --uid 1000 --gid 1000 --home-dir /tmp --no-create-home \
        --shell /usr/sbin/nologin scummvm-web \
    && mkdir -p /games /persist /var/cache/scummvm \
    && chown -R 1000:1000 /games /persist /var/cache/scummvm
COPY --from=build /src/scummvm/build-emscripten/ /usr/share/scummvm-web/
COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY nginx/conf.d/ /etc/nginx/conf.d/
COPY --chmod=755 entrypoint/90-scummvm-init.sh /docker-entrypoint.d/90-scummvm-init.sh
COPY --chmod=755 entrypoint/*.py /usr/local/lib/scummvm-web/
EXPOSE 8080
ENV HOME=/tmp
USER 1000:1000
