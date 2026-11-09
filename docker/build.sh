#!/usr/bin/env bash
# Runs inside the build container. Usage: build.sh <bundle dir> <tauri build arguments...>
# /src is the project (read-only), /out receives the finished installers.
set -euo pipefail

bundle_dir="$1"
shift

work="${WORK_DIR:-/work}"
mkdir -p "$work"
# Copy the sources, but never the host's node_modules/build output or any private key.
rsync -a --delete \
  --exclude /node_modules --exclude /dist --exclude /release --exclude /.git \
  --exclude /src-tauri/target --exclude '*.key' \
  /src/ "$work/"

cd "$work"
npm ci
node scripts/tauri.mjs build "$@"

rm -rf /out/*
cp -R "$work/${bundle_dir}/." /out/
echo "Done. Installers copied to /out."
