# Build environment for the Linux releases (AppImage, deb, rpm).
# Built twice by scripts/docker-build.mjs: for linux/amd64 and linux/arm64.
FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget file git build-essential pkg-config rsync xz-utils \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
      libssl-dev patchelf xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Rust (stable)
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal

# AppImage tools cannot use FUSE inside a container: unpack and run them instead.
ENV APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=true

# On x64 under Rosetta (Apple Silicon hosts) the AppImage plugin's own launcher cannot start
# (static-pie binary, "Exec format error"). Unpack it and put a script where Tauri expects the
# AppImage, so Tauri skips its download and the plugin runs from the unpacked files.
RUN <<'SCRIPT'
set -e
if [ "$(uname -m)" = "x86_64" ]; then
  apt-get update
  apt-get install -y --no-install-recommends squashfs-tools python3
  rm -rf /var/lib/apt/lists/*
  wget -q https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage -O /tmp/plugin.AppImage
  offset=$(python3 -c "import struct;d=open('/tmp/plugin.AppImage','rb').read(64);s=struct.unpack_from('<Q',d,0x28)[0];e,n=struct.unpack_from('<HH',d,0x3A);print(s+e*n)")
  unsquashfs -q -o "$offset" -d /opt/linuxdeploy-plugin-appimage /tmp/plugin.AppImage
  rm /tmp/plugin.AppImage
  mkdir -p /root/.cache/tauri
  printf '#!/bin/sh\nexec /opt/linuxdeploy-plugin-appimage/AppRun "$@"\n' > /root/.cache/tauri/linuxdeploy-plugin-appimage.AppImage
  chmod +x /root/.cache/tauri/linuxdeploy-plugin-appimage.AppImage
fi
SCRIPT

COPY build.sh /usr/local/bin/build.sh
RUN chmod +x /usr/local/bin/build.sh
WORKDIR /work
