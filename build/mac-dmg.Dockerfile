# Toolchain for building the macOS DMG on Linux (scripts/build-mac-dmg.mjs).
#   - mkfs.hfsplus (hfsprogs)       creates the empty HFS+ volume
#   - hfsplus / dmg (libdmg-hfsplus) fill the volume without mounting it and
#                                   compress it to a UDIF .dmg — Mozilla's fork,
#                                   the same tools Firefox's Mac DMGs are built with
#   - rcodesign (apple-codesign)    ad-hoc signs the .app; Apple Silicon refuses
#                                   to run arm64 code without a valid signature
FROM ubuntu:24.04

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      hfsprogs cmake make gcc g++ git ca-certificates curl \
      zlib1g-dev libbz2-dev liblzma-dev libssl-dev \
 && rm -rf /var/lib/apt/lists/*

ARG LIBDMG_COMMIT=ec239599c1f234a4e01ae3fe51214d0c77e5baa3
RUN git clone https://github.com/mozilla/libdmg-hfsplus /src/libdmg \
 && git -C /src/libdmg checkout "$LIBDMG_COMMIT" \
 && cmake -S /src/libdmg -B /src/libdmg/build -DCMAKE_BUILD_TYPE=Release \
 && make -C /src/libdmg/build -j"$(nproc)" \
 && install -m 755 /src/libdmg/build/dmg/dmg /src/libdmg/build/hfs/hfsplus /usr/local/bin/ \
 && rm -rf /src/libdmg

ARG RCODESIGN_VERSION=0.29.0
ARG RCODESIGN_SHA256=dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002
RUN curl -fsSL -o /tmp/rcodesign.tgz \
      "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F${RCODESIGN_VERSION}/apple-codesign-${RCODESIGN_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
 && echo "${RCODESIGN_SHA256}  /tmp/rcodesign.tgz" | sha256sum -c - \
 && tar -xzf /tmp/rcodesign.tgz -C /tmp \
 && install -m 755 /tmp/apple-codesign-*/rcodesign /usr/local/bin/ \
 && rm -rf /tmp/rcodesign.tgz /tmp/apple-codesign-*
