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
  --exclude /node_modules --exclude /dist --exclude /release --exclude /builds --exclude /.git \
  --exclude /src-tauri/target --exclude '*.key' \
  /src/ "$work/"

cd "$work"
# The build folder lives in a volume that keeps installers of older versions: start from empty so
# only this build's files are copied out.
rm -rf "$work/${bundle_dir}"
# The container is always Linux (glibc). Say so to npm: it then installs the platform packages of the Tauri CLI, esbuild and
# rollup that match this container's CPU (without it the arm64 build could end with "Cannot find native binding").
arch="$(node -p 'process.arch')"
npm ci --os=linux --cpu="$arch" --libc=glibc
# Safety net: if npm still skipped the Tauri CLI's native package, install that exact version by hand.
if [ ! -d "node_modules/@tauri-apps/cli-linux-${arch}-gnu" ]; then
  cli_version="$(node -p "require('./node_modules/@tauri-apps/cli/package.json').version")"
  npm install --no-save --force --ignore-scripts "@tauri-apps/cli-linux-${arch}-gnu@${cli_version}"
fi
# This script copies the installers out itself, so the build must leave them where they are.
APP_KEEP_BUNDLE=1 node scripts/run-tauri.mjs build "$@"

rm -rf /out/*
cp -R "$work/${bundle_dir}/." /out/
echo "Done. Installers copied to /out."
