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
# The build folder lives in a volume that keeps installers of older versions: start from empty so
# only this build's files are copied out.
rm -rf "$work/${bundle_dir}"
npm ci
node scripts/run-tauri.mjs build "$@"

rm -rf /out/*
cp -R "$work/${bundle_dir}/." /out/
echo "Done. Installers copied to /out."
