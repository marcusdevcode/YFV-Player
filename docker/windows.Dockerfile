# Build environment for the Windows releases (NSIS installer), cross-compiled from Linux
# with cargo-xwin for both x64 and arm64.
# Ubuntu 24.04: its NSIS is new enough for the Tauri installer template (22.04 lacks Win\RestartManager.nsh).
FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget file git build-essential pkg-config rsync xz-utils unzip \
      nsis lld llvm clang libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# cargo-xwin looks for clang-cl (clang acts as clang-cl when invoked under that name).
RUN ln -sf "$(readlink -f /usr/bin/clang)" /usr/local/bin/clang-cl

# Rust (stable) with both Windows targets, plus the cross-compiler wrapper
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal \
    && rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc \
    && cargo install --locked cargo-xwin

# cargo-xwin downloads the Windows SDK on first use; keep it in a volume (see docker-build.mjs).
ENV XWIN_CACHE_DIR=/xwin-cache XWIN_ACCEPT_LICENSE=1

# Some crates (ring, on arm64) assemble .S files with plain `clang`, which does not understand the
# clang-cl style "/imsvc <dir>" include flags that cargo-xwin sets. Translate them to -isystem.
RUN printf '%s\n' '#!/bin/bash' 'args=()' \
      'while [ $# -gt 0 ]; do' \
      '  if [ "$1" = "/imsvc" ]; then args+=(-isystem "$2"); shift 2; else args+=("$1"); shift; fi' \
      'done' 'exec /usr/bin/clang "${args[@]}"' > /usr/local/bin/clang \
    && chmod +x /usr/local/bin/clang

COPY build.sh /usr/local/bin/build.sh
RUN chmod +x /usr/local/bin/build.sh
WORKDIR /work
