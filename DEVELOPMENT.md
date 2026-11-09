# Development guide

For people who want to run, change, build or fork the app. For what the app does and what is built so far, see [README.md](README.md).

## What you need

- **Node.js** 22 or newer (CI uses 22) and npm.
- **Rust** (stable) from https://rustup.rs.
- Platform tools for Tauri v2:
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`).
  - **Windows:** Microsoft C++ Build Tools and the WebView2 runtime.
  - **Linux (Debian/Ubuntu):** `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev`, plus the GStreamer plugins (`gstreamer1.0-libav`, `gstreamer1.0-plugins-good`, `gstreamer1.0-plugins-bad`) so videos play.

## Run and check

```sh
npm ci               # install dependencies
npm start            # run the desktop app in development (same as `npm run dev:app`)
npm run typecheck    # TypeScript check
cd src-tauri && cargo test    # Rust tests
```

`npm run dev` starts only the web page in a browser, without the desktop features (file dialogs, the media server, updates).

Rule for the UI code: **no timers** (`setInterval`, `setTimeout`, `requestAnimationFrame`). Drive things from media events such as `timeupdate` and from input events instead.

Handy for testing: a file path given on launch plays right away, and a second path is used as the separate audio track, e.g. `APP_OPEN=/path/video.mp4 APP_OPEN_AUDIO=/path/audio.m4a npm start`.

## Building and releasing (manual, on this computer)

Releases are built here, not on GitHub. macOS builds natively; Linux and Windows build inside Docker.

One-time setup:
- Signing keys in `keys/` (see the next section).
- `rustup target add x86_64-apple-darwin` (for the Intel Mac build).
- **Docker** (for Linux and Windows). Either Docker Desktop, or, without it, on a Mac:
  ```sh
  brew install colima docker docker-buildx
  mkdir -p ~/.docker/cli-plugins && ln -sfn /opt/homebrew/opt/docker-buildx/bin/docker-buildx ~/.docker/cli-plugins/docker-buildx
  colima start --vm-type vz --vz-rosetta --cpu 6 --memory 10 --disk 80
  ```
  The scripts need `docker buildx`. Without Docker Desktop, `~/.docker/config.json` often still says `"credsStore": "desktop"`, which breaks image pulls (`docker-credential-desktop` not found). `scripts/docker-build.mjs` detects that and uses a temporary copy of the config for its own docker calls, so you do not need to edit anything. Plain `docker` commands you run yourself still fail until you remove that line.

```sh
npm run build:app          # test build for this computer
npm run build:mac-arm64    # Apple Silicon
npm run build:mac-x64      # Intel Mac
npm run build:mac          # both Macs
npm run docker:linux-x64   # Linux x64   (AppImage, deb, rpm)
npm run docker:linux-arm64 # Linux ARM64
npm run docker:win-x64     # Windows x64   (NSIS installer)
npm run docker:win-arm64   # Windows ARM64
npm run docker:linux       # both Linux builds
npm run docker:win         # both Windows builds
npm run docker:all         # all four Docker builds
npm run release:collect    # gather everything into release/v<version>/ + latest.json
npm run release:build    # build:mac + docker:all + release:collect
npm run release:publish  # publish release/v<version>/ to GitHub (scripts/release-version.js)
npm run release          # release:build, then release:publish: build everything and publish
```

What the Docker images do:
- `docker/linux.Dockerfile` (Ubuntu 22.04): builds the AppImage, deb and rpm. On x64 under Rosetta the AppImage plugin cannot start (static binary, "Exec format error"), so the image unpacks it and runs it from the unpacked files.
- `docker/windows.Dockerfile` (Ubuntu 24.04): cross-compiles with `cargo-xwin` and builds the NSIS installer for x64 and arm64. Ubuntu 22.04's NSIS is too old for Tauri's installer. A small `clang` wrapper translates the `/imsvc` flags that `cargo-xwin` passes.
- The Windows build runs in `/qbuild`, not `/work`: `clang-cl` and NSIS read a path starting with `/work` or `/x` as one of their own options and fail.
- The signing key reaches the container through the environment and is never copied into the image (`docker/build.sh` skips `*.key`).

The first Docker run is slow (it downloads the toolchains and builds the Rust dependencies); later runs reuse Docker volumes as a cache. Linux x64 on an Apple Silicon Mac runs emulated and is slower. The Docker builds are cross-compiled and have not been run on a real Windows or Linux machine, so test the installers.

Extra arguments go to `tauri build`: `npm run build:app -- --bundles app` builds just the app without an installer (useful on macOS, where the `.dmg` step sometimes fails with "resource busy").

`npm start`, `npm run tauri` and every `build:*` script go through `scripts/tauri.mjs`. It takes the product name, bundle identifier, version, window title and updater endpoint from `package.json` (the only place they are defined) and finds the signing key for you. Do not run `tauri` or `cargo tauri` directly, or that information is missing.

### Release steps

1. Change `version` in `package.json` (the only place; `scripts/tauri.mjs` syncs `src-tauri/Cargo.toml`).
2. `npm run release` builds everything, then publishes it. To only build, use `npm run release:build`; to publish what is already built, `npm run release:publish`.
3. Check `release/v<version>/`: installers named `<name>_<version>_<os>-<cpu>.<ext>` and `latest.json` (the updater file, with signatures).
4. `release:publish` (`scripts/release-version.js`) reads name, version and repository from `package.json`, checks that all six platforms are in `release/v<version>/`, that `gh` is installed and logged in, and that the release does not exist yet, asks you to confirm, then runs `gh release create`. Options: `--yes` (no question), `--draft`, `--dry-run` (print the command only), `--allow-partial`. It runs as the GitHub account logged in with `gh auth login` on this machine.
5. Commit and push your code yourself first (`git add . && git commit && git push`): `gh release create` makes the tag from the pushed code. The repository must be public for the updater to read the release.

A release with a platform missing makes `latest.json` list only the built platforms, and users of the others get no update, so build everything before publishing.

## Update-signing keys (read this if you copy the repo)

The app updates itself from GitHub Releases. To be sure an update really comes from you, every release is **signed with a private key**, and the app contains the matching **public key** and refuses updates that don't match.

| File | What it is | In git? |
|---|---|---|
| `keys/private.key` | Your **private** key. Secret. | **No**, ignored by `*.key` in `.gitignore` |
| `keys/private.key.example` | A placeholder that shows where the key goes. | Yes |
| `keys/public.pub` | The **public** key (safe to share). Read automatically by `scripts/tauri.mjs`. | **Yes**, commit it |

**The repository does not contain a working private key.** If you copy or fork this project you must make your own, otherwise your builds can't be signed the way the app expects:

1. **Generate a key pair** (add `--ci` to skip the password prompt, or enter a password and see below):
   ```sh
   npm run tauri -- signer generate -w keys/private.key
   ```
   The tool writes `keys/private.key` (private) and `keys/private.key.pub`. Rename the second file to `keys/public.pub`.
2. **The public key needs no pasting.** `keys/public.pub` is picked up automatically for every run and build.
3. **Point updates at your repository.** Set `repository.url` (and `author.name`, which forms the bundle identifier) in `package.json`. The update address is derived from it.
4. **Keep the private key on this computer only.** Builds read `keys/private.key` and pass it to Docker through the environment. It is never uploaded anywhere and no GitHub secret is needed. If you gave it a password, set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when building.

**Local builds** pick the key up automatically from `keys/private.key` (another location: `APP_SIGNING_KEY=/path/to/key`; a key with a password: set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). If there is **no key at all**, the build still works but produces no update files, and prints a message saying so. That is fine for trying things out.

**Keep the private key safe.**
- Never commit it, paste it into chats or issues, or put it in a screenshot. If it leaks, replace it (steps 1-4) **before** you publish your first release; after that, replacing it would stop already installed apps from updating.
- Back it up somewhere safe. If you lose it, installed apps can never be updated again.
- `.gitignore` blocks `*.key`, `*.pem`, `*.p12` and `.env*` files, and allows only `*.example` templates. Check `git status` before committing.

## macOS: "is damaged and can't be opened"

Without an Apple Developer ID the app cannot be properly signed or notarized. `scripts/tauri.mjs` signs the whole `.app` ad-hoc (`-`), which fixes the false "damaged" message, but macOS still warns that the developer is unverified on first launch: right-click the app, choose **Open**, then **Open** again (or run `xattr -cr "/Applications/<name>.app"`). To remove the warning for everyone you need a paid Apple Developer ID: set `APPLE_SIGNING_IDENTITY` plus the notarization variables (`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`) before building and the script uses them instead.

## Not covered by these keys

macOS and Windows code signing (so the OS doesn't warn on first launch) needs separate certificates from Apple and Microsoft. Without them, builds are unsigned and the OS shows a security warning. The keys above only protect updates.

## Troubleshooting

- **`.dmg` fails on macOS ("resource busy", or Finder "Can't set statusbar visible"):** the DMG tool styles its window through Finder. `scripts/tauri.mjs` sets `CI=true` for macOS builds so Tauri skips that step (the DMG then has the default window layout). If it still fails, build only the app: `npm run build:app -- --bundles app`.
- **"Open with" doesn't show the app:** it only works in an installed build, not in `npm start`.
- **A video won't play (error 4):** the file's codec isn't supported by the system's web view (typically VP9/AV1 or MKV/AVI). H.264/AAC MP4 works everywhere.
- **Don't commit large media files.** Keep test videos outside the repository.
