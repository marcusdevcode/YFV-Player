#!/bin/sh
# Cargo "runner" for `npm run dev` on macOS (set up by scripts/run-tauri.mjs).
# macOS labels a running program in the Dock with the file name it was started from, and Cargo
# cannot name a program "YFV Player" (no spaces). So the program is started through a link whose
# name is the product name from package.json (APP_DEV_NAME). Built apps do not need this: their
# Dock name comes from the .app bundle.
bin="$1"
shift
name="${APP_DEV_NAME:-}"
if [ -n "$name" ]; then
  link="$(dirname "$bin")/$name"
  ln -f "$bin" "$link" 2>/dev/null || cp -f "$bin" "$link"
  exec "$link" "$@"
fi
exec "$bin" "$@"
